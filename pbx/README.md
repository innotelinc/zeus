# Zeus — PBX layer (`pbx/`)

The version-controlled Asterisk/FreePBX scaffolding for the Zeus voice plane —
mirroring the Capstone `pbx/` convention so the two platforms share one
operational shape.

## What lives here

| Path | Purpose |
|---|---|
| `asterisk/manager_custom.conf` | AMI user for the portal, with a deny-by-default permit list. **Entrypoint-owned** — `bootstrap-zeus-pbx.sh` skips it: `docker-entrypoint-full.sh` rewrites the secrets, re-adds UCP's `[ucp_events]` user and normalises the permits on every boot, while FreePBX's `ucp` module and the estate's own `[pbxportal]` user live in the same file. A wholesale copy from bootstrap deleted both and then flapped against the next container boot. Bare metal's owner is `scripts/setup.sh` |
| `asterisk/ari.conf` | `[pbxportal]` ARI user section — **converged into the real `/etc/asterisk/ari.conf`** (see below) |
| `asterisk/http_custom.conf` | Asterisk HTTP server + WebSocket transport for the WebRTC softphone (genuinely included). Deliberately does **not** set `enablestatic`: FreePBX's http module already owns `[general]` in `http_additional.conf` (included before this file) and ships `enablestatic=no` |
| `asterisk/rtp_custom.conf` | RTP media plane: canonical `stunaddr`/`icesupport` + `rtpstart`/`rtpend` cap. **Entrypoint-owned** — `bootstrap-zeus-pbx.sh` skips it; `docker-entrypoint-full.sh`/`scripts/setup.sh` derive it from `FREEPBX_RTP_PORT_*` + `PJSIP_STUN_TURN_ADDR` on every boot. Mirrored by the Capstone repo so both products cap one range |
| `asterisk/extensions_custom.conf` | Portal dialplan context (`[from-zeus-portal]`) — converge-owned |
| `setup-cloudonix-trunk.sh` | Peer a Cloudonix domain with this PBX (`pjsip_custom_cloudonix.conf` + `extensions_custom_cloudonix.conf`), **script-owned** — `bootstrap-zeus-pbx.sh` skips both files, and `docker-entrypoint-full.sh` calls this on boot. `--check` drift mode |
| `bootstrap-zeus-pbx.sh` | Render + apply the fragments idempotently; `--check` drift mode |
| `asterisk_converge.py` | Per-section merge for the **shared** `extensions_custom.conf` / `ari.conf` (ownership markers) |
| `MSTeams-DR-Wizard.sh` | MS Teams Direct Routing wizard (vendored from [Vince-0/MSTeams-FreePBX](https://github.com/Vince-0/MSTeams-FreePBX), MIT) — configures the native `external_signaling_hostname` PJSIP transport (Asterisk 20.21+/22.11+/23.5+/24+), endpoint/AOR/identify for the Microsoft SIP proxies, RSA cert wiring, `--check` audit |
| `cerulean-msteams.sh` | Cerulean trust-plane adapter: provisions the SBC DNS record + RSA-2048 DNS-01 certificate, then chains into the wizard |
| `tests/test_asterisk_converge.py` | Unit tests for the converge tool (`python3 -m unittest discover -s pbx/tests`) |

## Shared voice plane (`asterisk_converge.py`)

`extensions_custom.conf` is the one file both Zeus and Capstone write into:
FreePBX regenerates `extensions.conf` on Apply Config but never the
`*_custom.conf` include, so contexts in it survive GUI reloads. Once capstone
agents (`[dograh-inbound]`, `8000`–`8007` dialing) live in that file, a
wholesale copy by either product silently drops the other's contexts — so
zeus's bootstrap routes it through `pbx/asterisk_converge.py`:

- contexts zeus owns (`[from-zeus-portal]`) **replace** wholesale. The
  comment/blank run already above the replaced header is preserved (it may
  document the section or trail the previous owner's block), so a re-apply
  never eats another product's comments; the source's own doc prefix is
  installed only when the target has none.
- `[from-internal-custom]` is **append-shared**: each product's lines are
  added under `; >>> begin <owner>` / `; >>> end <owner>` markers so a
  product only ever rewrites its own segment. An existing segment is
  refreshed **in place** — never stripped and re-appended at the tail — so
  re-applying either owner alone is byte-idempotent and leaves the other
  owner's segment exactly where it was. When adopting converge on a PBX that
  predates it (legacy entrypoints injected the fragment with no markers), a
  byte-identical legacy copy of the owner's own body is absorbed into the
  marked segment instead of being duplicated.

### Shared `ari.conf`

`ari.conf` is the second converge-owned file. On the pbx-portal fullstack
image `ari.conf` is a **plain file with no `#include`** of any
`ari_*_custom.conf` — verified live: `fwconsole reload` never regenerates it
and Asterisk reads it as-is. Copying a rendered `ari_custom.conf` next to it
does nothing (Capstone shipped with a dead ARI user this way until it was
converged). Zeus's fragment therefore carries only its own `[pbxportal]`
section and converges it **into** the real file, so FreePBX's `[general]` and
any other product's ARI users (e.g. capstone's `[dograh]`) pass through
untouched.

On a shared PBX run the tool once per product (the zeus half is already
wired into `bootstrap-zeus-pbx.sh`):

```bash
# zeus half (secret-rendered, drift-checked, reloads the PBX)
pbx/bootstrap-zeus-pbx.sh

# capstone half — point --source at the capstone checkout's fragment
python3 pbx/asterisk_converge.py \
  --target /etc/asterisk/extensions_custom.conf \
  --source <capstone-repo>/pbx/asterisk/extensions_custom.conf \
  --owner capstone --append from-internal-custom

# capstone ARI half (same pattern, ari.conf target)
python3 pbx/asterisk_converge.py \
  --target /etc/asterisk/ari.conf \
  --source <capstone-repo>/pbx/asterisk/ari.conf \
  --owner capstone
```

## Cloudonix SIP peering (dograh's carrier, over plain SIP)

Dograh can carry calls over Cloudonix's own websocket transport, which needs
Dograh's hosted service. `pbx/setup-cloudonix-trunk.sh` wires the other option —
plain SIP — by trusting the Cloudonix regional edge as a pjsip peer:

```bash
pbx/setup-cloudonix-trunk.sh            # apply (idempotent, reloads the PBX)
pbx/setup-cloudonix-trunk.sh --check    # drift check only, exit 1 if out of sync
```

The script exists because the **live** PBX is owned by this stack
(`docker-compose.full.yml` → `freepbx`), whose entrypoint is baked into the
published image — a SIP peer change should not need a 45–90 minute rebuild. It
is the Zeus counterpart of Capstone's `pbx/entrypoint-dograh.sh`
`setup_cloudonix_trunk()`, which plays the same role for Capstone's standalone
PBX. `docker-entrypoint-full.sh` calls it on boot when `CLOUDONIX_*` is set, so
the box also self-heals.

What it writes:

- `pjsip_custom_cloudonix.conf` — `[cloudonix-identify]` (trusts the edge),
  `[cloudonix-endpoint]` (`context=from-trunk`), `[cloudonix-aor]` (static
  contact to `sip.cloudonix.net:5060`, `qualify_frequency=60`), plus an optional
  `[cloudonix-reg]`/`[cloudonix-auth]` pair in registration mode.
- `extensions_custom_cloudonix.conf` — the explicit `CLOUDONIX_DIDS`
  (`did:agent-ext`) routes, and the same catch-all the VoIP.ms trunk keeps.

Both files are kept alive by `#include` lines the script appends to
`pjsip_custom_post.conf` / `extensions_custom.conf` (FreePBX never manages
them, so they survive Apply Config).

Two ways to admit Cloudonix traffic, both may be on at once:

- **IP identity** (default): `CLOUDONIX_EDGE_IP` defaults to the Global edge IP
  Dograh's own region table publishes
  (`api/services/telephony/providers/cloudonix/regions.py`), so PBX and
  platform agree on the peer with no extra configuration.
- **Registration** (NAT-friendly, mirrors the VoIP.ms trunk): set
  `CLOUDONIX_SIP_USER`/`CLOUDONIX_SIP_PASS` and the trunk registers out, so
  inbound calls arrive on that registration and no inbound 5060 port-forward is
  needed.

### Verifying the peering

The AOR's qualify is the liveness proof — the PBX sends SIP OPTIONS to the edge
and reports the round trip:

```bash
docker exec zeus-freepbx asterisk -rx 'pjsip show aor cloudonix-aor'
# Contact: cloudonix-aor/sip:sip.cloudonix.net:5060  <hash>  Avail  127.0xx

docker exec zeus-freepbx asterisk -rx 'pjsip show endpoint cloudonix-endpoint'
```

`Avail` with an RTT means the path works. Expect `Unavail`/`nan` for up to one
`qualify_frequency` (60s) after a reload — that is the first OPTIONS still in
flight, not a broken peer.

### Inbound PSTN DIDs

Real DID routes come from FreePBX's incoming-route table (Connectivity →
Inbound Routes), not from the fragments above: the Cloudonix endpoint's context
is `[from-trunk]`, so a hit is matched there and sent to `[dograh-inbound]`
`<ext>`, which Capstone's converge half owns. `VOIPMS_DIDS` in the stack `.env`
(`did:ext,did:ext`) records the mapping the repo expects — the VoIP.ms DID
`4132643964` is routed to dograh agent `8000` that way. `capstone`'s
`scripts/sync_dograh_routes.py` re-creates those rows from Dograh's own
`telephony_phone_numbers` when its API is reachable.

## RTP media plane (one range for both products)

Zeus owns the RTP plane: on a shared box every consumer — Zeus softphones/portal
and the Capstone agent add-on — rides **one** range, `10101-10120/udp` by
default. The Capstone `pbx/` layer mirrors this file and these env names, so both
products cap Asterisk identically.

Three things must agree, and all three are driven from `.env`:

| Layer | Value | Set by |
|---|---|---|
| Host publish | `${FREEPBX_RTP_PORT_START:-10101}-${FREEPBX_RTP_PORT_END:-10120}` → `10101-10120/udp` | `docker-compose.full.yml` (`freepbx.ports`) |
| File fallback | `stunaddr` / `icesupport` / `rtpstart` / `rtpend` | `docker-entrypoint-full.sh` → `/etc/asterisk/rtp_custom.conf` |
| Settings DB | `kvstore_Sipsettings.rtpstart` / `.rtpend` | same entrypoint, every boot |

The **DB row is what actually sticks**: FreePBX's Sipsettings module regenerates
`rtp_additional.conf` from it on every *Apply Config*, and Asterisk reads configs
*first-wins* — so an included `rtp_custom.conf` alone is shadowed by the generated
file. Without the DB write Asterisk silently reverts to FreePBX's default
(`10000-20000`), which is **not published** and yields one-way or dead audio. The
Capstone twin carries the identical write.

`rtp_custom.conf` is **entrypoint-owned**, not bootstrap-owned: the runtime
(`docker-entrypoint-full.sh` in Docker, `scripts/setup.sh` bare-metal) rewrites
it from `.env` on every boot, so `bootstrap-zeus-pbx.sh` deliberately skips it —
a static copy would fight a non-default range and always report drift. The repo
file is the shape reference.

It also carries the STUN/TURN address (`stunaddr`), set from
`PJSIP_STUN_TURN_ADDR`; the `coturn` compose service name is only a last-resort
fallback and the entrypoint warns when it is used.

> **Addressing rule — LAN IPs only.** Docker addresses do not work for this
> project: `host.docker.internal` does not resolve inside the containers here
> (there is no `extra_hosts` entry — the lookup simply fails), and a bridge or
> service name is not something another host, NPM or a SIP peer can rely on.
> Set every service target to this host's LAN IP: `LAN_IP`,
> `PJSIP_STUN_TURN_ADDR` (`192.168.x.x:3478`), `PJSIP_LOCAL_NETS` (that LAN
> subnet — never a docker range), `DOGRAH_WS_URI`, `NPM_UPSTREAM_HOST` and
> `NPM_HOST_IP`.
>
> The AMI permit follows the same rule: `manager_custom.conf` gets `permit =`
> lines for loopback **and the LAN subnet only**, never `172.16.0.0/12`. The
> portal runs with `network_mode: host` precisely so its AMI/FreePBX/AvantFax
> calls are sourced from the LAN IP; on the bridge they arrive from `172.31.x.x`
> and a docker range would have to be permitted. `docker-entrypoint-full.sh`
> normalises the permits on every boot (and adds the `FREEPBX_AMI_USER` section
> if the image never shipped it), and `AMI_PERMIT` overrides the subnet.
>
> The failure mode is silence, not an error: `host.docker.internal` makes
> `ast_sockaddr_resolve` fail and STUN is disabled, and a dead media WebSocket
> URI leaves calls connecting with no audio and nothing in the log. This box
> was also declaring `172.18.0.0/16` as a local network while its own network is
> `172.31.0.0/16`, so Asterisk treated a range that does not exist here as
> on-net.

Keep Webmin (TCP `10000`) and the TURN relay range (`49152-49251`) clear of the
RTP block, and keep the two sides of the compose mapping the same length (the
container side is fixed at `10101-10120` — what Asterisk binds). Changing the
range means updating the router forward too.

```bash
# what Asterisk actually bound, what compose published, and the durable row
cd <zeus-repo>
docker port zeus-freepbx | grep '/udp$'                     # published block
ASTERISK='docker exec zeus-freepbx asterisk -rx'
$ASTERISK 'rtp show settings' | grep -E 'Port (start|end)'  # effective range
# Asterisk only binds even ports, so 10101 shows up as 10102 — still in range.
docker exec zeus-freepbx cat /etc/asterisk/rtp_custom.conf
docker exec zeus-freepbx mysql -u root asterisk -N -B \
  -e "SELECT \`key\`,val FROM kvstore_Sipsettings WHERE \`key\` LIKE 'rtp%'"
```

`scripts/smoke-test.sh pbx` asserts the published block is exactly the effective
range and that no stale range (e.g. `10000-10100`, `10121-20000`) is exposed.

## TURN / WebRTC media (one relay for both products)

Zeus owns the TURN plane, the same way it owns RTP: `coturn` runs as this
stack's `coturn` service and is the single relay that Asterisk, both portals'
softphones, and every browser behind NAT use. The add-on's own `coturn` service
carries the `standalone` profile and stays down while Zeus is primary, so
there is exactly one process on 3478.

Three layers have to agree, and they are all written from `.env`:

| Layer | Where |
|---|---|
| coturn's auth pair + realm | `--user` / `--realm` in the `coturn` service |
| Asterisk's own ICE/STUN | `stunaddr` in `/etc/asterisk/rtp_custom.conf` → and the `kvstore_Sipsettings` row, which is what regenerates `rtp_additional.conf` |
| browsers' relay | the `webrtcstunaddr` / `webrtcturn*` rows in `kvstore_Sipsettings` |

`docker-entrypoint-full.sh` writes the DB rows on every boot. That is not
cosmetic: an Apply Config rebuilds `rtp_additional.conf` from that table, so a
file-only change is reverted the first time anyone opens the GUI — and the
credentials recorded there are what browsers are handed. Pointing them at a
stop'd relay is how WebRTC calls end up connecting with no audio.

```bash
docker port pbx-coturn | sort                       # 3478 tcp+udp AND 49152-49251/udp
docker logs pbx-coturn | grep -i realm              # which realm it advertises
docker exec pbx-freepbx asterisk -rx 'rtp show settings' | grep -A2 'STUN:'
docker exec pbx-freepbx mysql -u root asterisk -B \
  -e "SELECT \`key\`,val FROM kvstore_Sipsettings WHERE \`key\` LIKE '%turn%' OR \`key\`='stunaddr'"
```

Two failure modes are worth knowing, because both are silent:

* **Publishing only 3478.** 3478 carries the TURN *control* channel; relayed
  media is delivered to a relayed transport address inside
  `TURN_RELAY_PORT_START..END`. If that UDP range is not published (and
  forwarded on the router) every peer outside `pbx-net` — i.e. every real
  browser — sends into a closed port and calls are silent. This is why the
  `coturn` service publishes the range, not just the listening port.
* **Pinning `TURN_EXTERNAL_IP`.** The relay address coturn advertises is
  useless the moment the WAN IP changes, which on a residential link is a
  matter of when. Leave it empty and the coturn image's
  `detect-external-ip` (a DNS probe, evaluated on every start) keeps it
  current; set it only where that probe is blocked.

`TURN_RELAY_PORT_*` deliberately stays inside the kernel's ephemeral range
(`32768-60999`) to match the Capstone service, so the router forward and both
compose files stay interchangeable. Moving it is a coordinated change across
both products *and* the router.

## MS Teams Direct Routing (Cerulean trust plane)

Zeus PBXes can act as a **Microsoft Teams Direct Routing SBC** so Teams users get a
dial pad backed by the Zeus voice plane. Two scripts divide the work along the
stack's ownership lines:

| Script | Owns | What it does |
|---|---|---|
| `pbx/cerulean-msteams.sh` | **Cerulean (TrustOps)** — DNS + ACME | Upserts the SBC FQDN's public A record and issues the **RSA-2048** certificate via **DNS-01**. Two transports: **API mode** (set `CERULEAN_API_URL` — Cerulean's REST API drives BIND over SSH+nsupdate+TSIG and runs the ACME issuance; the adapter polls, downloads, and installs the material) and **direct mode** fallback (local RFC 2136 `nsupdate` + `certbot dns-rfc2136` from the PBX) |
| `pbx/MSTeams-DR-Wizard.sh` | **Asterisk/FreePBX** | Detects the Asterisk version, writes the `[transport-ms-teams-tls]` stanza (native `external_signaling_hostname`, no source patches), the `[MSTeams]` endpoint/AOR/identify (Microsoft SIP proxies + published IP ranges), and reloads PJSIP |

