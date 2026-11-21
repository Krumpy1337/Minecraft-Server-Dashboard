# Blockhost

Blockhost is a Minecraft server dashboard prototype with a Node.js/TypeScript backend, Discord-only sign-in, per-account hosting plans, optional Minecraft plugin connections, and admin-only Proxmox VM statistics.

## Local setup

Requirements: Node.js 20+, npm, and PostgreSQL.

1. Copy `.env.example` to `.env`.
2. Create a Discord application and add the callback URL from `DISCORD_CALLBACK_URL` under OAuth2 Redirects. Set `DISCORD_CLIENT_ID` and `DISCORD_CLIENT_SECRET` in `.env`.
3. Set `DISCORD_ADMIN_USER_IDS` to a comma-separated list of Discord numeric user IDs. Admin access is determined from the verified Discord account ID, never the username.
4. Configure `DATABASE_URL` for PostgreSQL and `APP_SESSION_SECRET` to a random value of at least 32 characters (for example, generate one with `openssl rand -base64 48`).
5. Configure `PROXMOX_API_URL`, `PROXMOX_TOKEN_ID`, `PROXMOX_TOKEN_SECRET`, `PROXMOX_VM_ID`, and `PROXMOX_VM_NAME`. Use a least-privilege Proxmox token with read-only cluster-resource and VM-audit access.
6. Configure `SERVER_CREDENTIALS_KEY` with 32 random bytes encoded as hex (`openssl rand -hex 32`). Add exact plugin API hostnames to `MINECRAFT_ALLOWED_HOSTS`; unlisted hosts are rejected.
7. Install and start the app:

   ```sh
   npm install
   npm run dev
   ```

Visit `http://localhost:3000`. The explicit demo option uses sample data only in that browser. Authenticated Discord accounts start with empty live-data states and do not receive sample server, activity, file, or backup information.

## Arch Minecraft VM template

The Arch helper configures Java 21, Cloud-Init, QEMU guest-agent, NetworkManager, a non-root `minecraft` runtime, and a restricted `mcdeploy` account. It disables systemd-networkd and its wait-online service to avoid competing network managers. Run it as root with the installed Arch filesystem mounted at `/mnt` from the Arch ISO. Copy the helper to that environment first if needed:

```sh
ARCH_ROOT=/mnt ROOT_SSH_POLICY=password bash scripts/arch-minecraft-template-setup.sh
```

Password mode is for maintaining VM 9000 only; set its root password separately. Before converting it to a reusable template, rerun the helper with `ROOT_SSH_POLICY=disabled` (or omit the variable). That profile locks root and disables root/password SSH. The helper enables Cloud-Init's boot stages; its generator activates them when a clone has a seed drive. Clones should use Cloud-Init `ciuser=mcdeploy` with a unique SSH key. The helper does not accept the Minecraft EULA; only write `eula=true` after explicit user consent.

### Refreshed Paper template

**VM 9001** (`blockhost-paper-template-v1`, pve02, shared `truenas` storage) is the prepared Paper template. VM 9000 is preserved for rollback. The image has a 32-GiB disk, Java 25 as the default runtime, checksum-verified Paper 26.3 build 256, Node.js, nftables, disk-growth tools, and root-owned console/storage/provisioning helpers. Minecraft is inactive; neither EULA acceptance nor backend configuration is baked in.

To reproduce the build, copy the complete `scripts` directory to a **fresh Arch build clone**, then run `arch-paper-template-setup.sh` there as root. It upgrades Arch and installs the pinned Paper JAR without running it. Reboot after kernel upgrades, wait for Cloud-Init to finish, and verify networking, SSH, Java, and nftables. The build was tested with Cloud-Init 26.2; Proxmox's generated legacy `user` field causes a deprecation warning, but all initialization stages completed with zero errors.

After verification, run `arch-paper-template-seal.sh` as root through the Proxmox guest agent or console. It removes injected maintenance keys, SSH host keys, generated/build network profiles, Cloud-Init cache, and machine identity. **Shut down immediately afterward without another boot**, clear the build-specific Proxmox Cloud-Init SSH keys/password/IP settings, and convert the stopped VM to a template. Never run these build/seal scripts on an existing backend or directly on the rollback template.

