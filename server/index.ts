import "dotenv/config";

import connectPgSimple from "connect-pg-simple";
import express, { ErrorRequestHandler, NextFunction, Request, Response } from "express";
import session from "express-session";
import helmet from "helmet";
import passport from "passport";
import { Strategy as DiscordStrategy } from "passport-discord";
import { Pool } from "pg";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "crypto";
import path from "path";
import { createHostedServersRouter } from "./hosted-servers";
import { createHostingManagement } from "./hosting-management";
import { addressPool, createProvisioningRouter, provisioningSchema } from "./provisioning";
import { createDeletionRouter, deletionSchema } from "./deletions";

interface DiscordAccount extends Express.User {
  id: string;
  username: string;
  avatar: string | null;
}

declare global {
  namespace Express {
    interface User {
      id: string;
      username: string;
      avatar: string | null;
    }
  }
}

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";
const sessionSecret = process.env.APP_SESSION_SECRET;
const databaseUrl = process.env.DATABASE_URL;
const discordClientId = process.env.DISCORD_CLIENT_ID;
const discordClientSecret = process.env.DISCORD_CLIENT_SECRET;
const discordCallbackUrl = process.env.DISCORD_CALLBACK_URL;
const serverCredentialsKey = process.env.SERVER_CREDENTIALS_KEY;
const minecraftAllowedHosts = new Set(
  (process.env.MINECRAFT_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean),
);
const adminDiscordIds = new Set(
  (process.env.DISCORD_ADMIN_USER_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean),
);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be a valid TCP port.");
}
if (!sessionSecret || sessionSecret.length < 32) {
  throw new Error("APP_SESSION_SECRET must be set to a random value of at least 32 characters.");
}
if (!databaseUrl) {
  throw new Error("DATABASE_URL must point to a PostgreSQL database for persistent sessions.");
}
if (!discordClientId || !discordClientSecret || !discordCallbackUrl) {
  throw new Error("DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, and DISCORD_CALLBACK_URL are required.");
}
for (const id of adminDiscordIds) {
  if (!/^\d{17,20}$/.test(id)) throw new Error("DISCORD_ADMIN_USER_IDS must contain Discord numeric user IDs.");
}
if (adminDiscordIds.size === 0) {
  console.warn("No Discord administrators configured; all admin-only APIs will deny access.");
}
if (serverCredentialsKey && !/^[a-fA-F0-9]{64}$/.test(serverCredentialsKey)) {
  throw new Error("SERVER_CREDENTIALS_KEY must be a 32-byte key encoded as 64 hexadecimal characters.");
}

const pool = new Pool({ connectionString: databaseUrl });
const PgSessionStore = connectPgSimple(session);
const app = express();
const production = process.env.NODE_ENV === "production";
app.use(express.json({ limit: "32kb" }));

passport.use(
  new DiscordStrategy(
    {
      clientID: discordClientId,
      clientSecret: discordClientSecret,
      callbackURL: discordCallbackUrl,
      scope: ["identify"],
      state: true,
    },
    (_accessToken, _refreshToken, profile, done) => {
      done(null, {
        id: profile.id,
        username: profile.username,
        avatar: profile.avatar ?? null,
      });
    },
  ),
);
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user: DiscordAccount, done) => done(null, user));

app.disable("x-powered-by");
app.set("trust proxy", production ? 1 : false);
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
      },
    },
  }),
);
app.use(
  session({
    name: "blockhost.sid",
    store: new PgSessionStore({ pool, createTableIfMissing: true }),
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: production,
      sameSite: "lax",
      maxAge: 1000 * 60 * 60 * 24 * 7,
    },
  }),
);
app.use(passport.initialize());
app.use(passport.session());

async function updateAccountRecord(user: DiscordAccount): Promise<void> {
  await pool.query(
    `INSERT INTO discord_accounts (discord_id, username, avatar_url, last_seen_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (discord_id) DO UPDATE
     SET username = EXCLUDED.username, avatar_url = EXCLUDED.avatar_url, last_seen_at = NOW()`,
    [user.id, user.username, user.avatar],
  );
}

async function requireAuthenticated(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!req.isAuthenticated() || !req.user) {
    res.status(401).json({ error: "Authentication required." });
    return;
  }
  try {
    await updateAccountRecord(req.user);
    next();
  } catch (error) {
    next(error);
  }
}

