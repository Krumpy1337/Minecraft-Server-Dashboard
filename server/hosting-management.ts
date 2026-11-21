import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Request, RequestHandler, Router } from "express";
import { Pool, PoolClient } from "pg";
import { Client, FileEntryWithStats, SFTPWrapper, Stats, utils } from "ssh2";
import { executeConsole, executeRestrictedSsh, HostedServer, sshOptions } from "./hosted-servers";
import { minecraftStatus } from "./minecraft-status";

type JsonObject = Record<string, unknown>;
function object(value: unknown): value is JsonObject { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const uploadLimit = 90 * 1024 * 1024;
const editLimit = 256 * 1024;
export function uploadCounter(editing: boolean): Transform {
  const limit = editing ? editLimit : uploadLimit;
  let bytes = 0;
  return new Transform({ transform(chunk: Buffer, _encoding, callback) {
    bytes += chunk.length;
    callback(bytes > limit ? new HttpError(413, "Upload exceeded its size limit.") : null, chunk);
  } });
}
export function filePath(value: unknown): string {
  if (value === undefined || value === "" || value === "/") return "/";
  if (typeof value !== "string" || value.length > 1024 || /[\\\x00-\x1f\x7f]/.test(value) ||
      value.split("/").some((part) => part === "." || part === "..")) throw new HttpError(400, "Invalid server file path.");
  return "/" + value.split("/").filter(Boolean).join("/");
}
export function clientIp(req: Request): string {
  let ip = req.socket.remoteAddress;
  if (process.env.SFTP_TRUST_CLOUDFLARE === "true") {
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress || "")) throw new HttpError(403, "Use the configured website tunnel.");
    ip = req.get("CF-Connecting-IP");
  }
  if (!ip || ip.includes("%")) throw new HttpError(403, "Could not verify the website connection's IP address.");
  if (ip.startsWith("::ffff:") && isIP(ip.slice(7)) === 4) ip = ip.slice(7);
  if (!isIP(ip)) throw new HttpError(403, "Could not verify the website connection's IP address.");
  return isIP(ip) === 6 ? new URL(`http://[${ip}]/`).hostname.slice(1, -1) : ip;
}
export function publicKeys(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 5) throw new HttpError(400, "Supply up to five Ed25519 public keys.");
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || item.length > 512 || /[\x00-\x1f\x7f]/.test(item.trim()) || !/^ssh-ed25519 [A-Za-z0-9+/=]+(?: [^\r\n]*)?$/.test(item.trim())) throw new HttpError(400, "Use Ed25519 public keys, one per line. Never submit private keys.");
    const key = item.trim();
    const parsed = utils.parseKey(key);
    if (parsed instanceof Error || Array.isArray(parsed) || parsed.type !== "ssh-ed25519") throw new HttpError(400, "An SSH public key is invalid.");
    const identity = parsed.getPublicSSH().toString("base64");
    if (seen.has(identity)) throw new HttpError(400, "Duplicate SSH public key.");
    seen.add(identity);
    keys.push(key);
  }
  return keys;
}
function call<T>(invoke: (callback: (error: Error | undefined, result: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => invoke((error, result) => error ? reject(error) : resolve(result)));
}
function action(invoke: (callback: (error?: Error | null) => void) => void): Promise<void> {
  return new Promise((resolve, reject) => invoke((error) => error ? reject(error) : resolve()));
}
export async function readDirectoryChunk(sftp: Pick<SFTPWrapper, "readdir">, handle: Buffer): Promise<FileEntryWithStats[] | false> {
  try { return await call<FileEntryWithStats[]>((callback) => sftp.readdir(handle, callback)); }
  catch (error) {
    if (object(error) && error.code === 1) return false;
    throw error;
  }
}
async function exists(sftp: SFTPWrapper, filename: string): Promise<Stats | undefined> {
  try { return await call<Stats>((callback) => sftp.lstat(filename, callback)); }
  catch (error) {
    if (object(error) && error.code === 2) return undefined;
    throw error;
  }
}
async function safePath(sftp: SFTPWrapper, filename: string, allowMissing = false): Promise<Stats | undefined> {
  let current = "";
  let result: Stats | undefined;
  const parts = filename.split("/").filter(Boolean);
  if (!parts.length) return call<Stats>((callback) => sftp.lstat("/", callback));
  for (let index = 0; index < parts.length; index++) {
    current += "/" + parts[index];
    result = await exists(sftp, current);
    if (!result && allowMissing && index === parts.length - 1) return undefined;
    if (!result) throw new HttpError(404, "Server file not found.");
    if (result.isSymbolicLink()) throw new HttpError(400, "Symbolic links cannot be accessed through the file manager.");
    if (index < parts.length - 1 && !result.isDirectory()) throw new HttpError(400, "The parent path is not a folder.");
  }
  return result;
}
async function readSmallFile(sftp: SFTPWrapper, filename: string): Promise<Buffer> {
  const stats = await safePath(sftp, filename);
  if (!stats?.isFile() || stats.size > editLimit) throw new HttpError(413, "Only regular text files up to 256 KiB can be edited.");
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of sftp.createReadStream(filename)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > editLimit) throw new HttpError(413, "The file grew beyond the editor limit.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}
function revision(content: Buffer): string { return `"${createHash("sha256").update(content).digest("hex")}"`; }

export class SftpGateway {
  readonly host = process.env.SFTP_GATEWAY_HOST!;
  readonly publicHost = process.env.SFTP_GATEWAY_PUBLIC_HOST || "sftp.krumpy.xyz";
  readonly port = Number(process.env.SFTP_GATEWAY_PUBLIC_PORT || 2022);
  private readonly ca = readFileSync(process.env.SFTP_GATEWAY_CA_FILE!);
  private readonly apiUrl = new URL(process.env.SFTP_GATEWAY_API_URL!);
  constructor() {
    if (this.apiUrl.protocol !== "https:" || !isIP(this.host) || !Number.isInteger(this.port) || this.port < 1 || this.port > 65535) throw new Error("Invalid SFTP gateway configuration.");
  }
  async request(method: string, suffix: string, body?: unknown, token?: string): Promise<unknown> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const request = httpsRequest(new URL("/api/v2" + suffix, this.apiUrl), {
        method, ca: this.ca, timeout: 10000,
        headers: {
          Authorization: token ? `Bearer ${token}` : `Basic ${Buffer.from(`${process.env.SFTP_GATEWAY_API_USER}:${process.env.SFTP_GATEWAY_API_PASSWORD}`).toString("base64")}`,
          ...(payload === undefined ? {} : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }),
        },
      }, (response) => {
        let text = "";
        response.on("data", (chunk: Buffer) => {
          text += chunk.toString("utf8");
          if (Buffer.byteLength(text) > 131072) response.destroy(new Error("Gateway API response is too large."));
        });
        response.on("error", reject);
        response.on("end", () => {
          if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) return reject(new Error(`Gateway management request failed (HTTP ${response.statusCode}).`));
          try { resolve(text ? JSON.parse(text) : null); } catch { reject(new Error("Invalid gateway management response.")); }
        });
      });
      request.on("timeout", () => request.destroy(new Error("Gateway management request timed out.")));
      request.on("error", reject);
      request.end(payload);
    });
  }
  async token(): Promise<string> {
    const result = await this.request("GET", "/token");
    if (!object(result) || typeof result.access_token !== "string") throw new Error("Invalid gateway authentication response.");
    return result.access_token;
  }
  async user(server: HostedServer, token: string): Promise<JsonObject> {
    const result = await this.request("GET", "/users/" + encodeURIComponent(server.id), undefined, token);
    if (!object(result) || result.username !== server.id || (result.public_keys !== undefined && !Array.isArray(result.public_keys)) || !object(result.filters)) throw new Error("Invalid gateway user response.");
    return { ...result, public_keys: result.public_keys ?? [] };
  }
  async updateUser(server: HostedServer, user: JsonObject, ips: string[], keys: string[], token: string, disconnect: boolean): Promise<void> {
    const allowed = ips.map((ip) => ip + (isIP(ip) === 4 ? "/32" : "/128")).sort();
    await this.request("PUT", "/users/" + encodeURIComponent(server.id) + (disconnect ? "?disconnect=1" : ""), {
      ...user, additional_info: server.owner_discord_id, status: ips.length && keys.length ? 1 : 0, public_keys: keys,
      ...(object(user.filesystem) && object(user.filesystem.sftpconfig) ? {
        filesystem: { ...user.filesystem, sftpconfig: { ...user.filesystem.sftpconfig, private_key: { status: "Redacted" } } },
      } : {}),
      filters: { ...(object(user.filters) ? user.filters : {}), allowed_ip: allowed },
    }, token);
  }
  async synchronizeFirewall(grants: Array<{ ip: string; expiresAt: number }>): Promise<void> {
    const config = sshOptions(this.host, process.env.SFTP_GATEWAY_ACCESS_FINGERPRINT!,
      readFileSync(process.env.SFTP_GATEWAY_ACCESS_KEY_FILE!, "utf8"), "sftpaccess");
    const response: unknown = JSON.parse(await executeRestrictedSsh(config, "sync", JSON.stringify(grants)));
    if (!object(response) || response.synchronized !== true) throw new Error("Gateway did not confirm the IP access update.");
  }
  async open(server: HostedServer, key: string): Promise<{ client: Client; sftp: SFTPWrapper }> {
    return new Promise((resolve, reject) => {
      const client = new Client();
      const timer = setTimeout(() => { client.end(); reject(new Error("File connection timed out.")); }, 15000);
      client.on("error", (error) => { clearTimeout(timer); client.end(); reject(error); });
      client.once("ready", () => client.sftp((error, sftp) => {
        clearTimeout(timer);
        if (error) { client.end(); reject(error); } else resolve({ client, sftp });
      }));
      try { client.connect(sshOptions(this.host, process.env.SFTP_GATEWAY_FINGERPRINT!, key, `web-${server.id}`, 2022)); }
      catch (error) { clearTimeout(timer); client.end(); reject(error); }
    });
  }
}