A disposable full clone of 9001 was verified on **pve03**, using a unique maintenance key, static address from the reserved pool, and a 40-GiB disk. First boot required no manual network repair and grew the ext4 filesystem to 42,086,973,440 bytes. Machine and SSH host identities differed from the build VM and remained stable across reboot. Real website-origin console, metrics and stopped-server settings operations passed; gateway-origin jailed SFTP upload/download/rename/delete passed, with `/etc/passwd` inaccessible. The old build key, wrong-source SFTP authentication, and arbitrary console shell commands were rejected. Minecraft remained inactive with no EULA file. The disposable VM, its disks, and all validation key pairs were removed afterward.

New clones must set `ciuser=mcdeploy`, inject their own unique maintenance key, and supply their assigned network/resources before boot. The deployed worker performs these steps for plan-assigned beta users.

## Velocity gateway

On the dedicated Arch gateway VM (VM 116; reserve `10.0.0.51` via DHCP), run `scripts/arch-velocity-setup.sh` as root. The helper installs pinned Velocity 4.3.1 build 45 with SHA-256 verification and Java 25 alongside the backend's Java 21. It enables `velocity.service` as a separate non-login user, listening on TCP 37001 with a 1-GiB Java heap. It disables the inherited Minecraft service on this gateway only.

The proxy configuration is `/srv/velocity/velocity.toml`; its root-owned forwarding secret is `/etc/velocity/forwarding.secret` (readable only by root and the Velocity group). Rerunning the helper preserves both files and refuses an unexpected existing JAR checksum. Use `systemctl status velocity.service` and `journalctl -u velocity.service` as root for diagnostics. The `mcdeploy` account can use sudo for the service's start, stop, restart, and status commands.

Online authentication and modern player forwarding are enabled. A fresh gateway installation starts with empty backend and forced-host lists; the deployed gateway has the test routes documented below. For each future Paper backend, configure Velocity support with the matching forwarding secret, keep backend `server.properties` in offline mode **only behind the authenticated proxy**, and restrict its Minecraft port to the gateway. Add its address under `[servers]` and its hostname under `[forced-hosts]`, then reload Velocity. Set `[servers].try` only when a default backend is intended.

The deployed gateway also has FIFO console control from `scripts/arch-velocity-console-setup.sh`. Installing this helper requires root and `VELOCITY_RESTART_ACCEPTED=true`, and performs one gateway restart. Its systemd drop-in preserves the existing Java heap and hardening; subsequent route changes can send `velocity reload` through the private `/run/velocity/console` FIFO without restarting the proxy.

Reserve the gateway's DHCP address before router cutover. This helper makes no DNS or router changes. Once tested with a backend, route external TCP 37001 to the gateway; Minecraft hostnames using this non-default port need DNS-only address records plus SRV records. Leave existing routes in place until cutover is approved and tested.

### First test backend

The test deployment uses VM 118 (`test-minecraft`): 4 vCPU, 4096 MiB RAM, a 32-GiB disk, and DHCP address `10.0.0.102`. Paper 26.3 build 256 runs with Java 25 and a 3-GiB heap under `minecraft.service`. Both VMs are configured for Proxmox autostart; the backend service and its firewall are enabled on guest boot. Whitelisting is disabled on this server and explicitly defaults off for future backends (`white-list=false` and `enforce-whitelist=false`); Velocity still authenticates Minecraft accounts.

Minecraft Java 26.3 clients can use `test.krumpy.xyz` without specifying a port. Its DNS-only A record points to the existing public Minecraft IPv4 address, and `_minecraft._tcp.test.krumpy.xyz` targets `test.krumpy.xyz:37001`. Velocity routes only that forced hostname to `10.0.0.102:25565`; its default backend list remains empty. Backend status passthrough makes the test hostname display the Paper server's MOTD and player count. Existing Minecraft DNS records were left unchanged.

### Second test backend