async function requireAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!req.isAuthenticated() || !req.user) {
    res.status(401).json({ error: "Authentication required." });
    return;
  }
  if (!adminDiscordIds.has(req.user.id)) {
    res.status(403).json({ error: "Administrator access required." });
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  try {
    await updateAccountRecord(req.user);
    next();
  } catch (error) {
    next(error);
  }
}

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

app.get("/auth/discord", passport.authenticate("discord"));
app.get(
  "/auth/discord/callback",
  passport.authenticate("discord", { failureRedirect: "/?auth=failed" }),
  (_req, res) => res.redirect("/"),
);
app.post("/auth/logout", requireAuthenticated, async (req, res, next) => {
  try {
    await hostingManagement.revokeSession(req.sessionID);
    req.logout((logoutError) => {
      if (logoutError) return next(logoutError);
      req.session.destroy((sessionError) => {
        if (sessionError) return next(sessionError);
        res.clearCookie("blockhost.sid", { httpOnly: true, sameSite: "lax", secure: production });
        res.status(204).end();
      });
    });
  } catch (error) { next(error); }
});

app.get("/api/me", async (req, res, next) => {
  if (!req.isAuthenticated() || !req.user) {
    res.status(401).json({ authenticated: false });
    return;
  }
  try {
    await updateAccountRecord(req.user);
    res.setHeader("Cache-Control", "no-store");
    res.json({
      authenticated: true,
      user: {
        id: req.user.id,
        username: req.user.username,
        avatar: req.user.avatar,
        isAdmin: adminDiscordIds.has(req.user.id),
      },
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/account/plan", requireAuthenticated, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT p.id, p.name, p.max_servers AS "maxServers",
              p.max_vcpus_per_server AS "maxVcpusPerServer",
              p.max_ram_mb_per_server AS "maxRamMbPerServer",
              p.max_ram_mb_per_server / 1024 AS "maxRamGbPerServer",
              p.max_disk_gb_per_server AS "maxDiskGbPerServer"
       FROM discord_accounts a
       LEFT JOIN service_plans p ON p.id = a.plan_id
       WHERE a.discord_id = $1`,
      [req.user!.id],
    );
    res.setHeader("Cache-Control", "no-store");
    res.json(result.rows[0] ?? { id: null });
  } catch (error) {
    next(error);
  }
});

function parsePlanInput(body: unknown): {
  name: string;
  maxServers: number | null;
  maxVcpusPerServer: number;
  maxRamMbPerServer: number;
  maxDiskGbPerServer: number;
} | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const input = body as Record<string, unknown>;
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const maxServers = input.maxServers === null ? null : Number(input.maxServers);
  const maxVcpusPerServer = Number(input.maxVcpusPerServer);
  const maxRamMbPerServer = input.maxRamMbPerServer !== undefined
    ? Number(input.maxRamMbPerServer)
    : Number(input.maxRamGbPerServer) * 1024;
  const maxDiskGbPerServer = Number(input.maxDiskGbPerServer);
  if (
    !name || name.length > 48 ||
    (maxServers !== null && (!Number.isInteger(maxServers) || maxServers < 1 || maxServers > 100)) ||
    !Number.isInteger(maxVcpusPerServer) || maxVcpusPerServer < 1 || maxVcpusPerServer > 64 ||
    !Number.isInteger(maxRamMbPerServer) || maxRamMbPerServer < 1024 || maxRamMbPerServer > 524288 ||
    !Number.isInteger(maxDiskGbPerServer) || maxDiskGbPerServer < 1 || maxDiskGbPerServer > 4096
  ) return null;
  return {
    name,
    maxServers,
    maxVcpusPerServer,
    maxRamMbPerServer,
    maxDiskGbPerServer,
  };
}

app.get("/api/admin/plans", requireAdmin, async (_req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT p.id, p.name, p.max_servers AS "maxServers",
             p.max_vcpus_per_server AS "maxVcpusPerServer",
             p.max_ram_mb_per_server AS "maxRamMbPerServer",
             p.max_ram_mb_per_server / 1024.0 AS "maxRamGbPerServer",
             p.max_disk_gb_per_server AS "maxDiskGbPerServer",
             COUNT(a.discord_id)::int AS "assignedUsers"
      FROM service_plans p
      LEFT JOIN discord_accounts a ON a.plan_id = p.id
      GROUP BY p.id
      ORDER BY p.created_at, p.name
    `);
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
});

app.post("/api/admin/plans", requireAdmin, async (req, res, next) => {
  try {
    const plan = parsePlanInput(req.body);
    if (!plan) {
      res.status(400).json({ error: "Provide a plan name and valid server, vCPU, RAM, and disk limits." });
      return;
    }
    const result = await pool.query(
      `INSERT INTO service_plans
         (id, name, max_servers, max_vcpus_per_server, max_ram_mb_per_server, max_disk_gb_per_server)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, name, max_servers AS "maxServers",
                 max_vcpus_per_server AS "maxVcpusPerServer",
                 max_ram_mb_per_server AS "maxRamMbPerServer",
                 max_ram_mb_per_server / 1024.0 AS "maxRamGbPerServer",
                 max_disk_gb_per_server AS "maxDiskGbPerServer"`,
      [randomUUID(), plan.name, plan.maxServers, plan.maxVcpusPerServer, plan.maxRamMbPerServer, plan.maxDiskGbPerServer],
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

app.put("/api/admin/plans/:id", requireAdmin, async (req, res, next) => {
  try {
    const plan = parsePlanInput(req.body);
    if (!plan) {
      res.status(400).json({ error: "Provide a plan name and valid server, vCPU, RAM, and disk limits." });
      return;
    }
    const maxServers = req.params.id === "plan-1" ? 1
      : req.params.id === "plan-2" ? 2
        : req.params.id === "plan-3" ? null
          : plan.maxServers;
    const result = await pool.query(
      `UPDATE service_plans
       SET name = $2, max_servers = $3, max_vcpus_per_server = $4,
           max_ram_mb_per_server = $5, max_disk_gb_per_server = $6, updated_at = NOW()
       WHERE id = $1
       RETURNING id, name, max_servers AS "maxServers",
                 max_vcpus_per_server AS "maxVcpusPerServer",
                 max_ram_mb_per_server AS "maxRamMbPerServer",
                 max_ram_mb_per_server / 1024.0 AS "maxRamGbPerServer",
                 max_disk_gb_per_server AS "maxDiskGbPerServer"`,
      [req.params.id, plan.name, maxServers, plan.maxVcpusPerServer, plan.maxRamMbPerServer, plan.maxDiskGbPerServer],
    );
    if (result.rowCount === 0) {
      res.status(404).json({ error: "Plan not found." });
      return;
    }
    res.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/accounts", requireAdmin, async (_req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT a.discord_id AS id, a.username, a.avatar_url AS avatar,
             a.plan_id AS "planId", p.name AS "planName", a.last_seen_at AS "lastSeenAt"
      FROM discord_accounts a
      LEFT JOIN service_plans p ON p.id = a.plan_id
      ORDER BY a.last_seen_at DESC, a.username
    `);
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
});

app.put("/api/admin/accounts/:discordId/plan", requireAdmin, async (req, res, next) => {
  try {
    if (!/^\d{17,20}$/.test(req.params.discordId)) {
      res.status(400).json({ error: "Invalid Discord account ID." });
      return;
    }
    const planId = req.body?.planId;
    if (planId !== null && typeof planId !== "string") {
      res.status(400).json({ error: "Plan ID must be a string or null." });
      return;
    }
    if (planId !== null) {
      const planResult = await pool.query("SELECT id FROM service_plans WHERE id = $1", [planId]);
      if (planResult.rowCount === 0) {
        res.status(400).json({ error: "Selected plan does not exist." });
        return;
      }
    }
    const result = await pool.query(
      `UPDATE discord_accounts SET plan_id = $2
       WHERE discord_id = $1 RETURNING discord_id AS id, plan_id AS "planId"`,
      [req.params.discordId, planId],
    );
    if (result.rowCount === 0) {
      res.status(404).json({ error: "Discord account has not logged in to Blockhost yet." });
      return;
    }
    res.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/proxmox/status", requireAdmin, async (req, res, next) => {
  try {
    const proxmoxUrl = process.env.PROXMOX_API_URL?.trim() || process.env.PROXMOX_URL?.trim();
    const tokenId = process.env.PROXMOX_TOKEN_ID;
    const tokenSecret = process.env.PROXMOX_TOKEN_SECRET;
    const vmId = Number(process.env.PROXMOX_VM_ID);
    const vmName = process.env.PROXMOX_VM_NAME?.trim();
    if (!proxmoxUrl || !tokenId || !tokenSecret || !Number.isInteger(vmId) || vmId <= 0 || !vmName) {
      res.status(503).json({ error: "Proxmox connection is not fully configured." });
      return;
    }

    const baseUrl = new URL(proxmoxUrl.endsWith("/") ? proxmoxUrl : `${proxmoxUrl}/`);
    if (baseUrl.protocol !== "https:") {
      res.status(503).json({ error: "Proxmox API must use HTTPS." });
      return;
    }
    if (!baseUrl.pathname.replace(/\/$/, "").endsWith("/api2/json")) {
      baseUrl.pathname = `${baseUrl.pathname.replace(/\/$/, "")}/api2/json/`;
    }
    const url = new URL("cluster/resources?type=vm", baseUrl);
    const response = await fetch(url, {
      headers: { Authorization: `PVEAPIToken=${tokenId}=${tokenSecret}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      console.error(`Proxmox returned HTTP ${response.status} for the admin stats request.`);
      res.status(502).json({ error: "Proxmox rejected the stats request." });
      return;
    }

    const result = (await response.json()) as {
      data?: Array<{
        type?: string;
        vmid?: number;
        name?: string;
        node?: string;
        status?: string;
        cpu?: number;
        mem?: number;
        maxmem?: number;
        uptime?: number;
      }>;
    };
    const vm = result.data?.find((item) => item.type === "qemu" && item.vmid === vmId && item.name === vmName);
    if (!vm) {
      res.status(404).json({ error: "Configured Proxmox VM was not returned by the cluster API." });
      return;
    }
    const values = [vm.cpu, vm.mem, vm.maxmem, vm.uptime].map(Number);
    if (!vm.node || !vm.status || values.some((value) => !Number.isFinite(value)) || values[2] <= 0) {
      res.status(502).json({ error: "Proxmox returned an invalid VM resource response." });
      return;
    }
    res.json({
      node: vm.node,
      name: vm.name,
      status: vm.status,
      cpuUsagePercent: Math.round(values[0] * 100),
      memoryUsedBytes: values[1],
      memoryTotalBytes: values[2],
      uptimeSeconds: values[3],
    });
  } catch (error) {
    next(error);
  }
});

function getCredentialKey(res: Response): Buffer | null {
  if (!serverCredentialsKey) {
    res.status(503).json({ error: "Minecraft server connections are not configured." });
    return null;
  }
  return Buffer.from(serverCredentialsKey, "hex");
}

function encryptApiKey(apiKey: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(apiKey, "utf8"), cipher.final()]);
  return `v1:${iv.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}:${encrypted.toString("base64url")}`;
}

function decryptApiKey(value: string, key: Buffer): string {
  const [version, ivText, tagText, encryptedText] = value.split(":");
  if (version !== "v1" || !ivText || !tagText || !encryptedText) {
    throw new Error("Stored server credential has an invalid format.");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedText, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function decryptHostedKey(value: string): string {
  if (!serverCredentialsKey) throw new Error("Server credentials are not configured.");
  return decryptApiKey(value, Buffer.from(serverCredentialsKey, "hex"));
}
const hostingManagement = createHostingManagement(pool, decryptHostedKey);
const provisioningAddresses = process.env.HOSTING_IP_START || process.env.HOSTING_IP_END
  ? addressPool(process.env.HOSTING_IP_START || "", process.env.HOSTING_IP_END || "") : [];
app.use("/api/hosting", createProvisioningRouter(pool, requireAuthenticated));
app.use("/api/hosting", createDeletionRouter(pool, requireAuthenticated, adminDiscordIds));
app.use("/api/hosted/servers", createHostedServersRouter({
  database: pool,
  requireAuthenticated,
  adminIds: adminDiscordIds,
  allowedHosts: new Set([...provisioningAddresses, ...(process.env.HOSTED_SERVER_ALLOWED_HOSTS ?? "").split(",").map((value) => value.trim()).filter(Boolean)]),
  credentialsConfigured: Boolean(serverCredentialsKey),
  decryptPrivateKey: decryptHostedKey,
  management: hostingManagement.router,
}));

function validServerApiUrl(value: unknown): URL | null {
  if (typeof value !== "string" || value.length > 255) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      url.port ||
      !minecraftAllowedHosts.has(url.hostname.toLowerCase())
    ) return null;
    return url;
  } catch {
    return null;
  }
}

app.get("/api/minecraft/servers", requireAuthenticated, async (req, res, next) => {
  try {
    const result = await pool.query(
      "SELECT id, name, api_url AS \"apiUrl\", created_at AS \"createdAt\" FROM minecraft_servers WHERE owner_discord_id = $1 ORDER BY created_at DESC",
      [req.user!.id],
    );
    res.setHeader("Cache-Control", "no-store");
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
});

app.post("/api/minecraft/servers", requireAuthenticated, async (req, res, next) => {
  try {
    const key = getCredentialKey(res);
    if (!key) return;
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
      res.status(400).json({ error: "Request body must be a JSON object." });
      return;
    }
    const { name, apiUrl, apiKey } = req.body as { name?: unknown; apiUrl?: unknown; apiKey?: unknown };
    const safeName = typeof name === "string" ? name.trim() : "";
    const url = validServerApiUrl(apiUrl);
    if (!safeName || safeName.length > 48 || !url) {
      res.status(400).json({ error: "Provide a server name and an HTTPS URL whose hostname is in MINECRAFT_ALLOWED_HOSTS." });
      return;
    }
    if (typeof apiKey !== "string" || !/^ba_[A-Za-z0-9_-]{43}$/.test(apiKey)) {
      res.status(400).json({ error: "The BadApple API key is invalid." });
      return;
    }

    const verification = await fetch(new URL("/v1/server", url), {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8000),
      redirect: "error",
    });
    await verification.body?.cancel();
    if (verification.status === 401) {
      res.status(400).json({ error: "The server rejected this API key." });
      return;
    }
    if (!verification.ok) {
      res.status(502).json({ error: `Minecraft API returned HTTP ${verification.status}.` });
      return;
    }

    const id = randomUUID();
    const result = await pool.query(
      "INSERT INTO minecraft_servers (id, owner_discord_id, name, api_url, encrypted_api_key) VALUES ($1, $2, $3, $4, $5) RETURNING id, name, api_url AS \"apiUrl\", created_at AS \"createdAt\"",
      [id, req.user!.id, safeName, url.origin, encryptApiKey(apiKey, key)],
    );
    res.status(201).setHeader("Cache-Control", "no-store");
    res.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

app.delete("/api/minecraft/servers/:id", requireAuthenticated, async (req, res, next) => {
  try {
    const result = await pool.query(
      "DELETE FROM minecraft_servers WHERE id = $1 AND owner_discord_id = $2 RETURNING id",
      [req.params.id, req.user!.id],
    );
    if (result.rowCount === 0) {
      res.status(404).json({ error: "Connected server not found." });
      return;
    }
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

async function getMinecraftConnection(id: string, ownerId: string, res: Response) {
  const key = getCredentialKey(res);
  if (!key) return null;
  const result = await pool.query(
    "SELECT id, name, api_url, encrypted_api_key FROM minecraft_servers WHERE id = $1 AND owner_discord_id = $2",
    [id, ownerId],
  );
  if (result.rowCount === 0) {
    res.status(404).json({ error: "Connected server not found." });
    return null;
  }
  const row = result.rows[0] as { id: string; name: string; api_url: string; encrypted_api_key: string };
  return { ...row, apiKey: decryptApiKey(row.encrypted_api_key, key) };
}

app.get("/api/minecraft/servers/:id/:resource(server|players|groups|tracks)", requireAuthenticated, async (req, res, next) => {
  try {
    const connection = await getMinecraftConnection(req.params.id, req.user!.id, res);
    if (!connection) return;
    const response = await fetch(new URL(`/v1/${req.params.resource}`, connection.api_url), {
      headers: { Authorization: `Bearer ${connection.apiKey}` },
      signal: AbortSignal.timeout(8000),
      redirect: "error",
    });
    if (!response.ok) {
      res.status(502).json({ error: `Minecraft API returned HTTP ${response.status}.` });
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.json(await response.json());
  } catch (error) {
    next(error);
  }
});

app.post("/api/minecraft/servers/:id/actions", requireAuthenticated, async (req, res, next) => {
  try {
    const connection = await getMinecraftConnection(req.params.id, req.user!.id, res);
    if (!connection) return;
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
      res.status(400).json({ error: "Request body must be a JSON object." });
      return;
    }
    const { action, ...payload } = req.body as Record<string, unknown>;
    const actions: Record<string, string> = {
      "create-group": "/v1/groups/create",
      "delete-group": "/v1/groups/delete",
      "set-prefix": "/v1/groups/prefix",
      "set-player-group": "/v1/players/group",
      promote: "/v1/players/promote",
      demote: "/v1/players/demote",
    };
    if (typeof action !== "string" || !actions[action]) {
      res.status(400).json({ error: "Unsupported Minecraft server action." });
      return;
    }
    const response = await fetch(new URL(actions[action], connection.api_url), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${connection.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
      redirect: "error",
    });
    const result = await response.json().catch(() => null);
    if (!response.ok) {
      res.status(502).json({ error: "Minecraft server rejected the requested action.", details: result });
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.use(express.static(path.resolve(process.cwd(), "source"), { index: "index.html" }));
app.use("/api", (_req, res) => res.status(404).json({ error: "API route not found." }));
app.use((_req, res) => res.sendFile(path.resolve(process.cwd(), "source", "index.html")));

const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  console.error("Unhandled request error:", error);
  if (res.headersSent) return;
  res.status(500).json({ error: "The server could not complete the request." });
};
app.use(errorHandler);

pool
  .query("SELECT 1")
  .then(() =>
    pool.query(`
      CREATE TABLE IF NOT EXISTS minecraft_servers (
        id TEXT PRIMARY KEY,
        owner_discord_id TEXT NOT NULL,
        name TEXT NOT NULL,
        api_url TEXT NOT NULL,
        encrypted_api_key TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `),
  )
  .then(async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS service_plans (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        max_servers INTEGER CHECK (max_servers IS NULL OR max_servers BETWEEN 1 AND 100),
        max_vcpus_per_server INTEGER NOT NULL CHECK (max_vcpus_per_server BETWEEN 1 AND 64),
        max_ram_mb_per_server INTEGER NOT NULL CHECK (max_ram_mb_per_server BETWEEN 1024 AND 524288),
        max_disk_gb_per_server INTEGER NOT NULL CHECK (max_disk_gb_per_server BETWEEN 1 AND 4096),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query("ALTER TABLE service_plans ALTER COLUMN max_servers DROP NOT NULL");
    await pool.query("ALTER TABLE service_plans DROP CONSTRAINT IF EXISTS service_plans_max_servers_check");
    await pool.query(`
      ALTER TABLE service_plans
      ADD CONSTRAINT service_plans_max_servers_check
      CHECK (max_servers IS NULL OR max_servers BETWEEN 1 AND 100)
    `);
    await pool.query(`
      INSERT INTO service_plans
        (id, name, max_servers, max_vcpus_per_server, max_ram_mb_per_server, max_disk_gb_per_server)
      VALUES
        ('plan-1', 'Plan 1', 1, 4, 4096, 32),
        ('plan-2', 'Plan 2', 2, 6, 8192, 40),
        ('plan-3', 'Plan 3', NULL, 6, 8192, 40)
      ON CONFLICT (id) DO NOTHING
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS blockhost_schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      WITH migration AS (
        INSERT INTO blockhost_schema_migrations (version)
        VALUES ('2026-11-plan-server-counts')
        ON CONFLICT (version) DO NOTHING
        RETURNING version
      )
      UPDATE service_plans SET max_servers = 2
      WHERE id = 'plan-2' AND EXISTS (SELECT 1 FROM migration)
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS discord_accounts (
        discord_id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        avatar_url TEXT,
        plan_id TEXT REFERENCES service_plans(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS hosted_servers (
        id TEXT PRIMARY KEY,
        owner_discord_id TEXT NOT NULL REFERENCES discord_accounts(discord_id),
        name TEXT NOT NULL,
        software TEXT NOT NULL,
        version TEXT NOT NULL,
        address TEXT NOT NULL UNIQUE,
        vmid INTEGER NOT NULL UNIQUE,
        vcpus INTEGER NOT NULL CHECK (vcpus > 0),
        ram_mb INTEGER NOT NULL CHECK (ram_mb > 0),
        disk_gb INTEGER NOT NULL CHECK (disk_gb > 0),
        ssh_host TEXT NOT NULL,
        ssh_host_fingerprint TEXT NOT NULL,
        encrypted_ssh_key TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sftp_access_grants (
        server_id TEXT NOT NULL REFERENCES hosted_servers(id) ON DELETE CASCADE,
        session_hash TEXT NOT NULL,
        owner_discord_id TEXT NOT NULL REFERENCES discord_accounts(discord_id) ON DELETE CASCADE,
        ip TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (server_id, session_hash)
      )
    `);
    await pool.query("CREATE INDEX IF NOT EXISTS sftp_access_expiry_idx ON sftp_access_grants(expires_at)");
    await pool.query(provisioningSchema);
    await pool.query(deletionSchema);
  })
  .then(() => {
    hostingManagement.start();
    app.listen(port, host, () => console.log(`Blockhost server listening on ${host}:${port}.`));
  })
  .catch((error: unknown) => {
    console.error("Could not connect to PostgreSQL:", error);
    process.exitCode = 1;
  });
