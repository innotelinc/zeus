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
| `ava_routes.py` | Converge each platform DID's FreePBX inbound route onto `zeus-ai-router,s,1`, from the same plan that renders `[zeus-ai-accounts]` — see [One ingress](#one-ingress-every-platform-did-reaches-the-router). `--check` / `--apply`, `--routes-tsv` to judge off-host, `--create-missing` to create a route for a DID that has none (via FreePBX's own API). Exit 1 = an apply converges it, 3 = only a person can |
| `ava_ari_check.py` | Does the engine and the PBX share one ARI secret? `--require-engine-env` is the mode the compose preflight runs — see [Voice plane gates](#voice-plane-gates-and-d7-assertions) |
| `d7_assert.py` | The three D7 claims about the live stack (call recorded, both ARI apps registered, one gateway serving the configured model). `--call` places a self-contained probe call. Exit 2 = nothing could be evaluated |
| `p0-snapshot.sh` | Records the live pre-state (containers, PBX files with hashes, routes, units, CDR watermark) before a change, in the `/root/revert-to-1510/` shape |
| `patch-freepbx-trunk-next-id.py` | The `Core::addTrunk` next-id fix, with a `--container` mode the host can use without an image rebuild — see [docs/freepbx-trunk-repair.md](../docs/freepbx-trunk-repair.md) |
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

**One owner per ARI user — a duplicate costs every user.** `ari.conf`
`#include`s `ari_additional_custom.conf`, so a user defined in both is a
duplicate object and sorcery refuses the *whole* file:

```
ERROR res_sorcery_config.c: Config file 'ari.conf' could not be loaded;
configuration contains a duplicate object: 'zeus-ava' of type 'user'
```

Every ARI credential then fails with **401**, which reads exactly like a wrong
password. Worse, it is invisible until the next fresh Asterisk start: a reload
keeps serving the users already in memory, so a container recreate is what
finally surfaces it. Zeus's AVA user therefore lives *only* in
`ari_additional_custom.conf` — `ari.conf` carries `[pbxportal]` and nothing
else. Converge does not delete a section that leaves its source, so retiring
one is a manual edit plus a reload.

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

## One ingress: every platform DID reaches the router

P1 of [docs/ava-capstone-convergence.md](../docs/ava-capstone-convergence.md) is
*one ingress*: AVA answers every DID the platform sells, and Capstone becomes a
capability AVA can reach rather than the front door. That is two independent
halves, and rendering one of them looks finished while calls still land wrong:

1. **`[zeus-ai-accounts]`** — one entry per active DID, carrying `AI_AGENT`,
   `AI_PROVIDER` and the `ZEUS_CAPSTONE_ADDON` gate. `bootstrap-zeus-pbx.sh`
   renders it on every run from the portal's own answer
   (`GET /api/admin/voice-routing`, which re-checks the gate against Magnate)
   and falls back to the portal's cached database when the portal is down —
   never the other way round, because the cache freezes the plan at whatever it
   was when someone last opened the screen.
2. **The inbound route per DID** — a row in FreePBX's `incoming` table. A route
   that points somewhere else still answers a call, just as the wrong thing;
   that is how a deployment came to have every DID unwired while both products
   believed the numbers were routed. `pbx/ava_routes.py` owns this half.

```bash
# judge / converge the routes on the live PBX (reads the same plan the accounts
# block is rendered from — --db or --accounts-json, exactly like ava_routing.py)
python3 pbx/ava_routes.py --db /var/lib/docker/volumes/zeus-portal-data/_data/pbx.db --check
python3 pbx/ava_routes.py --db … --apply --revert-out /root/zeus-route-revert.sql

# a DID the plan names but FreePBX has no route for at all: the absent row is
# created through FreePBX's own create path (below), never an INSERT of ours
python3 pbx/ava_routes.py --db … --apply --create-missing

# off-host, against a route table dumped by pbx/p0-snapshot.sh (check-only)
python3 pbx/ava_routes.py --db … --routes-tsv routes/incoming.tsv --check
```

`bootstrap-zeus-pbx.sh` calls it on **both** paths: `--check` reports route drift
and fails the run, and an apply converges the routes **before** `fwconsole
reload` — they are rows FreePBX builds its dialplan from, so a change is live
only once the dialplan is rebuilt. Judging and applying are separate steps on
purpose (`judge_routes` / `converge_routes` in the bootstrap), because the timer
runs *check, then apply when that fails*: an apply that judged only the fragments
would answer "already in sync" on a PBX whose files match and whose DIDs all
point elsewhere, and would never have cleared itself.

The tool's status is carried through whole, because three of them mean three
different things to a caller:

| status | meaning | what the caller does |
| --- | --- | --- |
| `0` | every platform DID reaches the router | nothing |
| `1` | routes off it | apply — it converges them |
| `3` | a platform DID with no route, or two | nothing a *default* apply can do; add the route in FreePBX, or run `--create-missing` (the check keeps failing until then) |
| `2` | no PBX reachable / table unreadable | nothing — a host running part of the group is not a drifted host |

A `3` deliberately does **not** send the bootstrap down its apply path: an apply
for it rewrites no row and still reloads a live phone system, so a 15-minute
timer would do exactly that forever. It is not quiet either — `--check` fails on
it (with a message naming the FreePBX step rather than the apply), and the
wrapper puts the apply's own output in the journal when it refuses.

What the tool will not do, deliberately:

- **A default apply never invents a route.** A DID with no inbound route at all
  (or two) is refused by name: a hand-written `incoming` row means guessing its
  other fifteen columns, and a half-written row on a live phone system is worse
  than a named gap. It stays visible — `--check` keeps failing until the route
  exists.
- **`--create-missing` is the one, deliberate exception, and it is not a
  guess.** It calls FreePBX's *own* create path (`FreePBX::Core()->addDID`) inside
  the PBX container, so the columns this tool does not model are filled by the
  same code the GUI's "Add Inbound Route" page runs, hooks included. It needs an
  explicit `--apply`, is refused offline (`--routes-tsv`/`--sql-out` cannot call
  a framework), and its undo is a `DELETE` in the same revert script — so a mixed
  run still undoes as one thing. The timer never passes it: a row this tool had
  no evidence for belongs in a one-off run, not a periodic one.
- **It only touches DIDs the plan names.** A ring group, a partner's number and
  a pattern route like `_2XX` are somebody else's phone service, and the tool
  reports them as *left alone* so that is evidence rather than an assumption.
- **It writes the undo before it writes anything.** The revert script is
  produced first and its failure is fatal, because an apply with no way back is
  what P0's snapshot discipline exists to prevent.
- **It reads the application context, never the Stasis app name.** The route
  targets a Custom Destination (`zeus-ai-router,s,1`), so nothing in the
  dialplan depends on Capstone's runtime-generated `Stasis(dograh_<suffix>)`.

An apply that cannot finish (a refused row) warns and continues rather than
failing the fragment apply, for the same reason the core-module repair does: the
phone system is already answered by the fragments, and stopping there would take
calls down over a row the operator can add. The drift check is what keeps it
from going quiet.

## Voice plane gates and D7 assertions

Two things about the voice plane fail *silently* — a PBX that looks healthy while
it drops its calls, and a check that reports success because it never ran. Both
gates below exist for that reason, and both are runnable from the host without a
rebuild.

### `voice-preflight` — the ARI credential must agree before the engine starts

The engine authenticates to Asterisk with `AVA_ARI_SECRET`, which two unrelated
things write: `bootstrap-zeus-pbx.sh` renders it into `ari.conf` from
`scripts/pbx.env`, and `.env` hands it to the container. Nothing reconciles them,
and a blank `pbx.env` value is *regenerated* on every bootstrap run — so a
`--profile voice up` can start an engine whose password Asterisk will never
accept, and the only symptom is calls that are never answered (to Asterisk a
wrong password is just a failed login, so nothing names the credential).

`docker-compose.yml`'s `voice-preflight` is a one-shot container that asserts the
two agree, and `ai-engine` declares
`depends_on: voice-preflight: condition: service_completed_successfully` — the
engine is not started unless the gate exits 0:

```bash
docker compose --profile voice up -d      # gate runs first, engine starts only if it passes
docker compose logs voice-preflight       # on failure: which file, which key, what to do
python3 pbx/ava_ari_check.py --require-engine-env   # the same assertion, by hand
```

Three details that are load-bearing:

- **The gate runs as root (`user: "0:0"`).** `.env` is curated `0600` root-owned
  and `pbx.env` is written by the bootstrap. The engine image's own user is
  `appuser`, and inheriting it made the gate fail on a *consistent* host — the
  uid was wrong, not the configuration. The check reports a permission problem
  in its own words (`Unreadable`) rather than misreporting it as a missing file.
- **`--require-engine-env` is what makes it a gate.** Without it, "there is no
  `.env` here" is a pass — correct for a deploy-script check that also runs on
  portal-only hosts, wrong for a container that only exists because somebody
  asked for the voice profile.
- **A missing bind source reads as absent, not as a crash.** Docker creates a
  *directory* where a bind source does not exist, so "the operator never created
  `.env`" arrives as `IsADirectoryError`; the check treats that as the absent file
  it is (`_read` in `pbx/ava_ari_check.py`).

The same assertion stands in front of the **apply**, not just the engine's
start-up: `systemd/zeus-pbx-sync.service` runs `scripts/zeus-pbx-sync.sh`, which
checks the credential first and exits 1 rather than re-applying fragments over a
secret the PBX will refuse (see [docs/ava-runbook.md](../docs/ava-runbook.md)).
The unit used to call `pbx/bootstrap-zeus-pbx.sh` directly, so the gate was
documented and never ran on the path that actually writes the fragments;
`scripts/tests/test_pbx_sync_unit.py` pins the wiring now.

### `d7_assert.py` — the three claims, asserted rather than assumed

```bash
python3 pbx/d7_assert.py --live                  # ARI apps, CDR backend, gateway model
python3 pbx/d7_assert.py --live --call           # also prove CDR actually writes
python3 pbx/d7_assert.py --live --only gateway   # one assertion only
./scripts/smoke-test.sh voice                    # the same, via the smoke test
D7_CALL=1 ./scripts/smoke-test.sh voice          # …including the probe call
```

| Assertion | Why it is not a style check |
|---|---|
| Both Stasis apps registered (`asterisk-ai-voice-agent`, `dograh_*`) | An engine that is up but unregistered answers no calls, and looks identical to an idle one |
| CDR backend wired **and** writing | `odbc show` proves the DSN is connected; only a call proves rows are written. CDR was dead on this estate for nine days with every other indicator green |
| The gateway offers `AVA_LLM_MODEL` | A gateway that 502s a model returns an HTML page, so the pipeline dies on its first turn with nothing naming the cause |

The probe call is `Local/12@default`: it matches FreePBX's `_X.` catch-all,
answers, plays the voicemail goodbye prompt and hangs up. No trunk, no phone, no
agent — a probe that could reach a real agent would not be a probe. Exit codes
are three-valued on purpose: `0` holds, `1` is false, and `2` means *nothing was
evaluated* (no docker, no PBX container, no `.env`), which is not evidence of
health and is why the summary line repeats what it did not evaluate.

### `p0-snapshot.sh` — record the pre-state before touching a live box

```bash
pbx/p0-snapshot.sh                        # → /root/p0-snapshot-<UTC>/ + MANIFEST
OUT=/root/before-p1 pbx/p0-snapshot.sh    # name the phase's pre-state yourself
PBX_CONTAINER=zeus-freepbx pbx/p0-snapshot.sh   # when autodetection is ambiguous
```

It captures containers, the PBX fragment files **with hashes**, inbound routes,
units, runtime state and a CDR watermark, and it is read-only: it copies files
out and runs `show` commands, never a write. Exit 0 means a snapshot was taken
even if a probe failed — a partial record beats none, and every gap is named in
`MANIFEST` — while exit 2 means there is no PBX to record at all.

Two traps it encodes, both of which cost a measurement: CDRs are **not** in the
`asterisk` database (FreePBX keeps them in `asteriskcdrdb`, which is what the
ODBC DSN names), and the CDR watermark is the *(count, newest)* pair — a count
alone cannot distinguish the probe from unrelated traffic.

### Rehearsing the first sync run

The apply/check pair can be rehearsed with no PBX at all, against a scratch
Asterisk directory and a throwaway `pbx.env`. That is what to run before
re-enabling `zeus-pbx-sync.timer` on a live box, or after any change under
`pbx/asterisk/`:

```bash
python3 -m unittest discover -s pbx/tests -p 'test_bootstrap_zeus_pbx.py' -v
```

It pins the four things a first timer run depends on: the apply lands exactly the
fragments this script owns, a second apply changes **no byte**, the `--check` that
follows does agree, and `--check` writes nothing — including on a target that has
no converge-owned file yet, where it used to leave an empty
`ari_additional_custom.conf` behind while reporting drift. The two ownership rules
are asserted in the rendered set rather than in the comments above it:
`manager_custom.conf` (FreePBX's `ucp_events` and the estate's `[pbxportal]` users
live in it) and `rtp_custom.conf` are never written from here. No container and no
`/etc/asterisk`, and the core-module patcher is pointed at a path that does not
exist, so the test is safe to run on the PBX host itself.

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