`test2.krumpy.xyz` is a separate Paper 26.3 server registered as **Test 2** to `krumpy1337`. VM 120 runs on **pve03**, cloned from template 9001 with 4 vCPU, 4096 MiB RAM, a 32-GiB disk, and static backend address `10.0.0.201`. Its DNS-only A and Minecraft SRV records use the same public gateway on TCP 37001, so clients need no explicit port. Exact-backend public status, encrypted dashboard console access, metrics/settings, and jailed file upload/download/rename/delete were verified. External SFTP remains disabled until the owner configures a public key and obtains a website-authorized IP grant. This was an operator-created deployment with explicit EULA consent, not automated website provisioning.

After creating a hostname, recursive DNS resolvers may retain an earlier negative answer for up to the zone's negative-cache TTL (currently 30 minutes), even when authoritative DNS already returns the new records.

The fresh-clone helper is `scripts/arch-paper-backend-setup.sh`. New backends should use refreshed template 9001, which includes the Cloud-Init, NetworkManager, and systemd JAR-path fixes; template 9000 remains unchanged for rollback. After explicit EULA consent, supply the gateway's IPv4 address and a root-readable temporary copy of its forwarding secret:

```sh
MINECRAFT_EULA_ACCEPTED=true \
VELOCITY_GATEWAY_IP=10.0.0.51 \
VELOCITY_FORWARDING_SECRET_FILE=/run/velocity-forwarding.secret \
bash scripts/arch-paper-backend-setup.sh
```

Run this as root only on a fresh backend clone; it refuses to overwrite an existing backend configuration. Transfer the forwarding secret securely, never print or commit it, and delete the temporary copy after setup. The helper verifies the pinned Paper JAR checksum, records operator consent in `/etc/minecraft/eula-acceptance.txt`, and configures Paper's native Velocity forwarding.

`minecraft-firewall.service` loads an isolated nftables table that allows backend TCP 25565 only from `10.0.0.51`, including blocking direct IPv6 access. The Minecraft service requires this firewall before starting. Do not forward the backend's port in the router. Reserve both VM DHCP addresses so the gateway route and source-IP restriction remain valid. View backend logs with `journalctl -u minecraft.service` as root. Both persistent test VMs are registered to their owner's dashboard account.

### Hosted server console

Assigned hosted VMs appear under **Your servers** and **Server console** after Discord sign-in. Owners and configured site administrators can read the latest 200 log lines, send Minecraft commands, and start, stop, or restart the Minecraft service (not the VM). Console commands have full Minecraft operator privileges. The optional BadApple plugin is not required.

For each configured Paper backend, generate a dedicated Ed25519 console key and run `scripts/arch-minecraft-console-setup.sh` as root with `WEBSITE_IP` and `MINECRAFT_CONSOLE_PUBLIC_KEY`. This restarts Minecraft to attach its input FIFO. The helper limits the `mcconsole` SSH user to fixed console operations, restricts the key to the website's source address, and disables SSH forwarding. It does not enable RCON or open another port.

The website's `HOSTED_SERVER_ALLOWED_HOSTS` must contain the backend's exact LAN address. Operator-managed `hosted_servers` records associate an existing Discord account with the VM metadata, backend address, verified SHA-256 SSH host-key digest (base64 without `SHA256:`), and dedicated private key encrypted using the existing `SERVER_CREDENTIALS_KEY` format. Never put private keys in browser code or plaintext database columns. Verify the backend host key through a trusted channel before registration. There is intentionally no public registration API.

Keep the existing website `.env` when deploying: add only missing settings, preserve Discord OAuth/callback configuration, `APP_SESSION_SECRET`, database settings, and especially `SERVER_CREDENTIALS_KEY`. Rotating the encryption key without re-encrypting stored credentials breaks existing connections. Cloudflare and Proxmox provisioning credentials are not required for console access. Run `npm test` for management tests and the TypeScript build.

### Files, SFTP, metrics, and settings

