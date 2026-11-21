import { HostedServer } from "./hosted-servers";
import { Proxmox, Cloudflare, record, changeVelocityRoute } from "./provisioning-provider";
import { SftpGateway } from "./hosting-management";

export interface DeletionTarget {
  id: string; owner: string; hostname: string; ip: string; fingerprint: string; vmid: number; node: string;
  vmName: string; vmDescription: string; routeKey: string;
  dnsRecords: Array<{ id: string; name: string; comment?: string }>;
  legacyWebUserWithoutOwner?: boolean;
}
export function isDeletionTarget(value: unknown): value is DeletionTarget {
  return record(value) && ["id", "owner", "hostname", "ip", "fingerprint", "node", "vmName", "vmDescription", "routeKey"]
    .every(key => typeof value[key] === "string") && Number.isInteger(value.vmid) &&
    (value.legacyWebUserWithoutOwner === undefined || typeof value.legacyWebUserWithoutOwner === "boolean") &&
    Array.isArray(value.dnsRecords) && value.dnsRecords.every((entry: unknown) =>
      record(entry) && typeof entry.id === "string" && typeof entry.name === "string" &&
      (entry.comment === undefined || typeof entry.comment === "string"));
}
export function assertDeletionIdentity(target: DeletionTarget, server: HostedServer, protectedVmids: number[]) {
  if (target.id !== server.id || target.owner !== server.owner_discord_id || target.hostname !== server.address ||
      target.ip !== server.ssh_host || target.vmid !== server.vmid ||
      target.fingerprint !== server.ssh_host_fingerprint || protectedVmids.includes(target.vmid)) {
    throw new Error("Deletion identity does not match the registered server or targets protected infrastructure.");
  }
}
interface Dependencies {
  pve: Pick<Proxmox, "config" | "vmExists" | "path" | "call" | "task" | "guest" | "vmNode">;
  dns: Pick<Cloudflare, "records" | "deleteRecord">;
  gateway: Pick<SftpGateway, "token" | "request" | "updateUser">;
  velocityId: number;
  protectedVmids: number[];
  route(target: DeletionTarget): Promise<void>;
  stage(text: string): Promise<void>;
}
export async function deleteServerResources(server: HostedServer, target: DeletionTarget, dependencies: Dependencies) {
  const { pve, dns, gateway } = dependencies;
  assertDeletionIdentity(target, server, dependencies.protectedVmids);
  const validateVm = async () => {
    if (!(await pve.vmExists(target.vmid, target.node))) return false;
    const config = await pve.config(target.vmid, target.node);
    if (config.template || config.lock || config.name !== target.vmName ||
        (config.description ?? "") !== target.vmDescription) throw new Error("VM ownership changed; deletion stopped.");
    for (const [drive, value] of Object.entries(config)) {
      if (!/^(?:(?:ide|scsi|sata|virtio|unused)\d+|efidisk0|tpmstate0)$/.test(drive)) continue;
      if (typeof value !== "string" || !new RegExp(`^[a-zA-Z0-9_-]+:${target.vmid}/`).test(value.split(",")[0])) {
        throw new Error("VM has a disk outside its own storage namespace; operator review required.");
      }
    }
    return true;
  };
  await dependencies.stage("Verifying private resource ownership");
  await validateVm();
  const velocityNode = await pve.vmNode(dependencies.velocityId);
  changeVelocityRoute(await pve.guest(dependencies.velocityId, "cat /srv/velocity/velocity.toml", velocityNode),
    target.routeKey, target.hostname, target.ip, true);
  const records: DeletionTarget["dnsRecords"] = [];
  for (const name of [target.hostname, "_minecraft._tcp." + target.hostname]) {
    for (const entry of await dns.records(name)) {
      if (!target.dnsRecords.some(expected => expected.id === entry.id && expected.name === entry.name &&
          expected.comment === entry.comment)) throw new Error("DNS ownership changed; deletion stopped.");
      records.push(entry);
    }
  }
  const token = await gateway.token();
  const users: Array<{ username: string; value: Record<string, unknown> }> = [];
  for (const username of [target.id, "web-" + target.id]) {
    let value: unknown;
    try { value = await gateway.request("GET", "/users/" + encodeURIComponent(username), undefined, token); }
    catch (error) {
      if (error instanceof Error && error.message.includes("HTTP 404")) continue;
      throw error;
    }
    if (!record(value)) throw new Error("Invalid SFTP identity.");
    const adoptedUnmarkedWebUser = target.legacyWebUserWithoutOwner === true && username === "web-" + target.id &&
      (value.additional_info === undefined || value.additional_info === null);
    if (value.username !== username || (value.additional_info !== target.owner && !adoptedUnmarkedWebUser) ||
        !record(value.filesystem) || !record(value.filesystem.sftpconfig) ||
        value.filesystem.sftpconfig.endpoint !== target.ip + ":22" ||
        !Array.isArray(value.filesystem.sftpconfig.fingerprints) ||
        value.filesystem.sftpconfig.fingerprints.length !== 1 ||
        String(value.filesystem.sftpconfig.fingerprints[0]).replace(/^SHA256:/, "").replace(/=+$/, "") !==
          target.fingerprint.replace(/^SHA256:/, "").replace(/=+$/, "")) throw new Error("SFTP ownership changed; deletion stopped.");
    users.push({ username, value });
  }
  await dependencies.stage("Revoking and removing SFTP access");
  for (const user of users) {
    await gateway.updateUser({ ...server, id: user.username }, user.value, [], [], token, true);
    try { await gateway.request("DELETE", "/users/" + encodeURIComponent(user.username), undefined, token); }
    catch (error) { if (!(error instanceof Error) || !error.message.includes("HTTP 404")) throw error; }
  }
  await dependencies.stage("Removing DNS and Velocity routing");
  for (const entry of records) await dns.deleteRecord(entry);
  await dependencies.route(target);
  await dependencies.stage("Stopping and deleting the VM and its disks");
  if (await validateVm()) {
    const status = await pve.call("GET", pve.path(target.vmid, target.node) + "/status/current");
    if (!record(status) || typeof status.status !== "string") throw new Error("Unknown VM state.");
    if (status.status !== "stopped") {
      await pve.task(await pve.call("POST", pve.path(target.vmid, target.node) + "/status/shutdown", { timeout: 60, forceStop: 1 }));
    }
    await pve.task(await pve.call("DELETE", pve.path(target.vmid, target.node), { purge: 1 }));
    if (await pve.vmExists(target.vmid, target.node)) throw new Error("VM deletion was not confirmed.");
  }
}