RSA-2048 is mandatory: MS Teams rejects ECDSA, and ECDSA certs make Asterisk
core-dump on Teams' periodic pings. DNS-01 needs no inbound `:80`, so it is safe
on a PBX that already serves TLS. In API mode Cerulean's material is installed
to `/etc/letsencrypt/live/<fqdn>/` (plus `/etc/asterisk/ssl/`) — the paths the
wizard detects natively — so the adapter needs **zero wizard patches**.

### Bring-up

```bash
cp scripts/pbx.env.example scripts/pbx.env
# fill the NPM_TSIG_* key (Cerulean BIND) — the CERULEAN_* vars fall back to it

pbx/cerulean-msteams.sh --check                       # trust-plane audit (DNS, TSIG, cert)
pbx/cerulean-msteams.sh --full --fqdn=teams.zeus.innotel.us
#   1. A record → Cerulean BIND (RFC 2136)
#   2. RSA-2048 cert via DNS-01
#   3. runs MSTeams-DR-Wizard.sh --fqdn=<fqdn> --use-existing-cert

pbx/MSTeams-DR-Wizard.sh --check --fqdn=teams.zeus.innotel.us   # full Asterisk-side audit
```

> **Bare-metal installs:** `scripts/setup.sh` runs the whole bring-up automatically at the
> end of the install when the SBC is configured in `pbx.env` — set `CERULEAN_SBC_FQDN`
> (or `MS_TEAMS_SBC_IP`) plus `CERULEAN_API_URL`/`CERULEAN_API_PASSWORD` (API mode) or
> the `CERULEAN_TSIG_*` key (direct mode, falls back to `NPM_TSIG_*`). No separate
> invocation needed; it is idempotent and safe to re-run.