The shared SFTP gateway is VM 119 (`10.0.0.15`), running checksum-pinned SFTPGo 2.7.6. External access uses **SFTP**, not plain FTP: forward only external TCP **37002 to 10.0.0.15:2022** and use the DNS-only hostname `sftp.krumpy.xyz`. Set `SFTP_GATEWAY_PUBLIC_PORT=37002`; the internal listener remains 2022. Never expose its HTTPS management port 8443 or backend SSH ports. Reserve the website, gateway, Velocity, and backend DHCP addresses.

An owner or site administrator must sign in with Discord, open **Files / SFTP**, save an Ed25519 **public** key, and explicitly select **Enable SFTP for this IP**. Verify the SFTP server's host-key fingerprint against the one displayed there. The website derives the address from the verified connection, not a submitted address. Access lasts one hour and renews every five minutes only while that page remains open. Leaving the page stops renewal; signing out or revoking the session removes its grant. Expired sessions and changed ownership are reconciled every 30 seconds; ownership changes also clear external SFTP keys. Renewals cannot recreate revoked/expired grants or authorize a changed IP without another explicit enable action. The kernel expires IP grants independently if the website is unavailable. SSH keys remain mandatory: an allowed/shared NAT address alone cannot authenticate another account. IPv4/IPv6, VPN, and router hairpin-NAT differences can cause the SFTP client's address not to match the browser's address.

The gateway firewall defaults to deny for public SFTP; only the private website and expiring individual IP grants are allowed. Each external SFTP account has its own allowed-IP list and is disabled without both keys and grants. File access is additionally chrooted on the backend, mapped only to that server's folder, with no shell or SSH forwarding. The private website file account does not require opening public SFTP access.

Setup order for additional gateways/backends:

1. Run `scripts/arch-sftp-gateway-setup.sh` on the dedicated gateway, then `scripts/arch-sftp-access-setup.sh` with `WEBSITE_IP`, `SFTP_ACCESS_PUBLIC_KEY`, and `ACCESS_HELPER_FILE` pointing to `scripts/sftp-access.cjs`. Wait for Cloud-Init upgrades and reboot first if the running kernel lacks matching nftables modules.
2. After console setup, run `scripts/arch-minecraft-management-setup.sh` on each backend with `SFTP_GATEWAY_IP`, `MINECRAFT_FILES_PUBLIC_KEY`, and `MANAGEMENT_HELPER_FILE` pointing to `scripts/minecraft-management.cjs`. This installs the jail and fixed metrics/settings operations without restarting Minecraft.
3. Before registering a hosted server, provision its private `web-<server-id>` and disabled external `<server-id>` SFTPGo accounts. Use the SFTP filesystem provider, `/files` prefix, a pinned backend Ed25519 host key, and the dedicated backend key. The exported `gatewayUser` helper defines this schema. A missing gateway account intentionally causes reconciliation to fail closed, not silently permit access.
4. Configure all `SFTP_GATEWAY_*` integration fields in the website environment. Fingerprints are verified SHA-256 digests in base64 without `SHA256:`. The CA file trusts the private gateway HTTPS certificate; the access-key file is a mode-0600 private key for the restricted `sftpaccess` firewall helper. Use a gateway API administrator limited to `view_users`, `edit_users`, and `add_users`, restricted to the website IP. Do not copy bootstrap administrator credentials into the website.
5. Set `SFTP_TRUST_CLOUDFLARE=true` only when the website listens on loopback behind the configured Cloudflare Tunnel: it accepts `CF-Connecting-IP` only from a loopback connection. Do not expose that loopback origin through another untrusted proxy. Otherwise leave it false and use the direct verified connection address.
6. Set `VELOCITY_STATUS_HOST` and `VELOCITY_STATUS_PORT` for backend player-status passthrough. Metrics show measured service RAM/uptime, CPU deltas normalized by assigned vCPUs, and **VM disk** usage (including the OS). The first CPU sample is pending; failed player probes display an error, not a fabricated zero.

The browser file manager supports listing, downloads, uploads (90 MiB each, up to 20 selected files), new folders, rename, and deletion of files/empty folders. UTF-8 text editing is limited to 256 KiB and uses revision checks. Uploads are staged and renamed; overwrites require confirmation. Paths cannot traverse the jail, and browser access to symbolic links is rejected. Transfers have a two-minute deadline; use SFTP for larger/longer transfers.

