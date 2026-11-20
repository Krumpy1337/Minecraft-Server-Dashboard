import "dotenv/config";
import { createCipheriv, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { utils } from "ssh2";
import { HostedServer } from "./hosted-servers";
import { gatewayUser, SftpGateway } from "./hosting-management";
import { minecraftStatus } from "./minecraft-status";
import { addressPool, creationInput, enforcePlan, Plan, ProvisioningJob } from "./provisioning";
import { Cloudflare, delay, Proxmox, provisionSsh, record, required, selectNode, velocityRoute } from "./provisioning-provider";

interface Journal {
  id: string; ip: string; vmid: number; node: string; maintenance: utils.KeyPairReturn; console: utils.KeyPairReturn;
  fingerprint?: string; route?: boolean; dns?: boolean; sftp?: boolean; completed?: boolean; cleaned?: boolean;
}
const database = new Pool({ connectionString: required("DATABASE_URL"), max: 4 });
const pve = new Proxmox();
const dns = new Cloudflare();
const gateway = new SftpGateway();
const addresses = addressPool(required("HOSTING_IP_START"), required("HOSTING_IP_END"));
const stateDirectory = required("HOSTING_STATE_DIR");
const domain = required("HOSTING_DOMAIN");
const velocityId = Number(required("HOSTING_VELOCITY_VMID"));
if (!Number.isInteger(velocityId) || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain) ||
    !/^[a-f0-9]{64}$/i.test(required("SERVER_CREDENTIALS_KEY")) ||
    !/^[a-f0-9]{64}$/i.test(required("HOSTING_FORWARDING_SECRET"))) throw new Error("Invalid provisioner credentials/domain.");
mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
function journalPath(id: string) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid job identity.");
  return path.join(stateDirectory, id + ".json");
}
function save(state: Journal) {
  const filename = journalPath(state.id);
  const descriptor = openSync(filename + ".next", "w", 0o600);
  try { writeFileSync(descriptor, JSON.stringify(state)); fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
  renameSync(filename + ".next", filename);
  const directory = openSync(stateDirectory, "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}
function isJournal(value: unknown): value is Journal {
  if (!record(value) || typeof value.id !== "string" || !Number.isInteger(value.vmid) || typeof value.ip !== "string" ||
      typeof value.node !== "string" || !pve.nodes.includes(value.node)) return false;
  for (const key of ["maintenance", "console"]) {
    const pair = value[key];
    if (!record(pair) || typeof pair.private !== "string" || typeof pair.public !== "string") return false;
  }
  return (value.fingerprint === undefined || typeof value.fingerprint === "string") &&
    ["route", "dns", "sftp", "completed", "cleaned"].every((key) => value[key] === undefined || typeof value[key] === "boolean");
}
function load(id: string): Journal | undefined {
  const filename = journalPath(id);
  if (!existsSync(filename)) return undefined;
  const result: unknown = JSON.parse(readFileSync(filename, "utf8"));
  if (!isJournal(result) || result.id !== id || !addresses.includes(result.ip)) throw new Error("Invalid private provisioning journal.");
  return result;
}
function encrypt(key: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(required("SERVER_CREDENTIALS_KEY"), "hex"), iv);
  const body = Buffer.concat([cipher.update(key, "utf8"), cipher.final()]);
  return `v1:${iv.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}:${body.toString("base64url")}`;
}
function hosted(job: ProvisioningJob, state: Journal): HostedServer {
  if (!state.fingerprint) throw new Error("Backend identity is not verified.");
  return { id: job.id, owner_discord_id: job.owner_discord_id, name: job.name, software: "Paper", version: "26.3",
    address: job.hostname, vmid: state.vmid, vcpus: job.vcpus, ram_mb: job.ram_mb, disk_gb: job.disk_gb,
    ssh_host: state.ip, ssh_host_fingerprint: state.fingerprint, encrypted_ssh_key: encrypt(state.console.private) };
}
async function stage(job: ProvisioningJob, text: string) {
  await database.query("UPDATE provisioning_jobs SET stage=$2,updated_at=NOW() WHERE id=$1 AND status='running'", [job.id, text]);
  console.info("Provisioning stage:", { jobId: job.id, stage: text });
}
async function ownedVm(state: Journal): Promise<boolean> {
  const config = await pve.config(state.vmid, state.node);
  if (config.name !== "bh-" + state.id || config.description !== "Blockhost job " + state.id || config.template) throw new Error("VM ownership did not match the private journal.");
  return true;
}
async function removeGatewayUser(username: string, token: string) {
  try { await gateway.request("DELETE", "/users/" + encodeURIComponent(username), undefined, token); }
  catch (error) {
    if (!(error instanceof Error) || !error.message.includes("HTTP 404")) throw error;
  }
}
async function cleanup(job: ProvisioningJob, state: Journal | undefined): Promise<boolean> {
  const errors: string[] = [];
  const attempt = async (label: string, action: () => Promise<unknown>) => {
    try { await action(); } catch { errors.push(label); console.error("Provisioning cleanup needs attention:", { jobId: job.id, component: label }); }
  };
  if (state) {
    if (state.dns) await attempt("DNS", () => dns.remove(job.hostname, job.id));
    if (state.route) await attempt("Velocity route", () => velocityRoute(pve, "bh-" + job.id, job.hostname, state.ip, true));
    if (state.sftp) await attempt("SFTP accounts", async () => {
      const token = await gateway.token();
      await removeGatewayUser(job.id, token);
      await removeGatewayUser("web-" + job.id, token);
    });
    await attempt("VM", async () => {
      if (!(await pve.vmExists(state.vmid, state.node))) return;
      const config = await pve.config(state.vmid, state.node);
      // A clone may still be locked/copying after an uncertain API response. Never force-unlock it.
      if (config.lock || !(await ownedVm(state))) throw new Error("VM cannot safely be removed yet.");
      const current = await pve.call("GET", pve.path(state.vmid, state.node) + "/status/current");
      if (!record(current)) throw new Error("Unknown VM state.");
      if (current.status !== "stopped") await pve.task(await pve.call("POST", pve.path(state.vmid, state.node) + "/status/stop"));
      await pve.task(await pve.call("DELETE", pve.path(state.vmid, state.node), { purge: 1, "destroy-unreferenced-disks": 1 }));
    });
    if (!errors.length) { state.cleaned = true; save(state); }
  }
  return errors.length === 0;
}
async function fail(job: ProvisioningJob, state: Journal | undefined, interrupted: boolean) {
  // Resolve an uncertain final COMMIT before any destructive cleanup.
  const current = (await database.query<ProvisioningJob>("SELECT * FROM provisioning_jobs WHERE id=$1", [job.id])).rows[0];
  if (!current) throw new Error("Provisioning job disappeared; resources retained for operator recovery.");
  if (current?.status === "completed" || (await database.query("SELECT 1 FROM hosted_servers WHERE id=$1", [job.id])).rows.length) {
    await database.query("UPDATE provisioning_jobs SET status='completed',stage='Ready',updated_at=NOW() WHERE id=$1", [job.id]);
    if (state) { state.completed = true; save(state); }
    return;
  }
  const cleaned = await cleanup(job, state);
  const message = current.status === "failed" && current.error ? current.error.replace(/ Resources remain reserved for operator recovery\.$/, "") :
    interrupted ? "Provisioner restarted before completion." : "Creation failed during " + current.stage + ".";
  await database.query(`UPDATE provisioning_jobs SET status='failed',stage=$2,error=$3,cleanup_complete=$4,updated_at=NOW() WHERE id=$1`,
    [job.id, cleaned ? "Failed; allocated resources cleaned up" : "Failed; operator cleanup required",
      message + (cleaned ? " No server was registered." : " Resources remain reserved for operator recovery."), cleaned]);
}
async function allocate(job: ProvisioningJob, node: string): Promise<Journal> {
  const registered = (await database.query<{ ssh_host: string }>(
    "SELECT ssh_host FROM hosted_servers WHERE ssh_host=ANY($1::text[])", [addresses])).rows;
  const occupied = new Set(registered.map((server) => server.ssh_host));
  for (const filename of readdirSync(stateDirectory)) {
    if (!/^[a-f0-9-]{36}\.json$/.test(filename)) continue;
    const state = load(filename.slice(0, -5));
    if (state && !state.cleaned) occupied.add(state.ip);
  }
  const ip = addresses.find((value) => !occupied.has(value));
  if (!ip) throw new Error("The reserved backend address pool is full.");
  const id = Number(await pve.call("GET", "/cluster/nextid"));
  if (!Number.isInteger(id) || id < 100 || [pve.template, velocityId, 9000].includes(id)) throw new Error("Invalid new VM ID.");
  const state: Journal = { id: job.id, vmid: id, ip, node,
    maintenance: utils.generateKeyPairSync("ed25519", { comment: "blockhost-maintenance-" + job.id }),
    console: utils.generateKeyPairSync("ed25519", { comment: "blockhost-console-" + job.id }),
  };
  save(state);
  return state;
}
async function run(job: ProvisioningJob) {
  let state: Journal | undefined;
  try {
    await stage(job, "Validating plan, capacity and hostname");
    if (!(job.eula_accepted_at instanceof Date) || !Number.isFinite(job.eula_accepted_at.getTime())) throw new Error("Missing recorded EULA acceptance.");
    const input = creationInput({ requestId: job.request_id, name: job.name, slug: job.hostname.slice(0, -(domain.length + 1)),
      vcpus: job.vcpus, ramMb: job.ram_mb, diskGb: job.disk_gb, eulaAccepted: true });
    if (job.hostname !== input.slug + "." + domain) throw new Error("Job hostname is outside the configured domain.");
    const plan = (await database.query<Plan>("SELECT p.* FROM discord_accounts a JOIN service_plans p ON p.id=a.plan_id WHERE a.discord_id=$1", [job.owner_discord_id])).rows[0];
    const used = (await database.query<{ count: number }>(`SELECT
      ((SELECT COUNT(*) FROM hosted_servers WHERE owner_discord_id=$1) +
       (SELECT COUNT(*) FROM provisioning_jobs WHERE owner_discord_id=$1 AND id<>$2 AND
        (status IN ('queued','running') OR (status='failed' AND NOT cleanup_complete))))::int AS count`, [job.owner_discord_id, job.id])).rows[0].count;
    enforcePlan(input, plan, used);
    const placement = selectNode(await pve.capacities(), job.vcpus, job.ram_mb, job.disk_gb);
    if ((await dns.records(job.hostname)).length || (await dns.records("_minecraft._tcp." + job.hostname)).length) throw new Error("Hostname already exists in DNS.");
    const templateNode = await pve.vmNode(pve.template);
    const template = await pve.config(pve.template, templateNode);
    if (template.template !== 1 || template.name !== "blockhost-paper-template-v1") throw new Error("The prepared Paper template is not available.");
    state = await allocate(job, placement.node);
    await stage(job, "Cloning a private Minecraft VM on " + state.node);
    await pve.task(await pve.call("POST", pve.path(pve.template, templateNode) + "/clone", { newid: state.vmid, name: "bh-" + job.id,
      description: "Blockhost job " + job.id, full: 1, storage: pve.storage, pool: pve.pool, target: state.node }));
    await ownedVm(state);
    await stage(job, "Waiting for cloned disks on " + state.node);
    await pve.waitForCloneDisks(state.vmid, state.node);
    await stage(job, "Configuring resources and starting the private Minecraft VM on " + state.node);
    await pve.call("PUT", pve.path(state.vmid, state.node) + "/config", {
      cores: job.vcpus, memory: job.ram_mb, balloon: 0, onboot: 1, ciuser: "mcdeploy",
      sshkeys: encodeURIComponent(state.maintenance.public), ipconfig0: `ip=${state.ip}/24,gw=${required("HOSTING_GATEWAY_IP")}`,
      nameserver: "1.1.1.1 1.0.0.1",
    });
    if (job.disk_gb > 32) await pve.call("PUT", pve.path(state.vmid, state.node) + "/resize", { disk: "ide0", size: `+${job.disk_gb - 32}G` });
    await pve.task(await pve.call("POST", pve.path(state.vmid, state.node) + "/status/start"));
    await stage(job, "Waiting for Cloud-Init and verified SSH identity");
    for (let attempt = 0; attempt < 90; attempt++) {
      try {
        const output = await pve.guest(state.vmid, "test -f /var/lib/cloud/instance/boot-finished && ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256", state.node);
        const fingerprint = output.match(/SHA256:([A-Za-z0-9+/]{43})/);
        if (!fingerprint) throw new Error("Guest identity was not returned.");
        state.fingerprint = fingerprint[1]; save(state); break;
      } catch {
        if (attempt === 89) throw new Error("Guest initialization did not complete.");
        await delay(3000);
      }
    }
    if (!state.fingerprint) throw new Error("Guest identity is unavailable.");
    await stage(job, "Configuring Paper, private SFTP and restricted console");
    await provisionSsh(state.ip, state.fingerprint, state.maintenance.private, {
      jobId: job.id, eulaAccepted: true, eulaAcceptedAt: job.eula_accepted_at.toISOString(),
      hostname: job.hostname, ramMb: job.ram_mb, diskGb: job.disk_gb, publicKey: state.console.public,
      websiteIp: required("HOSTING_WEBSITE_IP"), sftpIp: required("SFTP_GATEWAY_HOST"), velocityIp: required("VELOCITY_STATUS_HOST"),
      forwardingSecret: required("HOSTING_FORWARDING_SECRET"),
    });
    const server = hosted(job, state);
    await stage(job, "Creating isolated file gateway accounts");
    state.sftp = true; save(state);
    const token = await gateway.token();
    await gateway.request("POST", "/users", gatewayUser(server, state.console.private, [state.console.public], true), token);
    await gateway.request("POST", "/users", gatewayUser(server, state.console.private, [], false), token);
    await stage(job, "Adding Velocity route without restarting existing servers");
    state.route = true; save(state);
    await velocityRoute(pve, "bh-" + job.id, job.hostname, state.ip);
    await stage(job, "Verifying the routed Paper server");
    for (let attempt = 0; attempt < 90; attempt++) {
      try { await minecraftStatus(required("VELOCITY_STATUS_HOST"), Number(required("VELOCITY_STATUS_PORT")), job.hostname, job.hostname); break; }
      catch { if (attempt === 89) throw new Error("Routed Minecraft readiness check failed."); await delay(2000); }
    }
    await stage(job, "Publishing DNS and registering your server");
    state.dns = true; save(state);
    await dns.create("A", job.hostname, job.id);
    await dns.create("SRV", job.hostname, job.id);
    const client = await database.connect();
    try {
      await client.query("BEGIN");
      await client.query(`INSERT INTO hosted_servers
        (id,owner_discord_id,name,software,version,address,vmid,vcpus,ram_mb,disk_gb,ssh_host,ssh_host_fingerprint,encrypted_ssh_key)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [
        server.id, server.owner_discord_id, server.name, server.software, server.version, server.address,
        server.vmid, server.vcpus, server.ram_mb, server.disk_gb, server.ssh_host, server.ssh_host_fingerprint, server.encrypted_ssh_key,
      ]);
      await client.query("UPDATE provisioning_jobs SET status='completed',stage='Ready',updated_at=NOW() WHERE id=$1", [job.id]);
      await client.query("COMMIT");
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { console.error("Final registration rollback failed:", job.id); }
      throw error;
    } finally { client.release(); }
    state.completed = true; save(state);
    console.info("Minecraft server provisioned:", { jobId: job.id, vmid: state.vmid, node: state.node });
  } catch (error) {
    console.error("Provisioning failed:", { jobId: job.id, reason: error instanceof Error ? error.message : "Unknown error" });
    await fail(job, state, false);
  }
}
async function main() {
  const lock = await database.connect();
  let timer: NodeJS.Timeout | undefined;
  try {
    const acquired = (await lock.query<{ acquired: boolean }>("SELECT pg_try_advisory_lock(41928) AS acquired")).rows[0].acquired;
    if (!acquired) throw new Error("Another provisioner is already running.");
    await pve.capacities();
    const heartbeat = async () => { await database.query("INSERT INTO provisioning_worker(id) VALUES(1) ON CONFLICT(id) DO UPDATE SET updated_at=NOW()"); };
    timer = setInterval(() => { void heartbeat().catch(() => { console.error("Provisioner heartbeat failed."); }); }, 5000);
    const interrupted = (await database.query<ProvisioningJob>(
      "SELECT * FROM provisioning_jobs WHERE status='running' OR (status='failed' AND NOT cleanup_complete) ORDER BY created_at")).rows;
    for (const job of interrupted) await fail(job, load(job.id), job.status === "running");
    await heartbeat();
    for (;;) {
      const job = (await database.query<ProvisioningJob>(`UPDATE provisioning_jobs SET status='running',stage='Starting',updated_at=NOW()
        WHERE id=(SELECT id FROM provisioning_jobs WHERE status='queued' ORDER BY created_at LIMIT 1) RETURNING *`)).rows[0];
      if (job) await run(job); else await delay(2000);
    }
  } finally { clearInterval(timer); lock.release(); await database.end(); }
}
main().catch((error: unknown) => { console.error("Provisioner stopped:", error instanceof Error ? error.message : "Unknown error"); process.exitCode = 1; });
