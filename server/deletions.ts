import { RequestHandler, Router } from "express";
import { Pool } from "pg";
import { HostedServer } from "./hosted-servers";
import { ProvisioningError } from "./provisioning";

export interface DeletionJob {
  server_id: string; owner_discord_id: string; actor_discord_id: string; name: string; hostname: string;
  status: "queued" | "running" | "completed" | "failed"; stage: string; error: string | null;
  created_at: Date; updated_at: Date;
}
export const deletionSchema = `
  CREATE TABLE IF NOT EXISTS server_deletions (
    server_id TEXT PRIMARY KEY, owner_discord_id TEXT NOT NULL, actor_discord_id TEXT NOT NULL,
    name TEXT NOT NULL, hostname TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed')),
    stage TEXT NOT NULL DEFAULT 'Waiting for deletion worker', error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`;
export function publicDeletion(job: DeletionJob) {
  return { id: job.server_id, name: job.name, hostname: job.hostname, status: job.status,
    stage: job.stage, error: job.error, createdAt: job.created_at, updatedAt: job.updated_at };
}
export function createDeletionRouter(database: Pool, authenticate: RequestHandler, adminIds: Set<string>) {
  const router = Router();
  router.use(authenticate, (_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
  router.get("/deletions", async (req, res, next) => {
    try {
      const result = await database.query<DeletionJob>(
        "SELECT * FROM server_deletions WHERE owner_discord_id=$1 OR $2 ORDER BY created_at DESC LIMIT 10",
        [req.user!.id, adminIds.has(req.user!.id)]);
      res.json(result.rows.map(publicDeletion));
    } catch (error) { next(error); }
  });
  router.delete("/servers/:id", async (req, res, next) => {
    const origin = req.get("Origin");
    if (req.get("X-Blockhost-Request") !== "delete" || !req.is("application/json") ||
        (origin && origin !== `${req.protocol}://${req.get("host")}`)) {
      res.status(403).json({ error: "A same-origin deletion request is required." }); return;
    }
    const client = await database.connect().catch(next);
    if (!client) return;
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(41927)");
      const server = (await client.query<HostedServer>("SELECT * FROM hosted_servers WHERE id=$1 FOR UPDATE", [req.params.id])).rows[0];
      if (!server || (server.owner_discord_id !== req.user!.id && !adminIds.has(req.user!.id))) {
        throw new ProvisioningError(404, "Hosted server not found.");
      }
      if (req.body?.confirmAddress !== server.address) throw new ProvisioningError(400, "Type the server's full address to confirm permanent deletion.");
      const existing = (await client.query<DeletionJob>("SELECT * FROM server_deletions WHERE server_id=$1", [server.id])).rows[0];
      if (existing && existing.owner_discord_id !== server.owner_discord_id) throw new ProvisioningError(409, "Server ownership changed; an administrator must review its deletion.");
      if (existing && existing.status !== "failed") {
        await client.query("COMMIT"); res.status(202).json(publicDeletion(existing)); return;
      }
      if (!(await client.query("SELECT 1 FROM provisioning_worker WHERE id=1 AND updated_at>NOW()-INTERVAL '30 seconds'")).rows.length) {
        throw new ProvisioningError(503, "The deletion worker is unavailable. No deletion was queued.");
      }
      const result = await client.query<DeletionJob>(`INSERT INTO server_deletions(server_id,owner_discord_id,actor_discord_id,name,hostname)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(server_id) DO UPDATE
        SET status='queued',stage='Waiting for deletion worker',error=NULL,actor_discord_id=EXCLUDED.actor_discord_id,updated_at=NOW()
        RETURNING *`, [server.id, server.owner_discord_id, req.user!.id, server.name, server.address]);
      await client.query("DELETE FROM sftp_access_grants WHERE server_id=$1", [server.id]);
      await client.query("COMMIT");
      console.info("Permanent server deletion queued:", { serverId: server.id, actorId: req.user!.id });
      res.status(202).json(publicDeletion(result.rows[0]));
    } catch (error) {
      try { await client.query("ROLLBACK"); }
      catch (rollbackError) { console.error("Deletion rollback failed:", rollbackError instanceof Error ? rollbackError.message : "Unknown error"); }
      if (error instanceof ProvisioningError) res.status(error.status).json({ error: error.message });
      else next(error);
    } finally { client.release(); }
  });
  return router;
}