The settings editor exposes only MOTD, player limit, gamemode, difficulty, view/simulation distance, spawn protection, whitelist, and flight. Stop Minecraft before saving; concurrent edits are rejected, and proxy/network properties are preserved. Backups remain unconfigured. Automated provisioning is available to accounts with an administrator-assigned plan.

## Debian VM deployment

Run the app behind a Cloudflare Tunnel. Discord OAuth requires the public callback URL to exactly match `DISCORD_CALLBACK_URL`.

The one-time helper installs Node.js/npm and PostgreSQL, creates the app database and random secrets, builds the project, and writes a hardened systemd unit. It does not copy the local `.env`, enable the Blockhost service, or start it. Run it from the SSH session on the VM:

```sh
cd /home/blockhost/blockhost-dashboard
sudo bash scripts/debian-setup.sh
```

Enter your sudo password in your own terminal; do not put it in `.env` or send it in chat. After setup completes, edit `/opt/blockhost/.env` with `sudoedit` and fill in the Discord application ID/secret, your numeric Discord admin ID, Proxmox API URL/token, and exact plugin hostnames in `MINECRAFT_ALLOWED_HOSTS`. The helper leaves those integration values blank and protects the generated env file with mode `0600`. The callback is prefilled as `https://blockhost.krumpy.xyz/auth/discord/callback`.

Once configuration is complete, start the app and check its status:

```sh
sudo systemctl enable --now blockhost
sudo systemctl status blockhost --no-pager
```

Configure the Cloudflare Tunnel hostname `blockhost.krumpy.xyz` to forward to `http://127.0.0.1:3000`. Do not expose the app or PostgreSQL ports directly to the internet. Keep PostgreSQL backups.

## Arch VM template

[`scripts/arch-template-install.sh`](./scripts/arch-template-install.sh) installs the Arch base system, OpenJDK 21, GRUB for a SeaBIOS VM, Cloud-Init, QEMU Guest Agent, SSH, and DHCP networking from an Arch live ISO. It erases the selected whole disk only after you confirm by typing `ERASE`; verify the disk name and size before confirming.

Run the script as root from the live ISO, passing the VM disk (for example `/dev/sda`) or letting it prompt:

```sh
bash arch-template-install.sh /dev/sda
```

After installation, detach the ISO in Proxmox, add a Cloud-Init drive, boot from the disk, and validate a test clone before converting the VM to a template. Build and validate a custom Arch ISO profile only after this base install is confirmed.

Install and validate this VM once, then convert it to a Proxmox template. Each clone inherits Arch, OpenJDK 21, Cloud-Init, QEMU Guest Agent, and the base networking/SSH setup. Blockhost should clone that template through the Proxmox API rather than run the ISO installer for each server. Paper JARs, server properties, and EULA acceptance are per-server provisioning steps; do not pre-accept the EULA in the shared template.

### Proxmox connectivity

Allow the Debian VM to reach the Proxmox API over HTTPS. Keep certificate verification enabled: install your Proxmox CA certificate into Debian's trusted CA store if needed. Do not disable TLS verification or expose the Proxmox token to browser code. The `/api/admin/proxmox/status` endpoint looks up the configured VM by ID and name through the cluster resources API, so it can find the VM on any node in that cluster. It verifies the signed-in Discord account against `DISCORD_ADMIN_USER_IDS` on every request and returns `401` or `403` otherwise.

Minecraft API credentials are encrypted at rest using `SERVER_CREDENTIALS_KEY`; each linked server is scoped to the Discord account that added it. The plugin's `/api` command supplies a key, not a URL; the server owner must separately provide the plugin API URL. `MINECRAFT_ALLOWED_HOSTS` must contain exact plugin hostnames before users can connect them. The current connector requires valid HTTPS on the standard port, rejects redirects, and checks `GET /v1/server` before saving a connection. It then expects `GET /v1/players`, `/v1/groups`, and `/v1/tracks`, plus `POST /v1/groups/create`, `/v1/groups/delete`, `/v1/groups/prefix`, `/v1/players/group`, `/v1/players/promote`, and `/v1/players/demote`. A key-generation command without a reachable API implementing these routes is not sufficient to manage a server.

