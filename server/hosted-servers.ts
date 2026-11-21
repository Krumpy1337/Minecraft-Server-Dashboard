import { createHash, timingSafeEqual } from "crypto";
import { Router, RequestHandler } from "express";
import { Client, ConnectConfig } from "ssh2";

export interface HostedServer {
  id: string;
  owner_discord_id: string;
  name: string;
  software: string;
  version: string;
  address: string;
  vmid: number;
  vcpus: number;
  ram_mb: number;
  disk_gb: number;
  ssh_host: string;
  ssh_host_fingerprint: string;
  encrypted_ssh_key: string;
  deletion_status?: "queued" | "running" | "completed" | "failed" | null;
}

export type ConsoleOperation = "status" | "logs" | "command" | "start" | "stop" | "restart" | "metrics" | "settings-get" | "settings-set";

interface Database {
  query(text: string, values: unknown[]): Promise<{ rows: HostedServer[] }>;
}

interface Options {
  database: Database;
  requireAuthenticated: RequestHandler;
  adminIds: Set<string>;
  allowedHosts: Set<string>;
  credentialsConfigured: boolean;
  decryptPrivateKey(value: string): string;
  execute?: typeof executeConsole;
  management?: Router;
}

export function sshOptions(host: string, fingerprint: string, privateKey: string, username: string, port = 22): ConnectConfig {
  return {
    host, port, username, privateKey, readyTimeout: 8000,
    hostVerifier: (key: Buffer) => {
      const actual = createHash("sha256").update(key).digest();
      const expected = Buffer.from(fingerprint.replace(/^SHA256:/, ""), "base64");
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    },
  };
}

export function executeConsole(
  server: HostedServer,
  privateKey: string,
  operation: ConsoleOperation,
  command?: string,
): Promise<string> {
  return executeRestrictedSsh(sshOptions(server.ssh_host, server.ssh_host_fingerprint, privateKey, "mcconsole"), operation, command);
}

export function executeRestrictedSsh(config: ConnectConfig, operation: string, command?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let settled = false;
    const finish = (error?: Error, output = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.end();
      if (error) reject(error);
      else resolve(output);
    };
    const timer = setTimeout(() => finish(new Error("Server console connection timed out.")), operation === "restart" || operation === "stop" ? 140000 : 15000);
    client.on("error", (error: Error) => finish(error));
    client.on("ready", () => {
      client.exec(operation, (error, stream) => {
        if (error) return finish(error);
        const chunks: Buffer[] = [];
        let bytes = 0;
        stream.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 128 * 1024) return finish(new Error("Server console response exceeded its limit."));
          chunks.push(chunk);
        });
        stream.stderr.on("data", () => {
          // Remote diagnostics stay on the guest; do not expose credentials or shell details.
        });
        stream.on("error", (streamError: Error) => finish(streamError));
        stream.on("close", (code: number | null) => {
          if (code !== 0) return finish(new Error("The server rejected the console operation."));
          finish(undefined, Buffer.concat(chunks).toString("utf8"));
        });
        stream.end(command === undefined ? undefined : `${command}\n`);
      });
    });
    client.on("close", () => {
      if (!settled) finish(new Error("Server console connection closed unexpectedly."));
    });
    try {
      client.connect(config);
    } catch (error) {
      finish(error instanceof Error ? error : new Error("Could not initialize the server console connection."));
    }
  });
}

function publicServer(server: HostedServer) {
  return {
    id: server.id,
    name: server.name,
    software: server.software,
    version: server.version,
    address: server.address,
    vmid: server.vmid,
    vcpus: server.vcpus,
    ramMb: server.ram_mb,
    diskGb: server.disk_gb,
    deletionStatus: server.deletion_status ?? null,
  };
}