Extra wizard flags pass through after `--` (e.g.
`pbx/cerulean-msteams.sh --full -- --greenfield --version=22` for a bare Debian 12
box). Granular modes: `--dns-only`, `--cert-only`, `--no-dns`, `--force-renew`,
`--dry-run`.

**API mode (recommended)** — point the adapter at your Cerulean portal and let
Cerulean drive BIND + ACME; nothing but the wizard runs on the PBX:

```bash
# in scripts/pbx.env
CERULEAN_API_URL=https://api.cerulean.innotel.us
CERULEAN_API_PASSWORD=...        # or CERULEAN_API_TOKEN for a bearer token
```

The adapter logs in (`POST /api/auth/login`), registers the zone if missing
(`POST /api/domains`), upserts the A record (`POST /api/domains/:id/records`),
requests the certificate (`POST /api/certificates` → poll `GET
/api/certificates/:id`), downloads the material (`GET /api/certificates/:id/material`)
and installs it where the wizard looks. Tenant scoping: `CERULEAN_TENANT`.

**Direct mode fallback** — no API reachable: the PBX nsupdates BIND and runs
certbot itself. Env: `CERULEAN_SBC_FQDN`, `CERULEAN_ZONE`, `CERULEAN_TSIG_*`
(fallback: the `NPM_TSIG_*` twins), `CERULEAN_LE_EMAIL`, `MS_TEAMS_SBC_IP` — see
`scripts/pbx.env.example`.