### Hosting plans

Site administrators can create and edit plans and assign them to Discord accounts under **Plans & accounts**. Plan 1 is seeded with 1 server, 4 vCPU, 4096 MiB RAM, and 32 GB disk per server; Plan 2 with 2 servers, 6 vCPU, 8192 MiB RAM, and 40 GB disk; Plan 3 with an unlimited server count and an editable per-server resource limit. Plan 3 starts at 6 vCPU, 8192 MiB RAM, and 40 GB disk. New Discord sign-ins receive **no plan** automatically. Assign a plan to invite an account to provision servers; no separate Discord-ID allowlist is required. Removing a plan blocks further creation but does not delete existing servers. The **Create server** actions are the primary server workflow, while the BadApple API is optional.

The demo create-server flow requires an explicit Minecraft EULA checkbox. Live creation also requires explicit acceptance, but its form is unavailable until automated provisioning is enabled and its worker is healthy.

### Provisioning worker (plan-gated beta)

Automated creation is deployed and feature-gated by `HOSTING_ENABLED`, an administrator-assigned hosting plan, and a recent worker heartbeat. Template 9001 is cross-node tested, and Velocity console control supports route reloads without proxy restarts. Existing Discord/session/database/encryption credentials are preserved. The creation form records explicit EULA consent only when submitting a creation job; pending and incomplete-cleanup jobs count against the account's plan.

A real authenticated website creation passed, including public exact-backend status, DNS SRV, encrypted console commands/logs, metrics/settings, and jailed file upload/download/rename/delete. A deliberate final-registration failure exercised VM, DNS, Velocity and SFTP cleanup; a separate interrupted-job check exercised startup recovery. Testing found and fixed the gateway's missing Node.js assumption and the worker's missing SFTP deletion permission. Startup retries incomplete failed-job cleanup as well as interrupted jobs. All temporary validation VMs, DNS/routes, gateway users and diagnostic job history were removed; existing servers remained online.

The worker supports automatic placement across **pve02 and pve03** using `HOSTING_PROXMOX_NODES=pve02,pve03`. Before cloning, it checks each node's observed CPU load, logical CPU count, available RAM, and active shared `truenas` storage. It excludes nodes that cannot fit the requested vCPU/RAM/disk, reserves 2 GiB of node RAM and 2 GiB of storage headroom, and minimizes the combined projected CPU and RAM utilization. Both nodes need the same VM network bridge and access to shared storage. The worker token needs node-audit access on both nodes, in addition to its scoped VM/pool/storage permissions.

Template and Velocity locations are discovered from the cluster rather than assumed to be on pve02. Cross-node clones are requested on the template's current node; configuration, guest commands, and cleanup use the chosen target node. Task polling follows the node encoded in the Proxmox task ID. Each private job journal records its selected node before cloning.

This is **new-server placement**, not automatic live migration or combining both machines' RAM/CPUs for a single VM. Existing servers are not moved or restarted. Manual Proxmox migration of completed VMs must preserve their network, disk, guest IP, and SSH identity. Backend management uses pinned SSH over the guest IP, not a fixed Proxmox node.

Worker credentials belong in a protected worker-only environment: Proxmox and Cloudflare tokens must not be added to the public website process. See the worker settings documented in `.env.example`. The deployed `blockhost-provisioner.service` uses its own non-login OS user, root-owned code in `/opt/blockhost-provisioner`, a root-readable `/etc/blockhost-provisioner/worker.env`, and private journals in `/var/lib/blockhost-provisioner`. Its restricted PostgreSQL role cannot read OAuth sessions. The deletion upgrade grants it deletion of registered hosted-server records and access to the deletion queue; the worker removes registrations only after verified resource teardown. Its separate SFTPGo API identity has only `view_users`, `add_users`, `edit_users`, and `del_users`, restricted to the website host's IP; the website's existing API identity does not gain deletion permission.

