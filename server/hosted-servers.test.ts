import assert from "node:assert/strict";
import { once } from "node:events";
import { AddressInfo } from "node:net";
import test, { TestContext } from "node:test";
import express from "express";
import { ConsoleOperation, createHostedServersRouter, HostedServer } from "./hosted-servers";

const server: HostedServer = {
  id: "test-server", owner_discord_id: "owner", name: "Test", software: "Paper",
  version: "26.3", address: "test.krumpy.xyz", vmid: 118, vcpus: 4, ram_mb: 4096,
  disk_gb: 32, ssh_host: "10.0.0.102", ssh_host_fingerprint: "private-fingerprint",
  encrypted_ssh_key: "encrypted-private-key",
};

async function harness(t: TestContext, output = "active\nMinecraft server output\n", fail = false, deletionStatus?: HostedServer["deletion_status"]) {
  const calls: Array<{ operation: ConsoleOperation; command?: string }> = [];
  const app = express();
  app.use(express.json());
  const management = express.Router();
  management.use((_req, res) => { res.json({ management: true }); });
  app.use("/api/hosted/servers", createHostedServersRouter({
    management,
    database: {
      async query(sql, values) {
        return { rows: sql.includes("WHERE id =")
          ? values[0] === server.id ? [{ ...server, deletion_status: deletionStatus }] : []
          : values[0] === server.owner_discord_id || values[1] === true ? [{ ...server, deletion_status: deletionStatus }] : [] };
      },
    },
    requireAuthenticated(req, res, next) {
      const id = req.get("X-Test-User");
      if (!id) { res.status(401).json({ error: "Authentication required." }); return; }
      req.user = { id, username: id, avatar: null };
      next();
    },
    adminIds: new Set(["admin"]), allowedHosts: new Set([server.ssh_host]),
    credentialsConfigured: true, decryptPrivateKey: () => "private-key",
    async execute(_server, _key, operation, command) {
      if (fail) throw new Error("Connection refused.");
      calls.push({ operation, command });
      return operation === "logs" ? output : "";
    },
  }));
  const listener = app.listen(0, "127.0.0.1");
  await once(listener, "listening");
  t.after(() => new Promise<void>((resolve, reject) => {
    listener.close((error) => error ? reject(error) : resolve());
    listener.closeIdleConnections();
  }));
  const url = `http://127.0.0.1:${(listener.address() as AddressInfo).port}/api/hosted/servers`;
  const request = (suffix: string, user?: string, body?: unknown, extra: Record<string, string> = {}) => fetch(url + suffix, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(user ? { "X-Test-User": user } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json", "X-Blockhost-Request": "console" }),
      ...extra,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  return { request, calls };
}

test("queued and failed deletions block console, power and all management routes even for admins", async t => {
  for (const status of ["queued", "failed"] as const) {
    const { request, calls } = await harness(t, undefined, false, status);
    for (const user of ["owner", "admin"]) {
      for (const suffix of ["/console", "/files", "/sftp/access", "/settings", "/metrics"]) {
        assert.equal((await request("/test-server" + suffix, user)).status, 409);
      }
      assert.equal((await request("/test-server/power", user, { action: "start" })).status, 409);
    }
    const rows = await (await request("", "owner")).json();
    assert.equal(rows[0].deletionStatus, status);
    assert.deepEqual(calls, []);
  }
});

test("console requires authentication and server ownership, with explicit admin access", async (t) => {
  const { request, calls } = await harness(t);
  assert.equal((await request("/test-server/console")).status, 401);
  assert.equal((await request("/test-server/console", "other")).status, 404);
  assert.equal((await request("/test-server/commands", "other", { command: "stop" })).status, 404);
  assert.deepEqual(await (await request("", "other")).json(), []);
  assert.equal(calls.length, 0);
  const owner = await request("/test-server/console", "owner");
  assert.equal(owner.status, 200);
  assert.equal(owner.headers.get("cache-control"), "no-store");
  assert.deepEqual(await owner.json(), { state: "active", output: "Minecraft server output\n" });
  assert.equal((await request("/test-server/console", "admin")).status, 200);
});

test("server listing never returns console credentials or private connection details", async (t) => {
  const { request } = await harness(t);
  const response = await request("", "owner");
  assert.equal(response.status, 200);
  const rows = await response.json() as Array<Record<string, unknown>>;
  assert.equal(rows[0].address, server.address);
  assert.equal(rows[0].ramMb, 4096);
  for (const key of ["encrypted_ssh_key", "ssh_host", "ssh_host_fingerprint", "owner_discord_id"]) {
    assert.equal(key in rows[0], false);
  }
});

test("nested file, SFTP, settings and metrics routes inherit ownership and authentication", async (t) => {
  const { request } = await harness(t);
  for (const suffix of ["/metrics", "/files", "/files/content", "/settings", "/sftp", "/sftp/keys", "/sftp/access"]) {
    assert.equal((await request("/test-server" + suffix)).status, 401);
    assert.equal((await request("/test-server" + suffix, "other")).status, 404);
    assert.equal((await request("/test-server" + suffix, "owner")).status, 200);
    assert.equal((await request("/test-server" + suffix, "admin")).status, 200);
  }
});

test("commands require same-origin JSON and reject multiline/control input", async (t) => {
  const { request, calls } = await harness(t);
  assert.equal((await request("/test-server/commands", "owner", { command: "list" }, { "X-Blockhost-Request": "" })).status, 403);
  assert.equal((await request("/test-server/commands", "owner", { command: "list" }, { Origin: "https://untrusted.example" })).status, 403);
  for (const command of ["", "/", "say hi\nstop", "say hi\rstop", "say \0", "x".repeat(513)]) {
    assert.equal((await request("/test-server/commands", "owner", { command })).status, 400);
  }
  assert.equal(calls.length, 0);
  const command = "say $(id); this is Minecraft text, not a shell";
  assert.equal((await request("/test-server/commands", "owner", { command: `/${command}` })).status, 202);
  assert.deepEqual(calls, [{ operation: "command", command }]);
});

test("command burst is bounded and power actions cannot select arbitrary SSH commands", async (t) => {
  const { request, calls } = await harness(t);
  assert.equal((await request("/test-server/power", "owner", { action: "id" })).status, 400);
  assert.equal((await request("/test-server/power", "owner", { action: "restart" })).status, 200);
  assert.equal(calls[0].operation, "restart");
  for (let index = 0; index < 8; index++) {
    assert.equal((await request("/test-server/commands", "owner", { command: "list" })).status, 202);
  }
  const limited = await request("/test-server/commands", "owner", { command: "list" });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
});

test("malformed remote console responses are surfaced as errors", async (t) => {
  const { request } = await harness(t, "not-a-service-state\noutput");
  assert.equal((await request("/test-server/console", "owner")).status, 502);
});

test("SSH failures return explicit errors rather than claiming commands succeeded", async (t) => {
  const { request } = await harness(t, "", true);
  for (const [suffix, body] of [
    ["/console", undefined],
    ["/commands", { command: "list" }],
    ["/power", { action: "start" }],
  ] as const) {
    const response = await request(`/test-server${suffix}`, "owner", body);
    assert.equal(response.status, 502);
    const result = await response.json() as { error?: string; accepted?: boolean };
    assert.equal(typeof result.error, "string");
    assert.equal(result.accepted, undefined);
  }
});
