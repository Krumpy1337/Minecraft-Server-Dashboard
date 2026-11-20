import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { request } from "node:https";
import * as TOML from "@iarna/toml";
import { Client } from "ssh2";
import { sshOptions } from "./hosted-servers";

export function record(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
export const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export interface NodeCapacity {
  node: string; cpu: number; cpus: number; totalRamMb: number; freeRamMb: number; freeDiskGb: number;
}
export function selectNode(candidates: NodeCapacity[], vcpus: number, ramMb: number, diskGb: number): NodeCapacity {
  const eligible = candidates.filter((candidate) => candidate.cpus >= vcpus &&
    candidate.cpu + vcpus / candidate.cpus <= 1 &&
    candidate.freeRamMb >= ramMb + 2048 && candidate.freeDiskGb >= diskGb + 2);
  const pressure = (candidate: NodeCapacity) => {
    const cpu = candidate.cpu + vcpus / candidate.cpus;
    const ram = 1 - (candidate.freeRamMb - ramMb) / candidate.totalRamMb;
    return { peak: Math.max(cpu, ram), total: cpu + ram };
  };
  eligible.sort((a, b) => pressure(a).total - pressure(b).total || pressure(a).peak - pressure(b).peak || a.node.localeCompare(b.node));
  if (!eligible.length) throw new Error("Neither configured node has enough available CPU, RAM and storage.");
  return eligible[0];
}
export class InfrastructureApi {
  constructor(private base: URL, private authorization: string, private ca?: Buffer, private servername?: string) {
    if (base.protocol !== "https:") throw new Error("Infrastructure APIs require HTTPS.");
  }
  async call(method: string, suffix: string, body?: unknown, form = false): Promise<unknown> {
    const url = new URL(this.base.toString());
    url.pathname = url.pathname.replace(/\/$/, "") + suffix.split("?")[0];
    url.search = suffix.includes("?") ? suffix.slice(suffix.indexOf("?")) : "";
    if (form && body !== undefined && !record(body)) throw new Error("Invalid infrastructure form.");
    const queryOnly = form && (method === "GET" || method === "DELETE") && record(body);
    if (queryOnly) for (const [key, value] of Object.entries(body)) url.searchParams.append(key, String(value));
    const payload = body === undefined || queryOnly ? undefined : form && record(body) ? new URLSearchParams(Object.entries(body).map(([key, value]) => [key, String(value)])).toString() : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = request(url, { method, ca: this.ca, servername: this.servername, headers: {
        Authorization: this.authorization, ...(payload === undefined ? {} : {
          "Content-Type": form ? "application/x-www-form-urlencoded" : "application/json", "Content-Length": Buffer.byteLength(payload),
        }),
      } }, (res) => {
        let text = "";
        res.on("data", (chunk: Buffer) => { text += chunk; if (Buffer.byteLength(text) > 2 * 1024 * 1024) res.destroy(new Error("Infrastructure response exceeded its limit.")); });
        res.on("error", reject);
        res.on("end", () => {
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`Infrastructure request rejected (HTTP ${res.statusCode}).`));
          try {
            const result: unknown = JSON.parse(text);
            if (!record(result)) throw new Error("Invalid infrastructure response.");
            if (result.success === false) throw new Error("Infrastructure operation was rejected.");
            resolve(result);
          } catch (error) { reject(error); }
        });
      });
      const timer = setTimeout(() => req.destroy(new Error("Infrastructure request timed out.")), 20000);
      req.once("close", () => clearTimeout(timer));
      req.once("error", reject);
      req.end(payload);
    });
  }
}
export class Proxmox {
  readonly nodes = (process.env.HOSTING_PROXMOX_NODES || "pve02,pve03").split(",").map((value) => value.trim());
  readonly template = Number(process.env.HOSTING_TEMPLATE_ID || 9001);
  readonly storage = process.env.HOSTING_STORAGE || "truenas";
  readonly pool = process.env.HOSTING_PROXMOX_POOL || "blockhost-managed";
  private api: InfrastructureApi;
  constructor() {
    if (!/^[a-zA-Z0-9_-]+$/.test(this.storage) ||
        !/^[a-zA-Z0-9_-]+$/.test(this.pool) || !Number.isInteger(this.template) || this.template < 1 ||
        !this.nodes.length || this.nodes.some((node) => !/^[a-zA-Z0-9_-]+$/.test(node)) ||
        new Set(this.nodes).size !== this.nodes.length) throw new Error("Invalid provisioner Proxmox configuration.");
    this.api = new InfrastructureApi(new URL(required("HOSTING_PROXMOX_URL")), `PVEAPIToken=${required("HOSTING_PROXMOX_TOKEN_ID")}=${required("HOSTING_PROXMOX_TOKEN_SECRET")}`,
      readFileSync(required("HOSTING_PROXMOX_CA_FILE")), required("HOSTING_PROXMOX_TLS_NAME"));
  }
  path(id: number, node: string) {
    if (!this.nodes.includes(node) || !Number.isInteger(id) || id < 1) throw new Error("VM/node is outside the provisioner's scope.");
    return `/nodes/${node}/qemu/${id}`;
  }
  async call(method: string, suffix: string, values?: Record<string, string | number>): Promise<unknown> {
    const result = await this.api.call(method, suffix, values, true);
    if (!record(result) || !("data" in result)) throw new Error("Invalid Proxmox response.");
    return result.data;
  }
  async vmNode(id: number): Promise<string> {
    const resources = await this.call("GET", "/cluster/resources?type=vm");
    if (!Array.isArray(resources)) throw new Error("Invalid cluster VM list.");
    const matches = resources.filter((item: unknown) => record(item) && item.vmid === id && item.type === "qemu");
    const match: unknown = matches[0];
    if (matches.length !== 1 || !record(match) || typeof match.node !== "string" || !this.nodes.includes(match.node)) throw new Error("VM location could not be verified on a configured node.");
    return match.node;
  }
  async config(id: number, node: string) {
    const config = await this.call("GET", this.path(id, node) + "/config");
    if (!record(config)) throw new Error("Invalid VM configuration.");
    return config;
  }
  async vmExists(id: number, node: string): Promise<boolean> {
    this.path(id, node);
    const resources = await this.call("GET", "/cluster/resources?type=vm");
    if (!Array.isArray(resources) || resources.some((item: unknown) =>
      !record(item) || !Number.isInteger(item.vmid) || typeof item.node !== "string")) throw new Error("Invalid cluster VM list.");
    const matches = resources.filter((item: Record<string, unknown>) => item.vmid === id);
    if (!matches.length) return false;
    if (matches.length !== 1 || matches[0].node !== node || matches[0].type !== "qemu") throw new Error("VM location differs from its provisioning journal.");
    return true;
  }
  async waitForCloneDisks(id: number, node: string): Promise<void> {
    const config = await this.config(id, node);
    const expected = ["ide0", "ide2"].map((drive) => {
      const value = config[drive];
      if (typeof value !== "string" || !value.startsWith(`${this.storage}:${id}/`)) throw new Error("Unexpected cloned disk configuration.");
      return value.split(",")[0];
    });
    for (let attempt = 0; attempt < 45; attempt++) {
      const volumes = await this.call("GET", `/nodes/${node}/storage/${this.storage}/content?content=images&vmid=${id}`);
      if (!Array.isArray(volumes) || volumes.some((volume: unknown) =>
        !record(volume) || typeof volume.volid !== "string")) throw new Error("Invalid target-node storage inventory.");
      const visible = new Set(volumes.map((volume: { volid: string }) => volume.volid));
      if (expected.every((volume) => visible.has(volume))) return;
      if (attempt < 44) await delay(2000);
    }
    throw new Error("Cloned disks did not become visible on the target node.");
  }
  async task(value: unknown) {
    const node = typeof value === "string" ? value.match(/^UPID:([a-zA-Z0-9_-]+):/)?.[1] : undefined;
    if (!node || !this.nodes.includes(node)) throw new Error("Missing or out-of-scope Proxmox task identifier.");
    for (let attempt = 0; attempt < 300; attempt++) {
      const result = await this.call("GET", `/nodes/${node}/tasks/${encodeURIComponent(String(value))}/status`);
      if (!record(result)) throw new Error("Invalid task status.");
      if (result.status === "stopped") {
        if (result.exitstatus !== "OK") throw new Error("Proxmox task did not complete successfully.");
        return;
      }
      await delay(2000);
    }
    throw new Error("Proxmox task timed out; its ownership record has been retained.");
  }
  async guest(id: number, script: string, node: string): Promise<string> {
    // Only non-secret scripts use guest-exec arguments. Backend secrets travel over SSH stdin.
    const query = new URLSearchParams();
    for (const command of ["/bin/bash", "-lc", script]) query.append("command", command);
    const url = new URL(required("HOSTING_PROXMOX_URL"));
    url.pathname = url.pathname.replace(/\/$/, "") + this.path(id, node) + "/agent/exec";
    const result = await this.rawGuest(url, query.toString());
    if (!record(result) || !record(result.data) || typeof result.data.pid !== "number") throw new Error("Guest execution did not start.");
    for (let attempt = 0; attempt < 120; attempt++) {
      const status = await this.call("GET", this.path(id, node) + "/agent/exec-status?pid=" + result.data.pid);
      if (!record(status)) throw new Error("Invalid guest execution status.");
      if (status.exited) {
        if (status.exitcode !== 0) throw new Error(`Guest operation failed on VM ${id}; inspect its logs.`);
        return typeof status["out-data"] === "string" ? status["out-data"] : "";
      }
      await delay(1000);
    }
    throw new Error("Guest operation timed out.");
  }
  private rawGuest(url: URL, payload: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const req = request(url, { method: "POST", ca: readFileSync(required("HOSTING_PROXMOX_CA_FILE")),
        servername: required("HOSTING_PROXMOX_TLS_NAME"), timeout: 15000, headers: {
          Authorization: `PVEAPIToken=${required("HOSTING_PROXMOX_TOKEN_ID")}=${required("HOSTING_PROXMOX_TOKEN_SECRET")}`,
          "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(payload),
        } }, (res) => {
        let text = "";
        res.on("data", (chunk: Buffer) => { text += chunk; if (text.length > 131072) res.destroy(new Error("Guest response too large.")); });
        res.on("error", reject);
        res.on("end", () => {
          if (res.statusCode !== 200) return reject(new Error("Guest execution unavailable."));
          try { resolve(JSON.parse(text)); } catch { reject(new Error("Malformed guest execution response.")); }
        });
      });
      req.on("timeout", () => req.destroy(new Error("Guest execution timed out.")));
      req.on("error", reject); req.end(payload);
    });
  }
  async capacities(): Promise<NodeCapacity[]> {
    return Promise.all(this.nodes.map(async (name) => {
      const [node, storage] = await Promise.all([
        this.call("GET", `/nodes/${name}/status`),
        this.call("GET", `/nodes/${name}/storage/${this.storage}/status`),
      ]);
      if (!record(node) || !record(node.memory) || !record(node.cpuinfo) ||
          typeof node.memory.free !== "number" || !Number.isFinite(node.memory.free) || node.memory.free < 0 ||
          typeof node.memory.total !== "number" || !Number.isFinite(node.memory.total) || node.memory.total <= 0 ||
          node.memory.free > node.memory.total || typeof node.cpuinfo.cpus !== "number" || !Number.isInteger(node.cpuinfo.cpus) || node.cpuinfo.cpus < 1 ||
          typeof node.cpu !== "number" || !Number.isFinite(node.cpu) || node.cpu < 0 || node.cpu > 1 ||
          !record(storage) || typeof storage.avail !== "number" || !Number.isFinite(storage.avail) || storage.avail < 0 ||
          storage.active !== 1 || storage.shared !== 1) throw new Error("Node/shared-storage capacity could not be verified for " + name + ".");
      return { node: name, cpu: node.cpu, cpus: node.cpuinfo.cpus, totalRamMb: node.memory.total / 1024 ** 2,
        freeRamMb: node.memory.free / 1024 ** 2, freeDiskGb: storage.avail / 1024 ** 3 };
    }));
  }
}
export function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error("Missing provisioner configuration: " + name);
  return value;
}
export async function provisionSsh(host: string, fingerprint: string, key: string, input: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let finished = false;
    const finish = (error?: Error) => {
      if (finished) return; finished = true; clearTimeout(timer); client.end();
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => { client.destroy(); finish(new Error("Backend configuration exceeded its deadline.")); }, 600000);
    client.on("error", finish);
    client.on("close", () => { if (!finished) finish(new Error("Backend setup connection closed.")); });
    client.on("ready", () => client.exec("sudo -A /usr/bin/node /usr/local/libexec/blockhost-provision-backend.cjs", (error, stream) => {
      if (error) return finish(error);
      let bytes = 0;
      stream.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 131072) finish(new Error("Backend setup output exceeded its limit.")); });
      stream.stderr.on("data", () => { /* Keep guest diagnostics off the public job API. */ });
      stream.on("error", finish);
      stream.on("close", (code: number | null) => finish(code === 0 ? undefined : new Error("Backend setup failed; inspect the guest logs.")));
      stream.end(JSON.stringify(input));
    }));
    try { client.connect(sshOptions(host, fingerprint, key, "mcdeploy")); } catch (error) { finish(error instanceof Error ? error : new Error("Invalid setup connection.")); }
  });
}
export function changeVelocityRoute(source: string, key: string, hostname: string, ip: string, remove: boolean): string {
  const config = TOML.parse(source);
  const servers = config.servers, hosts = config["forced-hosts"];
  if (!record(servers) || !record(hosts) || !Array.isArray(servers.try) || servers.try.length) throw new Error("Expected an isolated forced-host Velocity configuration.");
  const target = ip + ":25565";
  if (servers[key] !== undefined && servers[key] !== target) throw new Error("Existing proxy server differs from this job.");
  if (hosts[hostname] !== undefined && JSON.stringify(hosts[hostname]) !== JSON.stringify([key])) throw new Error("Hostname already routes to another server.");
  if (remove) { delete servers[key]; delete hosts[hostname]; }
  else { servers[key] = target; hosts[hostname] = [key]; }
  return TOML.stringify(config);
}
export async function velocityRoute(pve: Proxmox, key: string, hostname: string, ip: string, remove = false) {
  const vmid = Number(required("HOSTING_VELOCITY_VMID"));
  const node = await pve.vmNode(vmid);
  const before = await pve.guest(vmid, "cat /srv/velocity/velocity.toml", node);
  const after = changeVelocityRoute(before, key, hostname, ip, remove);
  const expected = createHash("sha256").update(before).digest("hex");
  const script = `import os, hashlib, base64, tempfile
file = "/srv/velocity/velocity.toml"
with open(file, "rb") as source:
    original = source.read()
if hashlib.sha256(original).hexdigest() != ${JSON.stringify(expected)}:
    raise RuntimeError("Proxy configuration changed.")
stat = os.stat(file)
fd, tmp = tempfile.mkstemp(prefix=".blockhost-", dir=os.path.dirname(file))
try:
    with os.fdopen(fd, "wb") as target:
        target.write(base64.b64decode(${JSON.stringify(Buffer.from(after).toString("base64"))}))
        target.flush()
        os.fsync(target.fileno())
    os.chmod(tmp, 0o640)
    os.chown(tmp, stat.st_uid, stat.st_gid)
    os.replace(tmp, file)
finally:
    if os.path.exists(tmp):
        os.unlink(tmp)
`;
  await pve.guest(vmid, "set -euo pipefail\n/usr/bin/python3 -c " + shellQuote(script) + "\ntimeout 5 /bin/bash -c 'printf \"velocity reload\\n\" > /run/velocity/console'", node);
}
function shellQuote(value: string) { return "'" + value.replace(/'/g, "'\\''") + "'"; }
export class Cloudflare {
  private api = new InfrastructureApi(new URL("https://api.cloudflare.com/client/v4"), "Bearer " + required("HOSTING_CLOUDFLARE_TOKEN"));
  readonly zone = required("HOSTING_CLOUDFLARE_ZONE");
  async records(name: string): Promise<Array<{ id: string; name: string; comment?: string }>> {
    const result = await this.api.call("GET", `/zones/${this.zone}/dns_records?name=${encodeURIComponent(name)}&per_page=100`);
    if (!record(result) || !Array.isArray(result.result)) throw new Error("Invalid DNS records response.");
    return result.result.map((item: unknown) => {
      if (!record(item) || typeof item.id !== "string" || typeof item.name !== "string") throw new Error("Invalid DNS record.");
      return { id: item.id, name: item.name, comment: typeof item.comment === "string" ? item.comment : undefined };
    });
  }
  async create(type: "A" | "SRV", hostname: string, jobId: string) {
    const marker = "Blockhost job " + jobId;
    const name = type === "A" ? hostname : "_minecraft._tcp." + hostname;
    const existing = await this.records(name);
    if (existing.length) throw new Error("A DNS record already exists for the requested hostname.");
    await this.api.call("POST", `/zones/${this.zone}/dns_records`, { type, name, ttl: 120, comment: marker,
      ...(type === "A" ? { content: required("HOSTING_PUBLIC_IP"), proxied: false } :
        { data: { priority: 0, weight: 0, port: Number(required("VELOCITY_STATUS_PORT")), target: hostname } }),
    });
  }
  async remove(hostname: string, jobId: string) {
    for (const name of [hostname, "_minecraft._tcp." + hostname]) {
      for (const item of await this.records(name)) {
        if (item.comment !== "Blockhost job " + jobId) throw new Error("Refusing to delete DNS not owned by this job.");
        await this.api.call("DELETE", `/zones/${this.zone}/dns_records/${item.id}`);
      }
    }
  }
}
