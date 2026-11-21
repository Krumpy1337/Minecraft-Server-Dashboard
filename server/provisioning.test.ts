import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { rootCertificates } from "node:tls";
import { PassThrough, Readable } from "node:stream";
import https = require("node:https");
import express from "express";
import { once } from "node:events";
import { AddressInfo } from "node:net";
import { Pool } from "pg";
import * as TOML from "@iarna/toml";
import { addressPool, createProvisioningRouter, creationInput, enforcePlan } from "./provisioning";
import { changeVelocityRoute, InfrastructureApi, NodeCapacity, Proxmox, selectNode, velocityRoute } from "./provisioning-provider";

const request = { requestId: "12345678-1234-4123-8123-123456789abc", name: " My server ", slug: "my-server",
  vcpus: 4, ramMb: 4096, diskGb: 32, eulaAccepted: true };
const plan = { max_servers: 2, max_vcpus_per_server: 6, max_ram_mb_per_server: 8192, max_disk_gb_per_server: 40 };
test("creation requires explicit consent, bounded resources and an isolated hostname", () => {
  assert.equal(creationInput(request).name, "My server");
  for (const change of [{ eulaAccepted: false }, { eulaAccepted: "true" }, { slug: "test" }, { slug: "../other" },
    { slug: "other.example" }, { requestId: "not-an-id" }, { ramMb: 2049 }, { vcpus: 9 }, { diskGb: 31 },
    { software: "Fabric" }, { name: "name\nstop" }]) assert.throws(() => creationInput({ ...request, ...change }));
  assert.doesNotThrow(() => enforcePlan(creationInput(request), plan, 1));
  assert.throws(() => enforcePlan(creationInput(request), plan, 2), /pending/);
  assert.throws(() => enforcePlan(creationInput({ ...request, diskGb: 48 }), plan, 0), /resources/);
  assert.throws(() => enforcePlan(creationInput(request), undefined, 0), /assigned/);
});
test("provisioning address reservations stay inside one explicitly bounded network", () => {
  const pool = addressPool("10.0.0.201", "10.0.0.220");
  assert.equal(pool.length, 20);
  assert.equal(pool[19], "10.0.0.220");
  for (const [start, end] of [["10.0.0.1", "10.0.0.4"], ["10.0.0.201", "10.0.1.220"], ["10.0.0.220", "10.0.0.201"], ["::1", "::2"]]) {
    assert.throws(() => addressPool(start, end));
  }
});
const capacity: NodeCapacity = { node: "pve02", cpus: 32, cpu: 0.1, totalRamMb: 65536, freeRamMb: 49152, freeDiskGb: 100 };
test("placement spreads work using both projected CPU and RAM pressure", () => {
  assert.equal(selectNode([{ ...capacity, cpu: 0.7 }, { ...capacity, node: "pve03" }], 4, 4096, 32).node, "pve03");
  assert.equal(selectNode([{ ...capacity, freeRamMb: 8192 }, { ...capacity, node: "pve03" }], 4, 4096, 32).node, "pve03");
  assert.equal(selectNode([{ ...capacity, node: "pve03", cpu: 0.7 }, capacity], 4, 4096, 32).node, "pve02");
  assert.equal(selectNode([capacity, { ...capacity, node: "pve03", cpu: 0, freeRamMb: capacity.freeRamMb - 128 }], 4, 4096, 32).node, "pve03");
});
test("placement rejects insufficient CPU, RAM headroom or shared disk space", () => {
  for (const candidate of [{ ...capacity, cpus: 2 }, { ...capacity, cpu: 0.9 },
    { ...capacity, freeRamMb: 6143 }, { ...capacity, freeDiskGb: 33 }]) {
    assert.throws(() => selectNode([candidate], 4, 4096, 32), /Neither/);
  }
  assert.equal(selectNode([{ ...capacity, freeRamMb: 6144, freeDiskGb: 34 }], 4, 4096, 32).node, "pve02");
});
test("Proxmox DELETE parameters use the query string, never a rejected request body", async (t) => {
  const calls: Array<{ url: URL; body: string }> = [];
  t.mock.method(https, "request", (url: URL, _options: unknown, callback: (response: Readable & { statusCode: number }) => void) => {
    const request = new PassThrough();
    const captured = { url, body: "" };
    calls.push(captured);
    request.on("data", (chunk: Buffer) => { captured.body += chunk.toString(); });
    queueMicrotask(() => callback(Object.assign(Readable.from(['{"data":null}']), { statusCode: 200 })));
    return request;
  });
  const api = new InfrastructureApi(new URL("https://proxmox.example.invalid/api2/json"), "fixture");
  await api.call("DELETE", "/nodes/pve03/qemu/120", { purge: 1, "destroy-unreferenced-disks": 1 }, true);
  assert.equal(calls[0].url.searchParams.get("purge"), "1");
  assert.equal(calls[0].url.searchParams.get("destroy-unreferenced-disks"), "1");
  assert.equal(calls[0].body, "");
});
test("cross-node VM and task operations follow their actual nodes; incomplete audit never silently falls back", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "blockhost-placement-"));
  const certificate = path.join(directory, "ca.pem");
  writeFileSync(certificate, rootCertificates[0]);
  const settings = { HOSTING_PROXMOX_NODES: "pve02,pve03", HOSTING_PROXMOX_URL: "https://proxmox.example.invalid/api2/json",
    HOSTING_PROXMOX_TLS_NAME: "proxmox.example.invalid", HOSTING_PROXMOX_CA_FILE: certificate,
    HOSTING_PROXMOX_TOKEN_ID: "fixture", HOSTING_PROXMOX_TOKEN_SECRET: "fixture" };
  const previous = Object.fromEntries(Object.keys(settings).map((key) => [key, process.env[key]]));
  Object.assign(process.env, settings);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(certificate); rmdirSync(directory);
  });
  const pve = new Proxmox();
  const calls: string[] = [];
  t.mock.method(pve, "call", async (_method: string, suffix: string) => {
    calls.push(suffix);
    if (suffix === "/cluster/resources?type=vm") return [{ vmid: 9001, type: "qemu", node: "pve03" }];
    if (suffix.endsWith("/config")) return { template: 1 };
    if (suffix.endsWith("/status") && suffix.includes("/tasks/")) return { status: "stopped", exitstatus: "OK" };
    throw new Error("Permission denied on pve03.");
  });
  await pve.config(9001, await pve.vmNode(9001));
  await pve.task("UPID:pve03:0001:fixture");
  assert.ok(calls.includes("/nodes/pve03/qemu/9001/config"));
  assert.ok(calls.some((call) => call.startsWith("/nodes/pve03/tasks/")));
  await assert.rejects(pve.task("UPID:pve04:0001:fixture"), /out-of-scope/);
  await assert.rejects(pve.capacities(), /Permission denied/);
  t.mock.method(pve, "call", async () => []);
  assert.equal(await pve.vmExists(120, "pve03"), false);
  t.mock.method(pve, "call", async () => [{ vmid: 120, type: "qemu", node: "pve02" }]);
  await assert.rejects(pve.vmExists(120, "pve03"), /differs/);
  t.mock.method(pve, "call", async () => [{ vmid: 120, type: "qemu", node: "pve03" }]);
  assert.equal(await pve.vmExists(120, "pve03"), true);
  t.mock.method(pve, "call", async () => [{ invalid: true }]);
  await assert.rejects(pve.vmExists(120, "pve03"), /Invalid/);
  process.env.HOSTING_VELOCITY_VMID = "116";
  t.after(() => { delete process.env.HOSTING_VELOCITY_VMID; });
  t.mock.method(pve, "vmNode", async () => "pve03");
  let update = "";
  t.mock.method(pve, "guest", async (_id: number, script: string) => {
    if (script.startsWith("cat ")) return '[servers]\ntry=[]\n[forced-hosts]\n';
    update = script;
    throw new Error("Write failed");
  });
  await assert.rejects(velocityRoute(pve, "bh-new", "new.krumpy.xyz", "10.0.0.202"), /Write failed/);
  assert.ok(update.startsWith("set -euo pipefail\n/usr/bin/python3"));
  assert.ok(!update.includes("/usr/bin/node"));
});
test("proxy route updates preserve existing servers and refuse route/hostname collisions", () => {
  const before = `[servers]\ntry=[]\ntest="10.0.0.102:25565"\n[forced-hosts]\n"test.krumpy.xyz"=["test"]\n[advanced]\n"connection-timeout"=5000\n`;
  const after = changeVelocityRoute(before, "bh-new", "new.krumpy.xyz", "10.0.0.201", false);
  const config = TOML.parse(after);
  assert.deepEqual(TOML.parse(changeVelocityRoute(after, "bh-new", "new.krumpy.xyz", "10.0.0.201", true)), TOML.parse(before));
  assert.deepEqual(config.advanced, TOML.parse(before).advanced);
  assert.throws(() => changeVelocityRoute(before, "test", "new.krumpy.xyz", "10.0.0.201", false), /differs/);
  assert.throws(() => changeVelocityRoute(before, "bh-new", "test.krumpy.xyz", "10.0.0.201", true), /another/);
  assert.throws(() => changeVelocityRoute(before.replace("try=[]", 'try=["test"]'), "bh-new", "new.krumpy.xyz", "10.0.0.201", false), /isolated/);
  assert.throws(() => changeVelocityRoute(before, "test", "different.krumpy.xyz", "10.0.0.102", true), /shared/);
});

