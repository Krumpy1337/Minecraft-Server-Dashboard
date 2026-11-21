import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { RequestHandler, Router } from "express";
import { Pool } from "pg";

export class ProvisioningError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export interface CreationInput {
  requestId: string; name: string; slug: string; vcpus: number; ramMb: number; diskGb: number;
}
export interface Plan {
  max_servers: number | null; max_vcpus_per_server: number; max_ram_mb_per_server: number; max_disk_gb_per_server: number;
}
export interface ProvisioningJob {
  id: string; owner_discord_id: string; request_id: string; name: string; hostname: string;
  vcpus: number; ram_mb: number; disk_gb: number; status: "queued" | "running" | "completed" | "failed" | "deleted";
  stage: string; error: string | null; cleanup_complete: boolean; created_at: Date; updated_at: Date;
  eula_accepted_at: Date;
}
export function addressPool(start: string, end: string): string[] {
  if (isIP(start) !== 4 || isIP(end) !== 4) throw new Error("Configure an IPv4 provisioning address range.");
  const first = start.split("."), last = end.split(".");
  const a = Number(first.pop()), b = Number(last.pop());
  if (first.join(".") !== last.join(".") || a < 2 || b > 254 || b < a || b - a >= 100) throw new Error("Provisioning addresses must share a /24 and contain at most 100 usable addresses.");
  return Array.from({ length: b - a + 1 }, (_, index) => first.join(".") + "." + (a + index));
}
export function creationInput(value: unknown): CreationInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProvisioningError(400, "Provide server details.");
  const input = value as Record<string, unknown>;
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const slug = typeof input.slug === "string" ? input.slug.trim().toLowerCase() : "";
  if (input.eulaAccepted !== true) throw new ProvisioningError(400, "Explicit Minecraft EULA acceptance is required.");
  if (typeof input.requestId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(input.requestId)) throw new ProvisioningError(400, "A valid creation request ID is required.");
  if (!name || name.length > 48 || /[\x00-\x1f\x7f]/.test(name)) throw new ProvisioningError(400, "Use a server name of 1-48 characters without control characters.");
  if (!/^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/.test(slug) || /^(www|api|sftp|blockhost|mail|test|mcdev|pve\d+)$/.test(slug)) throw new ProvisioningError(400, "Choose an available subdomain of 3-32 letters, numbers, or hyphens.");
  if ((input.software !== undefined && input.software !== "Paper") || (input.version !== undefined && input.version !== "26.3")) throw new ProvisioningError(400, "This proof of concept supports Paper 26.3 only.");
  const vcpus = input.vcpus, ramMb = input.ramMb, diskGb = input.diskGb;
  if (typeof vcpus !== "number" || !Number.isInteger(vcpus) || vcpus < 1 || vcpus > 8 ||
      typeof ramMb !== "number" || !Number.isInteger(ramMb) || ramMb < 2048 || ramMb > 8192 || ramMb % 256 ||
      typeof diskGb !== "number" || !Number.isInteger(diskGb) || diskGb < 32 || diskGb > 64) throw new ProvisioningError(400, "Use 1-8 vCPU, 2048-8192 MiB RAM (256 MiB increments), and 32-64 GiB disk, within your plan.");
  return { requestId: input.requestId.toLowerCase(), name, slug, vcpus, ramMb, diskGb };
}
export function enforcePlan(input: CreationInput, plan: Plan | undefined, used: number): void {
  if (!plan) throw new ProvisioningError(403, "An assigned hosting plan is required.");
  if (plan.max_servers !== null && used >= plan.max_servers) throw new ProvisioningError(409, "Your plan's server limit is reached, including pending creations.");
  if (input.vcpus > plan.max_vcpus_per_server || input.ramMb > plan.max_ram_mb_per_server || input.diskGb > plan.max_disk_gb_per_server) throw new ProvisioningError(403, "Requested resources exceed your hosting plan.");
}
export const provisioningSchema = `
  CREATE TABLE IF NOT EXISTS provisioning_jobs (
    id TEXT PRIMARY KEY, owner_discord_id TEXT NOT NULL REFERENCES discord_accounts(discord_id),
    request_id TEXT NOT NULL, name TEXT NOT NULL, hostname TEXT NOT NULL,
    vcpus INTEGER NOT NULL, ram_mb INTEGER NOT NULL, disk_gb INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed','deleted')),
    stage TEXT NOT NULL DEFAULT 'Waiting for provisioner', error TEXT,
    cleanup_complete BOOLEAN NOT NULL DEFAULT false,
    eula_accepted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    eula_url TEXT NOT NULL DEFAULT 'https://www.minecraft.net/en-us/eula',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(owner_discord_id,request_id)
  );
  ALTER TABLE provisioning_jobs DROP CONSTRAINT IF EXISTS provisioning_jobs_status_check;
  ALTER TABLE provisioning_jobs ADD CONSTRAINT provisioning_jobs_status_check
    CHECK(status IN ('queued','running','completed','failed','deleted'));
  DROP INDEX IF EXISTS provisioning_hostname_reserved;
  CREATE UNIQUE INDEX provisioning_hostname_reserved
    ON provisioning_jobs(hostname) WHERE status NOT IN ('failed','deleted') OR NOT cleanup_complete;
  CREATE TABLE IF NOT EXISTS provisioning_worker (
    id INTEGER PRIMARY KEY CHECK(id=1), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`;