### After the wizard

1. Point MS Teams at the SBC (Teams admin center → Voice → Direct Routing):
   FQDN `teams.zeus.innotel.us`, enable the gateway, add the PSTN usage/voice routes.
2. Open **5061/tcp** to Microsoft's SIP signaling ranges — the wizard's
   `--check` reports the port status.
3. Route calls: inbound Teams → the wizard's endpoint context (`from-trunk` on
   FreePBX); outbound → send to the `[MSTeams]` endpoint.

### Teams admin side — scripted

The tenant-side steps (SBC gateway, PSTN usage, voice route, and optionally a
voice routing policy + phone number for a user) can be scripted with
[`scripts/msteams-teams-admin.ps1`](../scripts/msteams-teams-admin.ps1).
Microsoft Graph does **not** expose Direct Routing configuration — these are
Teams PowerShell module cmdlets. From any machine with `pwsh` (and a
Teams Administrator / Voice Administrator account):

```powershell
Install-Module MicrosoftTeams -Scope CurrentUser -Force   # once

# Preview everything (no changes):
./scripts/msteams-teams-admin.ps1 -Fqdn teams.zeus.innotel.us -TenantId <id> -WhatIf

# Create/enable the SBC gateway + usage + voice route:
./scripts/msteams-teams-admin.ps1 -Fqdn teams.zeus.innotel.us -TenantId <id>

# Also create a routing policy, enable a user for Direct Routing and
# assign their phone number (user needs a Teams Phone license):
./scripts/msteams-teams-admin.ps1 -Fqdn teams.zeus.innotel.us -TenantId <id> `
  -VoiceRoutingPolicyName "Zeus Voice" -UserPrincipalName user@zeus.innotel.us `
  -PhoneNumber +15125550123
```