`scripts/install-provisioner.cjs` is a root-only, Debian deployment helper for an operator-staged release. The bundle must contain built `dist/`, `source/`, locked runtime `node_modules/`, both package manifests, `provisioning-schema.sql` (the combined exported `provisioningSchema` and `deletionSchema`), `pve-root-ca.pem`, and a mode-0600 `worker-input.json` containing an `environment` object with the documented worker settings and dedicated SFTPGo credentials. Install dependencies as the unprivileged staging user, never as root. Run `sudo node scripts/install-provisioner.cjs /absolute/staged/release` on the website host. It preserves website secrets, backs up the old website, creates the worker identity/grants/service, and leaves creation disabled. Inspect failures before retrying; it refuses an existing installation rather than replacing credentials. The `--update` path requires a protected `worker-update.json` with the dedicated gateway `username` and `password`, updates root-owned worker code, and restarts only the worker.

### Permanent hosted-server deletion

Owners and site administrators can select **Delete server** under **Your servers** and type the exact server address. This is irreversible: it removes the VM and its disks/worlds/plugins, DNS records, Velocity route and both SFTP accounts. It does not create a backup. Deletion does not require an assigned plan, but does require a healthy worker. Console/power/files/settings and new SFTP access are blocked immediately after queuing; existing SFTP access grants are revoked.

Deletion runs through a separate durable queue, serialized with provisioning. Before teardown the worker checks its private ownership manifest against the registered owner, VM identity and disk namespace, DNS IDs/comments, Velocity target and SFTP owner/backend/host pin. Missing resources are safe on retry; ownership mismatches fail explicitly without guessing. Incomplete cleanup stays registered and continues consuming its server quota/address/hostname. **Retry deletion** resumes cleanup after a failure. Interrupted running deletions resume on worker startup. Registration and provisioning hostname reservations are released atomically only after cleanup; private IP reservations are reconciled on startup even if the worker crashed immediately after that commit.

An owner-approved disposable server was provisioned on pve03 and verified to have a generated world and the correct publicly routed backend, then removed through the deletion worker. Verification confirmed the VM and both disks were gone, DNS/Velocity and both SFTP accounts were removed, registration was cleared, and the hostname could be reserved again. The two original test servers remained running.

Automatically provisioned servers use their private creation journals. Older manually registered servers need an operator-verified `/etc/blockhost-provisioner/adopted-servers.json` (root-owned, worker-group-readable, mode `0640`). This is an array of `DeletionTarget` records from `server/deletion-worker.ts`, containing the exact registered server/owner/address/IP/pin, VM ID/node/name/description, Velocity key and DNS record IDs/names/comments. Verify backend SSH host keys, VM disks, proxy mapping, DNS and SFTP identities before adoption; never derive deletion authority from a hostname/IP alone. Only an explicitly verified legacy manifest may set `legacyWebUserWithoutOwner` for an old private `web-<id>` account lacking an owner marker; its exact username/backend/host pin still must match, and public SFTP accounts always require the owner marker. Without a trusted record the worker refuses deletion. After manually migrating a VM, review its private deletion identity/node before requesting deletion.

For the first deletion upgrade of an existing installation, stage `dist/`, `source/`, this installer, the combined `provisioning-schema.sql`, and verified `adopted-servers.json` (or `[]` if no legacy servers). With creation jobs idle, run `sudo node scripts/install-provisioner.cjs /absolute/staged/release --upgrade-deletion`. It backs up website code, applies the schema/minimal worker grants, installs private legacy identities and root-owned worker code, and briefly restarts the website and worker. It preserves both environments/credentials, does not restart Minecraft/Velocity, and does not request deletion of any server. Inspect failures before recovery; it refuses to overwrite an existing adoption file.

Use `/healthz`, the worker heartbeat, `systemctl status blockhost-provisioner`, and root-access `journalctl -u blockhost-provisioner` for diagnostics. A stale heartbeat prevents new creation requests. **This is a controlled beta, not a general-public launch:** backups/restore testing, tenant private-network egress isolation, operational alert delivery, and a second-account live acceptance test remain outstanding.