export function createHostedServersRouter(options: Options): Router {
  const router = Router();
  const execute = options.execute ?? executeConsole;
  const limits = new Map<string, { count: number; reset: number }>();
  router.use(options.requireAuthenticated);
  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  router.get("/", async (req, res, next) => {
    try {
      const result = await options.database.query(
        `SELECT hosted_servers.*,
          (SELECT status FROM server_deletions d WHERE d.server_id=hosted_servers.id) AS deletion_status
         FROM hosted_servers WHERE owner_discord_id = $1 OR $2 ORDER BY created_at DESC`,
        [req.user!.id, options.adminIds.has(req.user!.id)],
      );
      res.json(result.rows.map(publicServer));
    } catch (error) { next(error); }
  });
  router.use("/:id", async (req, res, next) => {
    try {
      const result = await options.database.query(`SELECT hosted_servers.*,
        (SELECT status FROM server_deletions d WHERE d.server_id=hosted_servers.id) AS deletion_status
        FROM hosted_servers WHERE id = $1`, [req.params.id]);
      const server = result.rows[0];
      if (!server || (server.owner_discord_id !== req.user!.id && !options.adminIds.has(req.user!.id))) {
        res.status(404).json({ error: "Hosted server not found." });
        return;
      }
      if (server.deletion_status) {
        res.status(409).json({ error: "This server is being permanently deleted. Failed deletions can be retried from Your servers." });
        return;
      }
      if (!options.credentialsConfigured || !options.allowedHosts.has(server.ssh_host)) {
        res.status(503).json({ error: "Console access is not configured for this server." });
        return;
      }
      res.locals.hostedServer = server;
      next();
    } catch (error) { next(error); }
  });
  const mutationGuard: RequestHandler = (req, res, next) => {
    if (!req.is("application/json") || req.get("X-Blockhost-Request") !== "console") {
      res.status(403).json({ error: "A same-origin console request is required." });
      return;
    }
    const origin = req.get("Origin");
    if (origin && origin !== `${req.protocol}://${req.get("host")}`) {
      res.status(403).json({ error: "Cross-origin console requests are not allowed." });
      return;
    }
    const now = Date.now();
    for (const [key, limit] of limits) if (limit.reset <= now) limits.delete(key);
    const key = `${req.user!.id}:${req.params.id}`;
    const limit = limits.get(key) ?? { count: 0, reset: now + 10000 };
    if (limit.count >= 10) {
      res.setHeader("Retry-After", String(Math.ceil((limit.reset - now) / 1000)));
      res.status(429).json({ error: "Too many console operations. Wait a few seconds." });
      return;
    }
    limit.count++;
    limits.set(key, limit);
    next();
  };
  router.get("/:id/console", async (_req, res) => {
    const server: HostedServer = res.locals.hostedServer;
    try {
      const output = await execute(server, options.decryptPrivateKey(server.encrypted_ssh_key), "logs");
      const newline = output.indexOf("\n");
      const state = output.slice(0, newline);
      if (newline < 0 || !/^(active|inactive|failed|activating|deactivating)$/.test(state)) {
        throw new Error("Invalid server console status response.");
      }
      res.json({ state, output: output.slice(newline + 1) });
    } catch (error) {
      console.error("Hosted console read failed:", server.id, error instanceof Error ? error.message : "Unknown error");
      res.status(502).json({ error: "Could not read the server console. Check its SSH connection and service." });
    }
  });
  router.post("/:id/commands", mutationGuard, async (req, res) => {
    const value: unknown = req.body?.command;
    if (typeof value !== "string" || !value.trim() || value.length > 512 || /[\x00-\x1f\x7f]/.test(value)) {
      res.status(400).json({ error: "Enter one Minecraft command of 1-512 characters, without control characters." });
      return;
    }
    const command = value.trim().replace(/^\//, "");
    if (!command) {
      res.status(400).json({ error: "Enter a Minecraft command after the slash." });
      return;
    }
    const server: HostedServer = res.locals.hostedServer;
    try {
      await execute(server, options.decryptPrivateKey(server.encrypted_ssh_key), "command", command);
      console.info("Hosted console command sent:", { serverId: server.id, actorId: req.user!.id });
      res.status(202).json({ accepted: true });
    } catch (error) {
      console.error("Hosted console command failed:", server.id, error instanceof Error ? error.message : "Unknown error");
      res.status(502).json({ error: "The command was not delivered. Check that the server is running." });
    }
  });
  router.post("/:id/power", mutationGuard, async (req, res) => {
    const action: unknown = req.body?.action;
    if (action !== "start" && action !== "stop" && action !== "restart") {
      res.status(400).json({ error: "Choose start, stop, or restart." });
      return;
    }
    const server: HostedServer = res.locals.hostedServer;
    try {
      await execute(server, options.decryptPrivateKey(server.encrypted_ssh_key), action);
      console.info("Hosted server power operation:", { serverId: server.id, actorId: req.user!.id, action });
      res.json({ accepted: true });
    } catch (error) {
      console.error("Hosted power operation failed:", server.id, error instanceof Error ? error.message : "Unknown error");
      res.status(502).json({ error: "Could not complete the server power operation." });
    }
  });
  if (options.management) router.use("/:id", options.management);
  return router;
}