test("provisioning requires an administrator-assigned plan for both availability and creation", async (t) => {
  const owner = "477366778453032981", other = "477366778453032982";
  const settings = { HOSTING_ENABLED: "true" };
  const previous = Object.fromEntries(Object.keys(settings).map((key) => [key, process.env[key]]));
  Object.assign(process.env, settings);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const pool = new Pool();
  const statements: string[] = [];
  t.mock.method(pool, "query", async (sql: string, values?: unknown[]) => {
    statements.push(sql);
    if (sql.includes("service_plans")) return { rows: values?.[0] === owner ? [{ ...plan, name: "Test plan" }] : [] };
    if (sql.includes("COUNT")) return { rows: [{ count: 0 }] };
    return { rows: sql.includes("FROM provisioning_worker") ? [{ ready: 1 }] : [] };
  });
  t.mock.method(pool, "connect", async () => ({ query: pool.query.bind(pool), release() {} }));
  const app = express();
  app.use(express.json(), createProvisioningRouter(pool, (req, res, next) => {
    const id = req.get("X-Test-User");
    if (!id) { res.sendStatus(401); return; }
    req.user = { id, username: id, avatar: null };
    next();
  }));
  const listener = app.listen(0, "127.0.0.1");
  await once(listener, "listening");
  t.after(() => new Promise<void>((resolve, reject) => {
    listener.close(error => error ? reject(error) : resolve());
    listener.closeIdleConnections();
  }));
  const url = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  assert.equal((await fetch(url + "/config")).status, 401);
  assert.equal((await (await fetch(url + "/config", { headers: { "X-Test-User": owner } })).json()).enabled, true);
  const hidden = await (await fetch(url + "/config", { headers: { "X-Test-User": other } })).json();
  assert.equal(hidden.enabled, false); assert.equal(hidden.workerReady, false);
  const denied = await fetch(url + "/jobs", { method: "POST",
    headers: { "X-Test-User": other, "Content-Type": "application/json", "X-Blockhost-Request": "provision" },
    body: JSON.stringify(request) });
  assert.equal(denied.status, 403);
  assert.ok(!statements.some(sql => sql.includes("INSERT INTO provisioning_jobs")));
});
