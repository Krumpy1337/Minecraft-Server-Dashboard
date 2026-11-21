#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { parseEnv } = require("node:util");
const { spawnSync } = require("node:child_process");

const app = "/opt/blockhost";
const installation = "/opt/blockhost-provisioner";
const configuration = "/etc/blockhost-provisioner";
const state = "/var/lib/blockhost-provisioner";
const user = "blockhost-provisioner";

function run(command, args, input) {
  const result = spawnSync(command, args, { input, encoding: "utf8", timeout: 180000 });
  if (result.error || result.status !== 0) {
    fs.writeFileSync(configuration + "/installation-error.log",
      result.error?.message || result.stderr || "Command failed without diagnostics.", { mode: 0o600 });
    throw new Error(`Installation command failed: ${command}. See ${configuration}/installation-error.log as root.`);
  }
  return result.stdout.trim();
}
function protect(directory, gid, uid = 0) {
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink()) throw new Error("Unexpected symlink in worker installation.");
  fs.chownSync(directory, uid, gid);
  fs.chmodSync(directory, stat.isDirectory() ? 0o750 : (stat.mode & 0o111) ? 0o750 : 0o640);
  if (stat.isDirectory()) for (const name of fs.readdirSync(directory)) protect(path.join(directory, name), gid, uid);
}
function updateEnvironment(original, changes) {
  let updated = original;
  for (const [key, value] of Object.entries(changes)) {
    if (!/^[A-Z_]+$/.test(key) || !/^[a-zA-Z0-9.,_-]+$/.test(value)) throw new Error("Invalid website setting.");
    const line = key + "=" + value;
    const pattern = new RegExp("^" + key + "=.*$", "m");
    updated = pattern.test(updated) ? updated.replace(pattern, line) : updated + "\n" + line + "\n";
  }
  const before = parseEnv(original), after = parseEnv(updated);
  for (const [key, value] of Object.entries(before)) {
    if (!(key in changes) && after[key] !== value) throw new Error("Existing website setting changed: " + key);
  }
  for (const [key, value] of Object.entries(changes)) {
    if (after[key] !== value) throw new Error("Website setting has conflicting definitions: " + key);
  }
  return updated;
}
function environmentFile(environment) {
  let serialized = "";
  for (const [key, value] of Object.entries(environment)) {
    if (!/^[A-Z_]+$/.test(key) || typeof value !== "string" || /[\r\n\0]/.test(value)) throw new Error("Invalid worker environment field: " + key);
    serialized += key + "=" + JSON.stringify(value) + "\n";
  }
  return serialized;
}
function updateWorker(bundle) {
  const input = JSON.parse(fs.readFileSync(bundle + "/worker-update.json", "utf8"));
  if (input.username !== "blockhost-provisioner" || !/^[a-f0-9]{64}$/.test(input.password)) throw new Error("Invalid worker gateway credential.");
  const previous = fs.readFileSync(configuration + "/worker.env", "utf8"), environment = parseEnv(previous);
  const gid = Number(run("/usr/bin/id", ["-g", user]));
  const next = installation + "/dist.next";
  if (fs.existsSync(next)) throw new Error("An incomplete code update needs inspection.");
  fs.cpSync(bundle + "/dist", next, { recursive: true, dereference: true });
  protect(next, gid);
  const backup = configuration + "/worker-before-update-" + Date.now();
  fs.writeFileSync(backup, previous, { mode: 0o600, flag: "wx" });
  if (input.cleanedValidation) {
    const validation = input.cleanedValidation;
    if (!/^[a-f0-9-]{36}$/.test(validation.id) || !Number.isInteger(validation.vmid)) throw new Error("Invalid validation cleanup identity.");
    const journalFile = state + "/" + validation.id + ".json", journal = JSON.parse(fs.readFileSync(journalFile, "utf8"));
    if (journal.id !== validation.id || journal.vmid !== validation.vmid || journal.ip !== validation.ip ||
        journal.completed !== true) throw new Error("Validation journal identity mismatch.");
    const removed = run("/usr/sbin/runuser", ["-u", "postgres", "--", "/usr/bin/psql", "-At", "-d", "blockhost"],
      `SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM hosted_servers WHERE id='${validation.id}')
       AND EXISTS(SELECT 1 FROM provisioning_jobs WHERE id='${validation.id}' AND cleanup_complete) THEN 1 ELSE 0 END;`);
    if (removed !== "1") throw new Error("Validation server is still registered or its cleanup is incomplete.");
    journal.cleaned = true;
    const stat = fs.statSync(journalFile);
    fs.writeFileSync(journalFile + ".operator-next", JSON.stringify(journal), { mode: 0o600, flag: "wx" });
    fs.chownSync(journalFile + ".operator-next", stat.uid, stat.gid);
    fs.renameSync(journalFile + ".operator-next", journalFile);
  }
  environment.SFTP_GATEWAY_API_USER = input.username;
  environment.SFTP_GATEWAY_API_PASSWORD = input.password;
  fs.writeFileSync(configuration + "/worker.env.next", environmentFile(environment), { mode: 0o600, flag: "wx" });
  run("/usr/bin/systemctl", ["stop", "blockhost-provisioner"]);
  fs.renameSync(installation + "/dist", installation + "/dist.previous-" + Date.now());
  fs.renameSync(next, installation + "/dist");
  fs.renameSync(configuration + "/worker.env.next", configuration + "/worker.env");
  fs.unlinkSync(bundle + "/worker-update.json");
  run("/usr/bin/systemctl", ["start", "blockhost-provisioner"]);
  console.log("Worker updated with a dedicated gateway credential; interrupted and incomplete cleanup jobs will be recovered.");
}
function upgradeDeletion(bundle) {
  for (const name of ["dist/server/deletions.js", "dist/server/deletion-worker.js", "dist/server/provisioner-worker.js",
    "source/app.js", "source/index.html", "provisioning-schema.sql", "adopted-servers.json"]) {
    if (!fs.statSync(bundle + "/" + name).isFile()) throw new Error("Incomplete deletion release: " + name);
  }
  const adopted = JSON.parse(fs.readFileSync(bundle + "/adopted-servers.json", "utf8"));
  if (!Array.isArray(adopted)) throw new Error("Invalid adoption records.");
  const previousAdoptions = configuration + "/adopted-servers.json";
  if (fs.existsSync(previousAdoptions)) throw new Error("Private adoption records already exist; review this upgrade manually.");
  const environmentBefore = fs.readFileSync(configuration + "/worker.env", "utf8");
  const websiteBefore = fs.readFileSync(app + "/.env", "utf8");
  const role = databaseRole(parseEnv(websiteBefore).DATABASE_URL);
  if (!/^[a-z_][a-z0-9_]*$/.test(role)) throw new Error("Unexpected website database role.");
  const busy = run("/usr/sbin/runuser", ["-u", "postgres", "--", "/usr/bin/psql", "-At", "-d", "blockhost"],
    "SELECT COUNT(*) FROM provisioning_jobs WHERE status IN ('queued','running');");
  if (busy !== "0") throw new Error("Wait for queued/running creation jobs before upgrading.");
  const gid = Number(run("/usr/bin/id", ["-g", user]));
  const next = installation + "/dist.next";
  if (fs.existsSync(next)) throw new Error("An incomplete code update needs inspection.");
  fs.cpSync(bundle + "/dist", next, { recursive: true, dereference: true });
  protect(next, gid);
  if (!adopted.every(require(next + "/server/deletion-worker.js").isDeletionTarget)) throw new Error("Invalid private adoption identity.");
  const backup = configuration + "/before-deletion-" + Date.now();
  fs.mkdirSync(backup, { mode: 0o700 });
  for (const name of ["dist", "source"]) fs.cpSync(app + "/" + name, backup + "/" + name, { recursive: true });
  run("/usr/bin/systemctl", ["stop", "blockhost", "blockhost-provisioner"]);
  run("/usr/sbin/runuser", ["-u", "postgres", "--", "/usr/bin/psql", "-v", "ON_ERROR_STOP=1", "-d", "blockhost"], `
BEGIN;
SET ROLE ${role};
${fs.readFileSync(bundle + "/provisioning-schema.sql", "utf8")}
RESET ROLE;
GRANT SELECT,INSERT,DELETE ON hosted_servers TO blockhost_provisioner;
GRANT SELECT,UPDATE ON server_deletions TO blockhost_provisioner;
COMMIT;`);
  fs.writeFileSync(previousAdoptions, JSON.stringify(adopted), { mode: 0o640, flag: "wx" });
  fs.chownSync(previousAdoptions, 0, gid);
  fs.renameSync(installation + "/dist", installation + "/dist.previous-" + Date.now());
  fs.renameSync(next, installation + "/dist");
  const siteUid = Number(run("/usr/bin/id", ["-u", "blockhost"])), siteGid = Number(run("/usr/bin/id", ["-g", "blockhost"]));
  for (const name of ["dist", "source"]) {
    fs.cpSync(bundle + "/" + name, app + "/" + name, { recursive: true });
    protect(app + "/" + name, siteGid, siteUid);
  }
  if (fs.readFileSync(configuration + "/worker.env", "utf8") !== environmentBefore ||
      fs.readFileSync(app + "/.env", "utf8") !== websiteBefore) throw new Error("Environment changed during code-only upgrade.");
  run("/usr/bin/systemctl", ["start", "blockhost", "blockhost-provisioner"]);
  run("/usr/bin/systemctl", ["is-active", "--quiet", "blockhost", "blockhost-provisioner"]);
  console.log("Deletion upgrade installed; credentials unchanged. No server deletion was requested.");
}
function main() {
  if (process.getuid() !== 0) throw new Error("Run this installer as root on the Debian website host.");
  if (typeof parseEnv !== "function") throw new Error("Node.js with util.parseEnv is required.");
  const bundle = fs.realpathSync(process.argv[2] || ".");
  if (process.argv[3] === "--upgrade-deletion") {
    upgradeDeletion(bundle);
    return;
  }
  if (process.argv[3] === "--update") {
    updateWorker(bundle);
    return;
  }
  if (bundle === app || !fs.existsSync(bundle + "/worker-input.json")) throw new Error("Provide the staged release directory.");
  if (fs.existsSync(installation) || fs.existsSync(configuration)) throw new Error("A worker installation already exists; inspect it before attempting recovery.");
  const original = fs.readFileSync(app + "/.env", "utf8"), website = parseEnv(original);
  const input = JSON.parse(fs.readFileSync(bundle + "/worker-input.json", "utf8"));
  if (!input.environment || typeof input.environment !== "object") throw new Error("Invalid staged settings.");
  const database = new URL(website.DATABASE_URL);
  if (database.hostname !== "127.0.0.1" || database.pathname !== "/blockhost" ||
      !/^[a-z_][a-z0-9_]*$/.test(database.username)) throw new Error("Unexpected website database.");
  for (const filename of ["dist/server/provisioner-worker.js", "node_modules/pg/package.json",
    "node_modules/@iarna/toml/package.json", "provisioning-schema.sql", "pve-root-ca.pem"]) {
    if (!fs.statSync(path.join(bundle, filename)).isFile()) throw new Error("Incomplete release: " + filename);
  }
  fs.mkdirSync(configuration, { mode: 0o700 });
  const role = run("/usr/sbin/runuser", ["-u", "postgres", "--", "/usr/bin/psql", "-At", "-d", "blockhost"],
    "SELECT 1 FROM pg_roles WHERE rolname='blockhost_provisioner';");
  if (role) throw new Error("Provisioner database role already exists; credentials were not replaced.");
  run("/usr/sbin/useradd", ["--system", "--user-group", "--home-dir", state, "--shell", "/usr/sbin/nologin", user]);
  const uid = Number(run("/usr/bin/id", ["-u", user])), gid = Number(run("/usr/bin/id", ["-g", user]));
  fs.mkdirSync(installation, { mode: 0o750 });
  fs.cpSync(bundle + "/dist", installation + "/dist", { recursive: true, dereference: true });
  fs.cpSync(bundle + "/node_modules", installation + "/node_modules", { recursive: true, dereference: true });
  protect(installation, gid);
  fs.mkdirSync(state, { mode: 0o700 }); fs.chownSync(state, uid, gid);
  fs.copyFileSync(bundle + "/pve-root-ca.pem", configuration + "/pve-root-ca.pem");
  fs.copyFileSync(website.SFTP_GATEWAY_CA_FILE, configuration + "/sftp-ca.pem");
  for (const filename of ["pve-root-ca.pem", "sftp-ca.pem"]) {
    fs.chownSync(configuration + "/" + filename, 0, gid); fs.chmodSync(configuration + "/" + filename, 0o640);
  }
  fs.chownSync(configuration, 0, gid); fs.chmodSync(configuration, 0o750);
  const password = crypto.randomBytes(32).toString("hex");
  database.username = "blockhost_provisioner"; database.password = password;
  const environment = {
    ...input.environment, NODE_ENV: "production", DATABASE_URL: database.toString(),
    SERVER_CREDENTIALS_KEY: website.SERVER_CREDENTIALS_KEY,
    HOSTING_STATE_DIR: state, HOSTING_PROXMOX_CA_FILE: configuration + "/pve-root-ca.pem",
    SFTP_GATEWAY_HOST: website.SFTP_GATEWAY_HOST, SFTP_GATEWAY_CA_FILE: configuration + "/sftp-ca.pem",
    SFTP_GATEWAY_API_URL: website.SFTP_GATEWAY_API_URL, SFTP_GATEWAY_API_USER: input.environment.SFTP_GATEWAY_API_USER,
    SFTP_GATEWAY_API_PASSWORD: input.environment.SFTP_GATEWAY_API_PASSWORD,
    VELOCITY_STATUS_HOST: website.VELOCITY_STATUS_HOST, VELOCITY_STATUS_PORT: website.VELOCITY_STATUS_PORT,
  };
  fs.writeFileSync(configuration + "/worker.env", environmentFile(environment), { mode: 0o600, flag: "wx" });
  const schema = fs.readFileSync(bundle + "/provisioning-schema.sql", "utf8");
  run("/usr/sbin/runuser", ["-u", "postgres", "--", "/usr/bin/psql", "-v", "ON_ERROR_STOP=1", "-d", "blockhost"], `
BEGIN;
SET ROLE ${databaseRole(website.DATABASE_URL)};
${schema}
RESET ROLE;
CREATE ROLE blockhost_provisioner LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
GRANT CONNECT ON DATABASE blockhost TO blockhost_provisioner;
GRANT USAGE ON SCHEMA public TO blockhost_provisioner;
GRANT SELECT ON service_plans,discord_accounts TO blockhost_provisioner;
GRANT SELECT,INSERT,DELETE ON hosted_servers TO blockhost_provisioner;
GRANT SELECT,UPDATE ON provisioning_jobs TO blockhost_provisioner;
GRANT SELECT,UPDATE ON server_deletions TO blockhost_provisioner;
GRANT SELECT,INSERT,UPDATE ON provisioning_worker TO blockhost_provisioner;
COMMIT;`);
  const backup = configuration + "/website-before-install";
  fs.mkdirSync(backup, { mode: 0o700 });
  for (const name of ["dist", "source", "package.json", "package-lock.json", ".env"]) {
    fs.cpSync(app + "/" + name, backup + "/" + name, { recursive: true });
  }
  for (const name of ["dist", "source", "package.json", "package-lock.json", "node_modules"]) {
    fs.cpSync(bundle + "/" + name, app + "/" + name, { recursive: true });
  }
  const changes = { HOSTING_ENABLED: "false",
    HOSTING_DOMAIN: environment.HOSTING_DOMAIN, HOSTING_IP_START: environment.HOSTING_IP_START, HOSTING_IP_END: environment.HOSTING_IP_END };
  const updated = updateEnvironment(original, changes);
  fs.writeFileSync(app + "/.env.provisioner-next", updated, { mode: 0o600, flag: "wx" });
  const siteUid = Number(run("/usr/bin/id", ["-u", "blockhost"])), siteGid = Number(run("/usr/bin/id", ["-g", "blockhost"]));
  fs.chownSync(app + "/.env.provisioner-next", siteUid, siteGid);
  fs.renameSync(app + "/.env.provisioner-next", app + "/.env");
  fs.writeFileSync("/etc/systemd/system/blockhost-provisioner.service", `[Unit]
Description=Blockhost isolated Minecraft provisioning worker
After=network-online.target postgresql.service blockhost.service
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=3

[Service]
Type=simple
User=${user}
Group=${user}
WorkingDirectory=${installation}
EnvironmentFile=${configuration}/worker.env
ExecStart=/usr/bin/node ${installation}/dist/server/provisioner-worker.js
Restart=on-failure
RestartSec=10
UMask=0077
StateDirectory=blockhost-provisioner
StateDirectoryMode=0700
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
CapabilityBoundingSet=
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
ReadWritePaths=${state}

[Install]
WantedBy=multi-user.target
`, { mode: 0o644 });
  fs.unlinkSync(bundle + "/worker-input.json");
  run("/usr/bin/systemctl", ["daemon-reload"]);
  run("/usr/bin/systemd-analyze", ["verify", "/etc/systemd/system/blockhost-provisioner.service"]);
  run("/usr/bin/systemctl", ["restart", "blockhost"]);
  run("/usr/bin/systemctl", ["enable", "--now", "blockhost-provisioner"]);
  run("/usr/bin/systemctl", ["is-active", "--quiet", "blockhost", "blockhost-provisioner"]);
  console.log("Worker installed; website creation remains disabled. Verify heartbeat and recovery before enabling plan-gated creation.");
}
function databaseRole(url) { return new URL(url).username; }
if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { updateEnvironment };