interface Grant { server_id: string; ip: string; expires_at: Date }
export function createHostingManagement(database: Pool, decrypt: (value: string) => string) {
  const names = ["HOST", "FINGERPRINT", "API_URL", "CA_FILE", "API_USER", "API_PASSWORD", "ACCESS_FINGERPRINT", "ACCESS_KEY_FILE"];
  const configured = names.some((name) => Boolean(process.env["SFTP_GATEWAY_" + name]));
  if (configured && names.some((name) => !process.env["SFTP_GATEWAY_" + name])) throw new Error("SFTP_GATEWAY configuration is incomplete.");
  const gateway = configured ? new SftpGateway() : undefined;
  const router = Router();
  const samples = new Map<string, { invocation: string; time: number; cpu: bigint }>();
  const lastMutation = new Map<string, { count: number; reset: number }>();
  const requireGateway = () => {
    if (!gateway) throw new HttpError(503, "SFTP gateway is not configured.");
    return gateway;
  };
  const sessionHash = (session: string) => createHash("sha256").update(session).digest("hex");
  async function synchronize(client: PoolClient) {
    const target = requireGateway();
    await client.query(`DELETE FROM sftp_access_grants g WHERE expires_at <= NOW() OR NOT EXISTS (
      SELECT 1 FROM hosted_servers h WHERE h.id=g.server_id AND
      (h.owner_discord_id=g.owner_discord_id OR g.owner_discord_id=ANY($1::text[]))
    ) OR NOT EXISTS (
      SELECT 1 FROM "session" s WHERE s.expire > NOW()
      AND encode(sha256(convert_to(s.sid, 'UTF8')), 'hex')=g.session_hash
    ) OR EXISTS (SELECT 1 FROM server_deletions d WHERE d.server_id=g.server_id)`,
    [(process.env.DISCORD_ADMIN_USER_IDS || "").split(",").map((id) => id.trim()).filter(Boolean)]);
    const grants = (await client.query<Grant>("SELECT server_id, ip, expires_at FROM sftp_access_grants WHERE expires_at > NOW()")).rows;
    const servers = (await client.query<HostedServer>(`SELECT * FROM hosted_servers h
      WHERE NOT EXISTS(SELECT 1 FROM server_deletions d WHERE d.server_id=h.id) ORDER BY id`)).rows;
    const token = await target.token();
    for (const server of servers) {
      const user = await target.user(server, token);
      const ips = [...new Set(grants.filter((grant) => grant.server_id === server.id).map((grant) => grant.ip))].sort();
      const allowed = ips.map((ip) => ip + (isIP(ip) === 4 ? "/32" : "/128"));
      const filters = object(user.filters) ? user.filters : {};
      const old = Array.isArray(filters.allowed_ip) ? filters.allowed_ip.filter((ip): ip is string => typeof ip === "string").sort() : [];
      const ownerChanged = user.additional_info !== server.owner_discord_id;
      const keys = ownerChanged ? [] : publicKeys(user.public_keys);
      const enabled = ips.length && keys.length ? 1 : 0;
      if (ownerChanged || JSON.stringify(allowed) !== JSON.stringify(old) || user.status !== enabled) {
        await target.updateUser(server, user, ips, keys, token, ownerChanged || old.some((ip) => !allowed.includes(ip)) || enabled === 0);
      }
    }
    await target.synchronizeFirewall(grants.map((grant) => ({ ip: grant.ip, expiresAt: grant.expires_at.getTime() })));
  }
  async function accessTransaction(change?: (client: PoolClient) => Promise<void>) {
    let client: PoolClient | undefined;
    try {
      client = await database.connect();
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(41927)");
      if (change) await change(client);
      await synchronize(client);
      await client.query("COMMIT");
    } catch (error) {
      if (client) {
        try { await client.query("ROLLBACK"); }
        catch (rollbackError) { console.error("Could not roll back SFTP access state:", rollbackError instanceof Error ? rollbackError.message : "Unknown error"); }
      }
      if (gateway) {
        try { await gateway.synchronizeFirewall([]); }
        catch (firewallError) { console.error("Could not fail-close the SFTP firewall:", firewallError instanceof Error ? firewallError.message : "Unknown error"); }
      }
      throw error;
    } finally { client?.release(); }
  }
  const guard: RequestHandler = (req, res, next) => {
    const origin = req.get("Origin");
    if (req.get("X-Blockhost-Request") !== "console" || (origin && origin !== `${req.protocol}://${req.get("host")}`) ||
        !(req.is("application/json") || (req.method === "PUT" && req.is("application/octet-stream")))) {
      res.status(403).json({ error: "A same-origin management request is required." }); return;
    }
    const now = Date.now();
    for (const [key, value] of lastMutation) if (value.reset <= now) lastMutation.delete(key);
    const key = `${req.user!.id}:${res.locals.hostedServer.id}`;
    const value = lastMutation.get(key) || { count: 0, reset: now + 10000 };
    if (value.count >= 20) { res.setHeader("Retry-After", "10"); res.status(429).json({ error: "Too many operations. Wait ten seconds." }); return; }
    value.count++;
    lastMutation.set(key, value);
    next();
  };
  const route = (handler: (req: Request, server: HostedServer) => Promise<unknown>): RequestHandler => async (req, res, next) => {
    try {
      const result = await handler(req, res.locals.hostedServer);
      if (!res.headersSent) res.json(result);
    } catch (error) {
      if (error instanceof HttpError) { res.status(error.status).json({ error: error.message }); return; }
      next(error);
    }
  };
  router.get("/metrics", route(async (_req, server) => {
    const metrics: unknown = JSON.parse(await executeConsole(server, decrypt(server.encrypted_ssh_key), "metrics"));
    if (!object(metrics) || typeof metrics.invocation !== "string" || typeof metrics.sampledAtMs !== "number" ||
        typeof metrics.cpuUsageNs !== "string" || !/^\d+$/.test(metrics.cpuUsageNs) ||
        typeof metrics.memoryBytes !== "number" || typeof metrics.uptimeSeconds !== "number" || !object(metrics.disk) ||
        !["totalBytes", "usedBytes", "availableBytes"].every((key) => typeof (metrics.disk as JsonObject)[key] === "number")) throw new Error("Invalid server telemetry response.");
    const previous = samples.get(server.id);
    const cpu = BigInt(metrics.cpuUsageNs);
    let cpuPercent: number | null = metrics.state === "active" ? null : 0;
    if (previous && previous.invocation === metrics.invocation && metrics.sampledAtMs > previous.time && cpu >= previous.cpu) {
      cpuPercent = Math.min(100, Math.max(0, Number(cpu - previous.cpu) / ((metrics.sampledAtMs - previous.time) * 1000000) / server.vcpus * 100));
    }
    samples.set(server.id, { invocation: metrics.invocation, time: metrics.sampledAtMs, cpu });
    let players: { online: number; max: number } | null = null;
    let playersError: string | null = null;
    if (metrics.state === "active") {
      if (!process.env.VELOCITY_STATUS_HOST) playersError = "Velocity status connection is not configured.";
      else try { players = await minecraftStatus(process.env.VELOCITY_STATUS_HOST, Number(process.env.VELOCITY_STATUS_PORT || 37001), server.address); }
      catch (error) {
        console.error("Minecraft player status failed:", server.id, error instanceof Error ? error.message : "Unknown error");
        playersError = "Player status is temporarily unavailable.";
      }
    }
    return { ...metrics, cpuUsageNs: undefined, sampledAtMs: undefined, invocation: undefined, cpuPercent, players, playersError };
  }));
  router.get("/settings", route(async (_req, server) => JSON.parse(await executeConsole(server, decrypt(server.encrypted_ssh_key), "settings-get"))));
  router.post("/settings", guard, route(async (req, server) => {
    if (!object(req.body) || !object(req.body.settings) || typeof req.body.expectedSha256 !== "string" || !/^[a-f0-9]{64}$/.test(req.body.expectedSha256)) throw new HttpError(400, "Supply settings and their current revision.");
    const current: unknown = JSON.parse(await executeConsole(server, decrypt(server.encrypted_ssh_key), "settings-get"));
    if (!object(current) || !["inactive", "failed"].includes(String(current.state))) throw new HttpError(409, "Stop Minecraft before saving settings.");
    if (current.sha256 !== req.body.expectedSha256) throw new HttpError(409, "Settings changed. Reload before saving.");
    const result: unknown = JSON.parse(await executeConsole(server, decrypt(server.encrypted_ssh_key), "settings-set", JSON.stringify(req.body)));
    console.info("Hosted settings updated:", { serverId: server.id, actorId: req.user!.id });
    return result;
  }));
  router.get("/sftp", route(async (req, server) => {
    const target = requireGateway();
    const token = await target.token();
    const user = await target.user(server, token);
    const grant = (await database.query<Grant>("SELECT server_id, ip, expires_at FROM sftp_access_grants WHERE server_id=$1 AND session_hash=$2 AND expires_at>NOW()", [server.id, sessionHash(req.sessionID)])).rows[0];
    const ip = clientIp(req);
    return { host: target.publicHost, port: target.port, hostKeyFingerprint: "SHA256:" + process.env.SFTP_GATEWAY_FINGERPRINT,
      username: server.id, publicKeys: user.additional_info === server.owner_discord_id ? publicKeys(user.public_keys) : [], ip,
      expiresAt: grant?.ip === ip ? grant.expires_at.toISOString() : null };
  }));
  router.post("/sftp/keys", guard, route(async (req, server) => {
    const keys = publicKeys(req.body?.publicKeys);
    await accessTransaction(async (client) => {
      const target = requireGateway();
      const token = await target.token();
      const user = await target.user(server, token);
      const rows = (await client.query<Grant>("SELECT server_id,ip,expires_at FROM sftp_access_grants WHERE server_id=$1 AND expires_at>NOW()", [server.id])).rows;
      await target.updateUser(server, user, [...new Set(rows.map((grant) => grant.ip))], keys, token, true);
    });
    console.info("Hosted SFTP keys updated:", { serverId: server.id, actorId: req.user!.id, count: keys.length });
    return { updated: true };
  }));
  router.post("/sftp/access", guard, route(async (req, server) => {
    if (req.body?.enabled !== true && req.body?.enabled !== false) throw new HttpError(400, "Specify whether SFTP access is enabled.");
    const ip = clientIp(req);
    const expiresAt = new Date(Date.now() + 3600000);
    let renewalMissing = false;
    await accessTransaction(async (client) => {
      if (req.body.enabled && req.body.renew === true) {
        const result = await client.query(`UPDATE sftp_access_grants SET expires_at=$1
          WHERE server_id=$2 AND session_hash=$3 AND ip=$4 AND expires_at>NOW() RETURNING server_id`,
        [expiresAt, server.id, sessionHash(req.sessionID), ip]);
        renewalMissing = result.rows.length === 0;
      } else if (req.body.enabled) {
        await client.query(`INSERT INTO sftp_access_grants (server_id,session_hash,owner_discord_id,ip,expires_at)
          VALUES ($1,$2,$3,$4,$5) ON CONFLICT (server_id,session_hash)
          DO UPDATE SET ip=EXCLUDED.ip,expires_at=EXCLUDED.expires_at`, [server.id, sessionHash(req.sessionID), req.user!.id, ip, expiresAt]);
      } else await client.query("DELETE FROM sftp_access_grants WHERE server_id=$1 AND session_hash=$2", [server.id, sessionHash(req.sessionID)]);
    });
    if (renewalMissing) throw new HttpError(409, "SFTP access expired, was revoked, or your IP changed. Enable access again.");
    console.info("Hosted SFTP access changed:", { serverId: server.id, actorId: req.user!.id, enabled: req.body.enabled });
    return { ip, expiresAt: req.body.enabled ? expiresAt.toISOString() : null };
  }));

  const files: RequestHandler = async (req, res, next) => {
    let connection: { client: Client; sftp: SFTPWrapper } | undefined;
    const timer = setTimeout(() => {
      if (!res.headersSent) res.status(504).json({ error: "File operation timed out. Use SFTP for longer transfers." });
      else res.destroy(new Error("File transfer timed out."));
      connection?.client.destroy();
    }, 120000);
    timer.unref();
    try {
      const server: HostedServer = res.locals.hostedServer;
      connection = await requireGateway().open(server, decrypt(server.encrypted_ssh_key));
      const { sftp } = connection;
      const filename = filePath(req.query.path);
      if (req.method === "GET" && req.path === "/files") {
        const stats = await safePath(sftp, filename);
        if (!stats?.isDirectory()) throw new HttpError(400, "Select a folder.");
        const handle = await call<Buffer>((callback) => sftp.opendir(filename, callback));
        const entries: Array<{ name: string; type: string; size: number; modified: number }> = [];
        try {
          while (true) {
            const chunk = await readDirectoryChunk(sftp, handle);
            if (!chunk) break;
            for (const item of chunk) {
              if (item.filename === "." || item.filename === ".." || item.filename.startsWith(".blockhost-upload-")) continue;
              if (entries.length >= 1000) throw new HttpError(413, "This folder exceeds the file manager's 1000-entry limit. Use SFTP.");
              entries.push({ name: item.filename, type: item.attrs.isSymbolicLink() ? "link" : item.attrs.isDirectory() ? "directory" : item.attrs.isFile() ? "file" : "special",
                size: item.attrs.size, modified: item.attrs.mtime * 1000 });
            }
          }
        } finally { await action((callback) => sftp.close(handle, callback)); }
        entries.sort((a, b) => Number(b.type === "directory") - Number(a.type === "directory") || a.name.localeCompare(b.name));
        res.json({ path: filename, entries });
      } else if (req.method === "GET") {
        const stats = await safePath(sftp, filename);
        if (!stats?.isFile()) throw new HttpError(400, "Select a regular file.");
        if (req.query.edit === "1") {
          const content = await readSmallFile(sftp, filename);
          if (content.includes(0)) throw new HttpError(415, "This file is binary. Download it instead.");
          const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
          res.setHeader("ETag", revision(content));
          res.json({ content: text });
        } else {
          res.setHeader("Content-Type", "application/octet-stream");
          res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(path.posix.basename(filename))}`);
          await pipeline(sftp.createReadStream(filename), res);
        }
      } else if (req.method === "PUT") {
        if (filename === "/") throw new HttpError(400, "Select a file name.");
        const editing = req.query.edit === "1";
        const limit = editing ? editLimit : uploadLimit;
        const length = req.get("Content-Length");
        if (length && (!/^\d+$/.test(length) || Number(length) > limit)) throw new HttpError(413, `Upload exceeds the ${editing ? "256 KiB editor" : "90 MiB browser"} limit.`);
        const stats = await safePath(sftp, filename, true);
        if (stats && !stats.isFile()) throw new HttpError(400, "Cannot overwrite a folder or special file.");
        if (editing) {
          if (req.get("If-Match") !== revision(await readSmallFile(sftp, filename))) throw new HttpError(409, "The file changed since it was opened. Reload before saving.");
        } else if (stats && req.get("X-Blockhost-Overwrite") !== "true") throw new HttpError(409, "The file already exists. Confirm overwrite first.");
        const temporary = path.posix.join(path.posix.dirname(filename), ".blockhost-upload-" + randomUUID());
        const counter = uploadCounter(editing);
        let committed = false;
        try {
          await pipeline(req, counter, sftp.createWriteStream(temporary, { flags: "wx", mode: 0o660 }));
          if (editing && req.get("If-Match") !== revision(await readSmallFile(sftp, filename))) throw new HttpError(409, "The file changed while saving. Reload before saving.");
          if (!stats && await exists(sftp, filename)) throw new HttpError(409, "A file appeared at this path while uploading. Confirm overwrite before retrying.");
          // Pinned SFTPGo uses backend POSIX rename for standard requests, without advertising that extension.
          await action((callback) => sftp.rename(temporary, filename, callback));
          committed = true;
        } finally {
          if (!committed) {
            try { if (await exists(sftp, temporary)) await action((callback) => sftp.unlink(temporary, callback)); }
            catch (cleanupError) { console.error("Could not remove interrupted upload:", cleanupError instanceof Error ? cleanupError.message : "Unknown error"); }
          }
        }
        console.info("Hosted file uploaded:", { serverId: server.id, actorId: req.user!.id });
        res.json({ saved: true });
      } else {
        const value: unknown = req.body;
        if (!object(value)) throw new HttpError(400, "Provide a file operation.");
        const source = filePath(value.path);
        if (source === "/") throw new HttpError(400, "The server root cannot be modified.");
        const stats = await safePath(sftp, source, value.operation === "mkdir");
        if (value.operation === "mkdir") {
          if (stats) throw new HttpError(409, "That path already exists.");
          await action((callback) => sftp.mkdir(source, { mode: 0o770 }, callback));
        } else if (value.operation === "delete") {
          if (stats?.isDirectory()) await action((callback) => sftp.rmdir(source, callback));
          else if (stats?.isFile()) await action((callback) => sftp.unlink(source, callback));
          else throw new HttpError(400, "Only regular files and empty folders can be deleted.");
        } else if (value.operation === "rename") {
          const destination = filePath(value.destination);
          if (destination === "/" || await safePath(sftp, destination, true)) throw new HttpError(409, "The destination already exists.");
          await action((callback) => sftp.rename(source, destination, callback));
        } else throw new HttpError(400, "Choose mkdir, rename, or delete.");
        console.info("Hosted file operation:", { serverId: server.id, actorId: req.user!.id, operation: value.operation });
        res.json({ updated: true });
      }
    } catch (error) {
      if (res.writableEnded) return;
      if (res.headersSent) { res.destroy(error instanceof Error ? error : undefined); return; }
      if (error instanceof HttpError) res.status(error.status).json({ error: error.message });
      else {
        console.error("Hosted file operation failed:", error instanceof Error ? error.message : "Unknown error");
        res.status(502).json({ error: "File operation failed. Check the connection, permissions, and whether the folder is empty." });
      }
    } finally { clearTimeout(timer); connection?.sftp.end(); connection?.client.end(); }
  };
  router.get("/files", files);
  router.get("/files/content", files);
  router.put("/files/content", guard, files);
  router.post("/files", guard, files);
  let timer: NodeJS.Timeout | undefined;
  return {
    router,
    start() {
      if (!gateway || timer) return;
      const sync = () => accessTransaction().catch((error: unknown) => console.error("SFTP access synchronization failed:", error instanceof Error ? error.message : "Unknown error"));
      void sync();
      timer = setInterval(sync, 30000);
      timer.unref();
    },
    async revokeSession(id: string) {
      if (!gateway) return;
      await accessTransaction(async (client) => { await client.query("DELETE FROM sftp_access_grants WHERE session_hash=$1", [sessionHash(id)]); });
    },
  };
}

export function gatewayUser(server: HostedServer, privateKey: string, keys: string[], web: boolean): JsonObject {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/.test(server.id)) throw new Error("The server ID cannot be used as an SFTP login.");
  return {
    username: (web ? "web-" : "") + server.id, additional_info: server.owner_discord_id, status: web ? 1 : 0,
    password: randomBytes(32).toString("hex"), public_keys: keys,
    home_dir: `/var/lib/sftpgo/users/${web ? "web-" : ""}${server.id}`,
    permissions: { "/": ["list", "download", "upload", "overwrite", "delete", "rename", "create_dirs"] },
    filters: {
      allowed_ip: [web ? "10.0.0.65/32" : "127.0.0.1/32"],
      denied_protocols: ["FTP", "DAV", "HTTP"],
      denied_login_methods: ["password", "password-over-SSH", "keyboard-interactive", "publickey+password", "publickey+keyboard-interactive"],
    },
    filesystem: { provider: 5, sftpconfig: {
      endpoint: server.ssh_host + ":22", username: "minecraft", prefix: "/files",
      fingerprints: ["SHA256:" + server.ssh_host_fingerprint.replace(/^SHA256:/, "")],
      private_key: { status: "Plain", payload: privateKey },
    } },
  };
}
