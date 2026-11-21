import assert from "node:assert/strict";
import { once } from "node:events";
import { AddressInfo } from "node:net";
import test, { TestContext } from "node:test";
import express from "express";
import { Pool } from "pg";
import { createDeletionRouter, DeletionJob } from "./deletions";
import { deleteServerResources, DeletionTarget } from "./deletion-worker";
import { HostedServer } from "./hosted-servers";

const server: HostedServer = { id: "test-server", owner_discord_id: "owner", name: "Test", software: "Paper", version: "26.3",
  address: "test.krumpy.xyz", vmid: 121, vcpus: 4, ram_mb: 4096, disk_gb: 32, ssh_host: "10.0.0.202",
  ssh_host_fingerprint: "pin", encrypted_ssh_key: "never-public" };
const target: DeletionTarget = { id: server.id, owner: "owner", hostname: server.address, ip: server.ssh_host,
  fingerprint: "pin", vmid: 121, node: "pve03", vmName: "bh-private-job", vmDescription: "Blockhost job private-job",
  routeKey: "bh-private-job", dnsRecords: [{ id: "dns-id", name: server.address, comment: "owned" }] };

async function harness(t: TestContext) {
  const pool = new Pool();
  const statements: string[] = [];
  let ready = true, job: DeletionJob | undefined;
  t.mock.method(pool, "query", async (sql: string, values?: unknown[]) => {
    statements.push(sql);
    if (sql.includes("FROM hosted_servers")) return { rows: values?.[0] === server.id ? [server] : [] };
    if (sql.includes("FROM provisioning_worker")) return { rows: ready ? [{}] : [] };
    if (sql.includes("INSERT INTO server_deletions")) {
      job = { server_id: server.id, owner_discord_id: "owner", actor_discord_id: String(values?.[2]), name: server.name,
        hostname: server.address, status: "queued", stage: "Waiting for deletion worker", error: null,
        created_at: new Date(), updated_at: new Date() };
      return { rows: [job] };
    }
    return { rows: sql.includes("FROM server_deletions") && job ? [job] : [] };
  });
  t.mock.method(pool, "connect", async () => ({ query: pool.query.bind(pool), release() {} }));
  const app = express();
  app.use(express.json(), createDeletionRouter(pool, (req, res, next) => {
    const id = req.get("X-Test-User");
    if (!id) { res.sendStatus(401); return; }
    req.user = { id, username: id, avatar: null }; next();
  }, new Set(["admin"])));
  const listener = app.listen(0, "127.0.0.1");
  await once(listener, "listening");
  t.after(() => new Promise<void>((resolve, reject) => {
    listener.close(error => error ? reject(error) : resolve()); listener.closeIdleConnections();
  }));
  const url = `http://127.0.0.1:${(listener.address() as AddressInfo).port}/servers/${server.id}`;
  const request = (user = "owner", address = server.address, headers: Record<string, string> = {}) => fetch(url, {
    method: "DELETE", headers: { "X-Test-User": user, "Content-Type": "application/json", "X-Blockhost-Request": "delete", ...headers },
    body: JSON.stringify({ confirmAddress: address }),
  });
  return { request, statements, offline() { ready = false; }, fail() { if (job) job.status = "failed"; } };
}
test("permanent deletion requires authentication, ownership, exact address and same-origin JSON", async t => {
  const { request, statements } = await harness(t);
  assert.equal((await request("")).status, 401);
  assert.equal((await request("other")).status, 404);
  assert.equal((await request("owner", "wrong.krumpy.xyz")).status, 400);
  assert.equal((await request("owner", server.address, { Origin: "https://evil.example" })).status, 403);
  assert.equal((await request("owner", server.address, { "X-Blockhost-Request": "" })).status, 403);
  assert.equal(statements.some(sql => sql.includes("INSERT INTO server_deletions")), false);
  assert.equal((await request("admin")).status, 202);
});
test("deletion needs a healthy worker, not a plan; duplicate requests are idempotent and failures retry", async t => {
  const h = await harness(t);
  const response = await h.request();
  assert.equal(response.status, 202);
  const result = await response.json();
  assert.equal(result.id, server.id); assert.equal(result.encrypted_ssh_key, undefined);
  assert.ok(h.statements.some(sql => sql.includes("DELETE FROM sftp_access_grants")));
  assert.equal(h.statements.some(sql => sql.includes("DELETE FROM hosted_servers") || sql.includes("service_plans")), false);
  h.offline();
  assert.equal((await h.request()).status, 202);
  assert.equal(h.statements.filter(sql => sql.includes("INSERT INTO server_deletions")).length, 1);
  h.fail();
  assert.equal((await h.request()).status, 503);
});
test("failed deletion can be explicitly requeued without releasing server registration", async t => {
  const h = await harness(t);
  await h.request(); h.fail();
  assert.equal((await h.request()).status, 202);
  assert.equal(h.statements.filter(sql => sql.includes("INSERT INTO server_deletions")).length, 2);
  assert.equal(h.statements.some(sql => sql.includes("DELETE FROM hosted_servers")), false);
});