The script is idempotent (re-runs update in place) and accepts `TEAMS_SBC_FQDN`,
`TEAMS_TENANT_ID`, `TEAMS_ROUTE_NAME`, `TEAMS_NUMBER_PATTERN`, `TEAMS_PSTN_USAGE`,
`TEAMS_VOICE_ROUTING_POLICY`, `TEAMS_USER_UPN` and `TEAMS_USER_PHONE` env fallbacks.
After it runs, the SBC must complete a SIP OPTIONS handshake on 5061/tcp to show
**Active** in Teams admin center → Voice → Direct Routing.

### Docker deployment (`docker-compose.full.yml`)

The full-stack image (`ghcr.io/innotelinc/zeus:latest-fullstack`, Asterisk
**22.11.0** — at/above the wizard's native-support floor) and the compose file
already publishes **5061/tcp**, so the whole bring-up runs inside the `freepbx`
container:

1. **Tooling is mounted** — `docker-compose.full.yml` mounts `./pbx` read-only
   into the container at `/opt/zeus/pbx`, so both scripts are available.
2. **Install the container's missing CLI deps once** (Debian 12 base has `curl`
   + `openssl` already; API mode needs `jq`, and the wizard's DNS check needs
   `dig`/`nsupdate` from `dnsutils`; direct mode's certbot auto-installs):
   ```bash
   docker compose -f docker-compose.full.yml exec freepbx \
     apt-get update -q && docker compose -f docker-compose.full.yml exec freepbx \
     apt-get install -y jq dnsutils
   ```
3. **Run the trust-plane adapter inside the container**, passing the credentials
   as env (or `-e PBX_ENV_FILE=/opt/zeus/pbx.env` if you mount a `pbx.env`):
   ```bash
   docker compose -f docker-compose.full.yml exec \
     -e CERULEAN_API_URL=https://api.cerulean.innotel.us \
     -e CERULEAN_API_PASSWORD=... \
     freepbx bash /opt/zeus/pbx/cerulean-msteams.sh \
       --full --fqdn=teams.zeus.innotel.us
   ```
   Direct mode: pass `CERULEAN_SBC_FQDN`/`MS_TEAMS_SBC_IP` + `CERULEAN_TSIG_*`
   (or the `NPM_TSIG_*` twins) the same way.
4. **Persistence is handled** — the wizard writes
   `pjsip.transports_custom_post.conf`/`pjsip.endpoint_custom_post.conf` and the
   adapter copies the cert to `/etc/asterisk/ssl/`, all under the
   `asterisk-config` volume, so the SBC config survives container recreates.
   (`/etc/letsencrypt/live` inside the container is ephemeral, but the wizard
   prefers `/etc/asterisk/ssl/cert.crt` when present.)
5. **Finish in Teams admin** exactly as bare metal: enable the gateway FQDN and
   add PSTN usage/voice routes. Port 5061 is already published by compose — just
   forward it at your edge/firewall to the Docker host.

Tests: `npm test` — includes wizard stanza + semver-gate tests against a fake
`asterisk` binary, adapter dry-run/audit tests, and a full API-mode integration
test against the committed mock (`scripts/fixtures/cerulean-api-mock.mjs`,
mirroring Cerulean's REST contract with a real RSA-2048 fixture certificate).

## Blocking invalid SIP registrations (fail2ban)

A PBX with a public 5060/udp is scanned within minutes of appearing and probed
forever after. Asterisk cannot reject that traffic on its own, and a ban applied
inside the container cannot work either — the container sits on `pbx-net` behind
Docker's NAT, so by the time Asterisk sees a packet Docker has already DNAT'd it.
The ban has to be applied on the **host**, in Docker's `DOCKER-USER` chain, which
is the first rule Docker inserts into `FORWARD` (before its own accepts and
before the conntrack accept for established flows).

```bash
sudo scripts/install-fail2ban.sh              # install, start, verify
sudo scripts/install-fail2ban.sh --status     # jails + live bans
sudo scripts/install-fail2ban.sh --dry-run    # preview the rendered jail
sudo scripts/install-fail2ban.sh --uninstall  # stop + remove
```

| File | Role |
|---|---|
| `pbx/fail2ban/jail.local.in` | jail template — rendered to `/etc/fail2ban/jail.local` with the log dir, `ignoreip` and ban policy substituted in |
| `pbx/fail2ban/filter.d/asterisk-security.conf` | matches `res_security_log` records, anchoring `<HOST>` on `RemoteAddress` (never `SuccessfulAuth`) |
| `pbx/fail2ban/filter.d/asterisk-registration.conf` | matches the `failed for '<ip>:<port>'` notices in `full` — the wider net, and the one that catches scanner waves |
| `pbx/fail2ban/action.d/docker-user.conf` | bans into `DOCKER-USER` (insert only when absent, so two jails on one address leave exactly one rule) |
| `scripts/install-fail2ban.sh` | host installer: volume, package, configs, service, verification |

**Policy.** `maxretry = 1`, `bantime = 172800` (48 h), `findtime = 3600` — the
first invalid registration from an address drops all of its traffic for two days.
Loopback and the auto-detected LAN are exempt so that a 48 h ban on the first bad
packet cannot lock out the operator's own softphone; three fresh bans in a week
escalate to 30 days through `recidive`. Override with `F2B_IGNOREIP`,
`F2B_BANTIME`, `F2B_MAXRETRY`, `F2B_LOG_DIR` (or `F2B_VOLUME` if the PBX volumes
are renamed).

**Wiring.** `docker-compose.full.yml` mounts the shared `pbx-asterisk-logs`
volume (the same name the Capstone add-on declares, so fail2ban reads one log
directory whichever stack owns the PBX) at
`/var/log/asterisk`, and `docker-entrypoint-full.sh` (baked into the image by
`Dockerfile.full`) adds `security => security` to `logger_logfiles_custom.conf`
— the include FreePBX keeps when it regenerates `logger.conf`, so an *Apply
Config* cannot silently disable the security log. The host daemon then reads
`security` and `full` straight off disk: no log shipper, no `docker exec`.

> **Related fix in the same entrypoint.** The stock UCP boot step wrote
> `UCPMGRPASS` only when the row was empty (`AND (value IS NULL OR value = '')`)
> while rewriting `manager_custom.conf` to the current secret. On an existing
> MariaDB volume those diverge permanently, so the UCP NodeJS server
> authenticates as `ucp_events` with a stale password forever — measured on the
> capstone twin at **100 % CPU with 72 restarts**. The entrypoint now converges
> the DB value onto the real secret and bounces UCP only when it changed.

## How it fits the stack

- **Bare metal** — `scripts/setup.sh` is the full FreePBX/fax installer and
  already leaves the box portal-ready (AMI, ARI, WSS, OAuth2). This layer is
  the version-controlled **source of truth** for those fragments, so a
  rebuilt box converges via `bootstrap-zeus-pbx.sh` instead of hand-edits.
- **Docker** — `docker-compose.full.yml` ships the `freepbx` service;
  `PBX_TARGET=container` applies the same fragments into it.

## Usage

```bash
cp scripts/pbx.env.example scripts/pbx.env   # fill FREEPBX_AMI_SECRET / FREEPBX_ARI_SECRET
pbx/bootstrap-zeus-pbx.sh                     # apply (idempotent)
pbx/bootstrap-zeus-pbx.sh --check             # drift check (cron / smoke)
PBX_TARGET=container pbx/bootstrap-zeus-pbx.sh
```

Secrets never live in git: the fragments are rendered at apply time from
`pbx.env` (or the environment). The `systemd/zeus-pbx-sync` unit runs the
drift check on a timer and re-applies when out of sync.