export function publicJob(row: ProvisioningJob) {
  return { id: row.id, name: row.name, hostname: row.hostname, status: row.status, stage: row.stage,
    error: row.error, cleanupComplete: row.cleanup_complete, createdAt: row.created_at, updatedAt: row.updated_at };
}
export function createProvisioningRouter(database: Pool, authenticate: RequestHandler) {
  const router = Router();
  router.use(authenticate, (_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
  const domain = process.env.HOSTING_DOMAIN || "krumpy.xyz";
  if (!/^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) throw new Error("Invalid hosting domain.");
  const enabled = process.env.HOSTING_ENABLED === "true";
  router.get("/config", async (req, res, next) => {
    try {
      const plan = (await database.query<Plan & { name: string }>(`SELECT p.* FROM discord_accounts a
        JOIN service_plans p ON p.id=a.plan_id WHERE a.discord_id=$1`, [req.user!.id])).rows[0];
      const worker = (await database.query("SELECT 1 FROM provisioning_worker WHERE id=1 AND updated_at>NOW()-INTERVAL '30 seconds'")).rows.length > 0;
      res.json({ enabled: enabled && Boolean(plan), workerReady: enabled && Boolean(plan) && worker, domain, software: "Paper", version: "26.3", plan: plan ? {
        name: plan.name, maxServers: plan.max_servers, maxVcpus: Math.min(8, plan.max_vcpus_per_server),
        maxRamMb: Math.min(8192, plan.max_ram_mb_per_server), maxDiskGb: Math.min(64, plan.max_disk_gb_per_server),
      } : null });
    } catch (error) { next(error); }
  });
  router.get("/jobs", async (req, res, next) => {
    try { res.json((await database.query<ProvisioningJob>("SELECT * FROM provisioning_jobs WHERE owner_discord_id=$1 ORDER BY created_at DESC LIMIT 10", [req.user!.id])).rows.map(publicJob)); }
    catch (error) { next(error); }
  });
  router.post("/jobs", async (req, res, next) => {
    const origin = req.get("Origin");
    if (req.get("X-Blockhost-Request") !== "provision" || !req.is("application/json") ||
        (origin && origin !== `${req.protocol}://${req.get("host")}`)) { res.status(403).json({ error: "A same-origin creation request is required." }); return; }
    const client = await database.connect().catch(next);
    if (!client) return;
    try {
      if (!enabled) throw new ProvisioningError(503, "Automated creation is not enabled.");
      const input = creationInput(req.body);
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", ["hosting:" + req.user!.id]);
      const existing = (await client.query<ProvisioningJob>("SELECT * FROM provisioning_jobs WHERE owner_discord_id=$1 AND request_id=$2", [req.user!.id, input.requestId])).rows[0];
      if (existing) {
        if (existing.name !== input.name || existing.hostname !== input.slug + "." + domain || existing.vcpus !== input.vcpus || existing.ram_mb !== input.ramMb || existing.disk_gb !== input.diskGb) throw new ProvisioningError(409, "This request ID was already used for different server details.");
        await client.query("COMMIT"); res.status(200).json(publicJob(existing)); return;
      }
      if (!(await client.query("SELECT 1 FROM provisioning_worker WHERE id=1 AND updated_at>NOW()-INTERVAL '30 seconds'")).rows.length) throw new ProvisioningError(503, "The provisioning worker is unavailable. Try again when it is online.");
      const account = (await client.query<Plan>(`SELECT p.* FROM discord_accounts a JOIN service_plans p ON p.id=a.plan_id
        WHERE a.discord_id=$1 FOR UPDATE OF a`, [req.user!.id])).rows[0];
      const used = (await client.query<{ count: number }>(`SELECT
        ((SELECT COUNT(*) FROM hosted_servers WHERE owner_discord_id=$1) +
         (SELECT COUNT(*) FROM provisioning_jobs WHERE owner_discord_id=$1 AND
          (status IN ('queued','running') OR (status='failed' AND NOT cleanup_complete))))::int AS count`, [req.user!.id])).rows[0].count;
      enforcePlan(input, account, used);
      const hostname = input.slug + "." + domain;
      if ((await client.query("SELECT 1 FROM hosted_servers WHERE address=$1", [hostname])).rows.length) throw new ProvisioningError(409, "That hostname is already in use.");
      const result = await client.query<ProvisioningJob>(`INSERT INTO provisioning_jobs
        (id,owner_discord_id,request_id,name,hostname,vcpus,ram_mb,disk_gb)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [randomUUID(), req.user!.id, input.requestId, input.name, hostname, input.vcpus, input.ramMb, input.diskGb]);
      await client.query("COMMIT");
      res.status(202).json(publicJob(result.rows[0]));
    } catch (error) {
      try { await client.query("ROLLBACK"); }
      catch (rollbackError) { console.error("Creation rollback failed:", rollbackError instanceof Error ? rollbackError.message : "Unknown error"); }
      if (error instanceof ProvisioningError) res.status(error.status).json({ error: error.message });
      else if (error && typeof error === "object" && "code" in error && error.code === "23505") res.status(409).json({ error: "That hostname is already reserved." });
      else next(error);
    } finally { client.release(); }
  });
  return router;
}