function resources() {
  const removed: string[] = [];
  let present = true;
  const config: Record<string, unknown> = { name: target.vmName, description: target.vmDescription,
    ide0: "truenas:121/vm-121-disk-0.qcow2", ide2: "truenas:121/vm-121-cloudinit.qcow2" };
  const users = new Map([server.id, "web-" + server.id].map(username => [username, { username,
    additional_info: "owner", filesystem: { sftpconfig: { endpoint: server.ssh_host + ":22", fingerprints: ["SHA256:pin"] } } }]));
  const dnsRecords = target.dnsRecords.map(entry => ({ ...entry }));
  const dependencies: Parameters<typeof deleteServerResources>[2] = {
    pve: {
      async config() { return config; }, async vmExists() { return present; }, path(id, node) { return `/nodes/${node}/qemu/${id}`; },
      async vmNode() { return "pve02"; },
      async guest() { return `[servers]\ntry=[]\n"${target.routeKey}"="${target.ip}:25565"\n[forced-hosts]\n"${target.hostname}"=["${target.routeKey}"]\n`; },
      async call(method, path) {
        if (method === "GET") return { status: "running" };
        removed.push(method + " " + path);
        if (method === "DELETE") present = false;
        return "UPID:pve03:task";
      },
      async task() {},
    },
    dns: { async records(name) { return dnsRecords.filter(entry => entry.name === name); },
      async deleteRecord(entry) { removed.push("dns:" + entry.id); dnsRecords.splice(dnsRecords.findIndex(item => item.id === entry.id), 1); } },
    gateway: { async token() { return "token"; }, async request(method, path) {
      const username = decodeURIComponent(path.slice("/users/".length));
      if (method === "DELETE") { removed.push("sftp:" + username); users.delete(username); return null; }
      if (!users.has(username)) throw new Error("HTTP 404");
      return users.get(username);
    }, async updateUser() { removed.push("revoke-sftp"); } },
    velocityId: 116, protectedVmids: [116, 119, 9000, 9001],
    async route() { removed.push("velocity"); }, async stage() {},
  };
  return { dependencies, config, users, dnsRecords, removed };
}
test("resource teardown refuses foreign VM, disk, DNS or SFTP identities before deleting anything", async () => {
  for (const tamper of [
    (r: ReturnType<typeof resources>) => { r.config.name = "unrelated"; },
    (r: ReturnType<typeof resources>) => { r.config.ide0 = "truenas:118/other-server.qcow2"; },
    (r: ReturnType<typeof resources>) => { r.dnsRecords[0].comment = "another owner"; },
    (r: ReturnType<typeof resources>) => { r.users.get(server.id)!.additional_info = "another-owner"; },
    (r: ReturnType<typeof resources>) => { r.users.get(server.id)!.filesystem.sftpconfig.fingerprints = ["SHA256:wrong"]; },
  ]) {
    const r = resources(); tamper(r);
    await assert.rejects(deleteServerResources(server, target, r.dependencies));
    assert.deepEqual(r.removed, []);
  }
  const r = resources();
  r.dependencies.protectedVmids.push(server.vmid);
  await assert.rejects(deleteServerResources(server, target, r.dependencies), /protected/);
  await assert.rejects(deleteServerResources({ ...server, owner_discord_id: "changed" }, target, resources().dependencies), /identity/);
  assert.deepEqual(r.removed, []);
});
test("teardown revokes access, removes routing and deletes disks; completed steps are restart-safe", async () => {
  const r = resources();
  await deleteServerResources(server, target, r.dependencies);
  assert.equal(r.removed[0], "revoke-sftp");
  assert.ok(r.removed.includes("dns:dns-id"));
  assert.ok(r.removed.indexOf("velocity") < r.removed.findIndex(value => value.startsWith("DELETE /nodes/")));
  assert.ok(r.removed.includes("DELETE /nodes/pve03/qemu/121"));
  r.removed.length = 0;
  await deleteServerResources(server, target, r.dependencies);
  assert.deepEqual(r.removed, ["velocity"]);
});
test("partial teardown failure remains explicit and retry removes only remaining resources", async () => {
  const r = resources(), remove = r.dependencies.dns.deleteRecord;
  r.dependencies.dns.deleteRecord = async () => { throw new Error("DNS unavailable"); };
  await assert.rejects(deleteServerResources(server, target, r.dependencies), /DNS unavailable/);
  assert.equal(r.users.size, 0);
  assert.equal(r.removed.some(value => value.startsWith("DELETE /nodes/")), false);
  r.dependencies.dns.deleteRecord = remove;
  await deleteServerResources(server, target, r.dependencies);
  assert.ok(r.removed.includes("DELETE /nodes/pve03/qemu/121"));
});
test("only operator-adopted legacy web users may lack an owner marker", async () => {
  const r = resources();
  const username = "web-" + server.id;
  Reflect.deleteProperty(r.users.get(username)!, "additional_info");
  await assert.rejects(deleteServerResources(server, target, r.dependencies), /SFTP ownership/);
  assert.equal(r.removed.length, 0);
  await deleteServerResources(server, { ...target, legacyWebUserWithoutOwner: true }, r.dependencies);
  assert.ok(r.removed.includes("sftp:" + username));
});
