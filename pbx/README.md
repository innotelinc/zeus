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
| `dograh_routes.py` | Judge whether every DID the portal sells reaches a `dograh-inbound,<workflow>,1` row in FreePBX's own `incoming` table — see [One ingress](#one-ingress-every-platform-did-names-a-workflow). **Read-only, deliberately:** which workflow a DID should reach is a portal decision and the row is FreePBX's, so the tool names the disagreement instead of inventing a route. A DID the portal marks `fax_enabled` is excused the fax service's own destination, and `--incoming-tsv` judges a route table dumped by `p0-snapshot.sh` with no PBX reachable. Exit 1 = a DID is off the workflow or unrouted, 2 = cannot tell |
| `extension_mirror.py` | Judge whether every FreePBX user is an extension the portal's `freepbx_extensions` mirror names — **one direction only** (the mirror also carries rows the PBX does not own as users: the fax service lines, a demo softphone), read-only, `--users-tsv` judges a user table dumped by `p0-snapshot.sh` with no PBX reachable. Exit 1 = a phone nothing in the portal can manage, 2 = cannot tell — see [The portal's extension mirror](#the-portals-extension-mirror) |
| `media_address.py` | Keep the address Asterisk advertises to a LAN phone (`media_address` on each sip/pjsip endpoint) — **entrypoint-owned**, re-derived every boot by `docker-entrypoint-full.sh` / `scripts/setup.sh` and reconciled by the `zeus-pbx-sync` timer (`scripts/zeus-pbx-sync.sh`) so an image rebuild cannot lose it. Writes its own file `pjsip_media_custom.conf` and one `#include` in the portal-shared `pjsip.endpoint_custom_post.conf`; refuses a docker/loopback address. `--check` / `--apply`, `--devices-tsv` judges off-host. Exit 1 = an apply converges it, 2 = cannot tell — see [The media address Asterisk advertises](#the-media-address-asterisk-advertises-container--lan-phones) |
| `outbound_route.py` | Keep the route that normalises a dialled number — the one that gives a ten-digit call the `1` VoIP.ms terminates on. **Entrypoint-owned**, converged on boot by `docker-entrypoint-full.sh` / `scripts/setup.sh` and reconciled every tick by `scripts/zeus-pbx-sync.sh`. Creates the route (`PSTN` by default, `PBX_OUTBOUND_ROUTE` to rename) if missing, requires the two normalisation rules (ten-digit -> `1`, seven-digit -> `1413`) — preserving any extra patterns an existing route already has — attaches the VoIP.ms trunk first, and lifts the route above anything ahead of it that would take the same calls — a catch-all like `X.`, or a duplicate route pointed at another trunk. FreePBX evaluates routes in sequence order, so a route ahead swallows the call before the named route and its normalisation are reached. Refuses (exit 2) when there is no trunk row to attach. `--check` / `--apply`, `--local` for the in-container / bare-metal MySQL. Exit 1 = an apply converges it — see [The outbound route](#the-outbound-route-a-dialled-number-reaches-the-carrier) |
| `pjsip_owner_check.py` | Who owns the PJSIP endpoint for an extension — the load tree, the duplicate ids, and who carries the `#include`. Read-only, `--json` for the raw measurement, exit 1 on a two-owner state — see [Who owns a PJSIP endpoint](#who-owns-a-pjsip-endpoint) |
| `provision_extension.py` | **The one owner of extension/device creation** (D6): check-then-create through FreePBX's own `addDevice`/`addUser`, with a preflight that refuses on an orphaned `sip`/`pjsip` row, leftover `AMPUSER` state, a half-created extension or a two-owner endpoint. `--check` / `--apply`, `--observed-json` to judge off-host, exit 1 = an apply converges it, 3 = only a person can — see [One provisioning path](#one-provisioning-path-for-extensions) |
| `d7_assert.py` | The three D7 claims about the live stack (call recorded, Dograh's ARI app registered, one gateway serving the model pins this repo still holds — the summary path's `VOICEMAIL_SUMMARY_MODEL`, since the call path's belongs to Dograh). `--call` places a self-contained probe call. Exit 2 = nothing could be evaluated |
| `p0-snapshot.sh` | Records the live pre-state (containers, PBX files with hashes, routes, the users table, units, CDR watermark) before a change, in the `/root/revert-to-1510/` shape |
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

## The media address Asterisk advertises (container → LAN phones)

`external_media_address` in `pjsip.transports.conf` is the address handed to peers
**outside** `local_net` — the VoIP.ms and Cloudonix trunks — and for them it is
right. It does not cover the other half of the estate. For a peer **inside**
`local_net`, which is every desk phone on this LAN, Asterisk has to advertise its
own *local* address, and inside the container that address is the docker bridge.
Asterisk then answers an INVITE from `192.168.1.17` with

```
c=IN IP4 172.19.0.4
m=audio 10110 RTP/AVP 0 8 9 101
```

and the phone — which has no route into a docker subnet — sends its audio there.
The failure is one-way in the direction nobody notices: Asterisk keeps sending
toward the phone's real address, so the caller **hears** the voicemail prompts,
while their own voice and every DTMF digit are dropped, and `rtp_timeout=30`
hangs the call up at exactly thirty seconds. It arrives as *"my voicemail
touchtone does not work and it hangs up on me"*, and nothing else in this repo
can see it — the dialplan, the mailbox, the DSN and the trunks are all healthy,
because the trunks are the half that works.

Measured on `.30` (2026-09-25) with `rtp set debug on`: 1119 RTP packets sent to
the phone, **0 received**, `Got RTP packet from …` never once in the log, and
every `*97` call dead at 30 seconds. The TRUNK legs on the same box were
receiving RTP normally the whole time (`Strict RTP … Locking on source address
208.100.60.66:19892`), which is why it looked like a voicemail problem.

### The fix, and why it belongs per endpoint

`media_address` on the endpoint is the address Asterisk advertises for that
endpoint's media. It cannot go in `pjsip_custom.conf`: a `(+)` append must come
after its base section, and that file is included *before* the endpoints. It
goes in an operator-owned file FreePBX `#include`s *after* the generated
endpoints, so `(+)` appends to the endpoint FreePBX owns.

The obvious home — `pjsip.endpoint_custom_post.conf`, where the portal appends
its `[<ext>](+)` WebRTC settings — is the one place it must not go. The portal
treats **any** `[<ext>](+)` in that file as its own and cuts every one of them
when it re-provisions a softphone, so a media line written there is deleted the
first time somebody opens the Phone screen. It gets its own owner file instead,
`pjsip_media_custom.conf`, reached by one `#include` line in the portal-shared
file — a non-section line the portal's block-surgery neither reads nor cuts:

```
# pjsip.endpoint_custom_post.conf keeps the portal's blocks, plus:
#include pjsip_media_custom.conf
```

```
# pjsip_media_custom.conf — owned outright by pbx/media_address.py
[4135612020](+)
media_address=192.168.1.30
```

The RTP ports stay published on the host (`10101-10120/udp`, above), so a phone
sending to `192.168.1.30:<port>` is DNAT'd to the container's socket; and
`bind_rtp_to_media_address` must stay `false`, because the socket has to remain on
the container's interface. A phone that sends to *the address in the SDP* is
bypassing nothing — it is obeying the PBX.

**The trunks deliberately get no such line**, and that is the whole reason this
is per endpoint rather than one transport setting: they need the WAN address, so
no single `external_media_address` can serve both halves. This is also why the
estate's other addressing rules (`PJSIP_LOCAL_NETS`, `stunaddr`, the published
RTP block) do not cover it — each of them is about a peer Asterisk talks *to*,
and this is about the address Asterisk hands *out*.

```bash
# apply, then confirm the advert rather than the file
# (this Asterisk has no `pjsip reload` — it is `module reload res_pjsip.so`)
docker exec zeus-freepbx asterisk -rx 'module reload res_pjsip.so'
docker exec zeus-freepbx asterisk -rx 'pjsip show endpoint 4135612020' | grep '^ media_address'
```

**Its owner is `pbx/media_address.py`, and it runs on every boot.** The lines are
a fact about the running host — the LAN address and the set of endpoints FreePBX
has — so like `rtp_custom.conf` and the `local_net` lines they are re-derived
rather than copied from git: `docker-entrypoint-full.sh` (Docker) and
`scripts/setup.sh` (bare metal) both converge them, from `LAN_IP` (or
`PJSIP_MEDIA_ADDRESS`). The endpoint list is FreePBX's own `devices` table, and
an address in a docker, loopback or link-local range is refused by name rather
than written — an empty or wrong value is the bug, not a fix. Nothing writes the
file wholesale.

The `zeus-pbx-sync` timer converges it too (`scripts/zeus-pbx-sync.sh`: judged
every tick, applied on drift), because unlike a DID route this value is
auto-derivable and the tool is idempotent. That is the half that re-derives it on
a box whose image predates the entrypoint change: the timer's `OnBootSec` window
covers the boot, so such a box heals with no 45–90 minute image rebuild. The
judgement is never a failed unit — it reports, and applies.

**A phone the portal creates gets the line immediately, from the portal.** The
create and repair paths (`src/app/api/phone/extensions/route.ts`) write the same
`[<ext>](+) media_address=` section into the same `pjsip_media_custom.conf`, at
create time, so a phone added *between* boots is not deaf until the next restart
(`provisionMediaAddress` in `src/lib/pjsip-endpoint.ts`). The two writers render
byte-identical sections (`scripts/pjsip-endpoint.test.mjs` pins them), so the
portal's output is a fixed point of the tool's next boot rewrite — and the tool
still writes **every** endpoint with a `devices` row, including the one the
portal just added, because that file is the durable copy. The address line must
never live in the portal-shared `pjsip.endpoint_custom_post.conf`: the portal
cuts every `[<ext>](+)` in it, so a line written there is deleted the first time
a softphone is provisioned — which is exactly how the box came to have its media
addresses in the wrong file, re-added by hand.

```bash
# judge (0 in sync, 1 an apply converges it, 2 cannot tell), and converge by hand
python3 pbx/media_address.py --address 192.168.1.30 --check
python3 pbx/media_address.py --address 192.168.1.30 --apply
```

The Phone screen shows it as well: the readiness row carries `mediaAddress`
(`src/lib/extension-readiness.ts`, read by `readMediaAddress`) and names it when
it is missing, so an operator sees the address a phone is handed instead of
inferring it from a one-way call. Absent is a real, displayed answer — it is the
one-way-audio state.

The create path writes nothing when no reachable address reaches the *portal*
container, and that was its state on `.30` until this check: the compose file
passed `PJSIP_MEDIA_ADDRESS` to the PBX and not to the portal, so the
create-time write had never once run. `/api/health` now answers whether a
softphone created *now* would be handed a reachable address
(`services.softphone_media`, `src/lib/softphone-media-live.ts` — the same
`mediaAddressFromEnv` the create path uses), and `./scripts/smoke-test.sh`
fails when it is not, so the portal's half is judged on the running box rather
than assumed from the compose file.

`./scripts/smoke-test.sh pbx` asserts it: every extension with a `devices` row
must advertise a `media_address`, and it must not be a docker or loopback
address. That is the check that would have named this before a caller did — the
dialplan, mailbox and DSN checks all passed while every LAN phone was deaf in one
direction.

> Applied 2026-09-25 on `.30` to the eight extensions with a `devices` row
> (`12000`, `15000`, `4132643964`, `4132912045`, `4132951200`, `4135612020`,
> `7745057135`, `8579901777`; `101` has no device row and no registered phone).
> The media lines were first put in the portal-shared `pjsip.endpoint_custom_post.conf`
> — the wrong file, since the portal rewrites every `[<ext>](+)` there — then converged
> into `pjsip_media_custom.conf` by `pbx/media_address.py` and removed from the
> shared file, leaving it with the one `#include`. Verified live: `pjsip show
> endpoint` reports `media_address = 192.168.1.30` for all eight,
> `pjsip_owner_check.py` passes with `pjsip_media_custom.conf is loaded`, and
> `./scripts/smoke-test.sh pbx` passes *every extension is advertised a reachable
> media address*. The file lives in the `pbx-asterisk-config` volume, so the boot
> entrypoint (this repo, once deployed) is what keeps it across an image rebuild —
> and `pjsip_owner_check.py` names the include if it ever goes missing, the same
> way it names an orphaned `pjsip_ext_*.conf`.

## The outbound route: a dialled number reaches the carrier

A phone dials a number the way a person does — ten digits, `4134210134`. The
carrier does not want ten digits: VoIP.ms terminates a North American call on
eleven, `1` + area code + number, and a ten-digit string leaves as ten digits
and does not complete. The **outbound route** is where that `1` is added, and
its failure is quiet. The estate's route led with `X.` — *one or more of any
digit* — and a catch-all prepends nothing, so every call left with exactly the
digits the caller dialled. The trunk stayed registered, inbound worked, and the
only symptom was "dialling a number doesn't go through".

Zeus had no writer for outbound routes at all: `pbx/legacy_voice_migrate.py`
reports them and `docs/legacy-voice-migration.md` lists the decision as open,
because the legacy `PSTN` route's normalisation sat behind that catch-all and
adopting it meant changing the priority of a live dial plan. `pbx/outbound_route.py`
is that change, made explicit and idempotent:

| It converges | To |
|---|---|
| The route | `PSTN` by default — created if missing, `PBX_OUTBOUND_ROUTE` to rename |
| The patterns | The two rules the carrier needs: ten-digit -> `1`, seven-digit -> `1413`. Extra patterns the route already has are preserved (the live box passes eleven digits through with `ZNXXNXXXXXX`); a route created from scratch also gets eleven-digit and `011.` pass-through, and a catch-all is replaced outright |
| The trunk | The VoIP.ms PJSIP trunk (`VOIPMS_TRUNK_NAME`, default `voipms_pjsip`), first in the list |
| The priority | Lifted above anything ahead of it that would take the same calls — a catch-all, or a duplicate route pointed at another trunk |

**The measured cause was not the route.** Dialling `4134210134` logged
`Executing [4134210134@from-internal:1] NoOp("PJSIP/…", "Zeus portal extension
4134210134")` then `Hangup()` — the call never reached `outrt-*` at all. The
culprit was `exten => _Z.` in `[from-zeus-portal]` (see [The portal context must
not match a dialled number](#the-portal-context-must-not-match-a-dialled-number)).
The route matters second: the live box also carries three routes with identical
dial patterns (`voipms` -> a custom trunk, `PSTN` -> `voipms_pjsip`, `FAX` -> the
IAX trunk), and the first one takes the call however correct `PSTN` is.

```bash
# judge (0 in sync, 1 an apply converges it, 2 cannot tell), and converge by hand
python3 pbx/outbound_route.py --check                 # from the host, into zeus-freepbx
docker exec zeus-freepbx python3 /opt/zeus/pbx/outbound_route.py --check --local
python3 pbx/outbound_route.py --apply --local         # inside the container / bare metal
```

**Only the named route is touched.** A route that is not the one named here is
reported and moved *below* the route, never deleted or rewritten — a fax route
with its own caller ID (see `docs/legacy-voice-migration.md`) is an operator's
decision this tool has no business making. The move is the smallest one that
makes the route reachable: every other route keeps its relative order.

**It refuses rather than invents a trunk.** An outbound route references its
trunk by a row in FreePBX's own `trunks` table, and `dialout-trunk` builds the
channel from it. The Docker full-stack image has no GUI trunk editor and
`fwconsole trunks --add` is a silent no-op there, so a deployment that only wrote
`pjsip_voipms_custom.conf` has the carrier configured but no `trunks` row — the
tool says so (exit 2) instead of writing a route with nothing to dial out
through. On bare metal `scripts/setup.sh` registers the trunk, so the row is
there.

**It runs where the other converging owners do.** `docker-entrypoint-full.sh`
and `scripts/setup.sh` apply it on every boot (once `VOIPMS_SIP_USER` is set), so
a rebuilt box re-derives the route instead of needing a GUI edit; and the
`zeus-pbx-sync` timer judges it every tick and applies on drift
(`scripts/zeus-pbx-sync.sh`), which is what heals a box whose image predates the
change or whose route was hand-edited back to a bare `X.`. Exit 1 is "an apply
converges this", exit 2 is "no evidence" — never a pass.

## The portal context must not match a dialled number

`[from-zeus-portal]` is included by `[from-internal-custom]`, and FreePBX's
generated `[from-internal]` includes *that* **before** the module-generated
contexts — the outbound routes among them. So any pattern in the portal context
is consulted before any route, and one that matches a dialled number swallows
the call before the route (and its digit normalisation) is ever reached.

The fragment shipped `exten => _Z.` as a placeholder "anchor" for the portal's
dynamically-added softphone extensions. In Asterisk, `Z` is any digit 1-9 and
`.` is one-or-more, so `_Z.` matches **every ordinary number a phone dials**:
outbound calls hit `NoOp` then `Hangup` locally, and never reached a trunk.
Measured on `.30` (2026-09-25): dialling `4134210134` from extension `7745057135`
logged `Executing [4134210134@from-internal:1] NoOp("PJSIP/…", "Zeus portal
extension 4134210134")` then `Hangup()` in the same second. The trunk stayed
`Registered`, inbound worked, and every other check stayed green — the same
shape as a one-way-audio fault.

The context is therefore shipped **empty**: portal softphone extensions are
added as explicit `exten => <ext>,1,…` lines (their own numbers, never a
wildcard), so nothing is needed until an account exists. Two guards keep it that
way: `pbx/tests/test_parity_checklist.py` fails if the shipped fragment defines
any pattern that matches a dialled number, and `./scripts/smoke-test.sh pbx`
fails if the live dialplan answers a ten-digit sample in a context other than an
`outrt-*` route — or reaches one without prepending the `1`.

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

## Who owns a PJSIP endpoint

The rule that keeps this PBX configurable is the `_custom` convention, and it
has one sentence: **Asterisk reads an operator file, FreePBX regenerates the
rest.** `pjsip_custom.conf`, `pjsip_custom_post.conf`, `pjsip.endpoint_custom_post.conf`
and `extensions_custom.conf` are never rewritten by an Apply Config; `pjsip.conf`,
`pjsip.endpoint.conf`, `pjsip.auth.conf`, `pjsip.aor.conf`, `extensions.conf` and
`rtp_additional.conf` are. Everything below follows from that —
`setup-cloudonix-trunk.sh` includes its fragments from `pjsip_custom_post.conf`,
`scripts/setup.sh` does the same for the VoIP.ms trunk, the vendored Teams wizard
skips its `pjsip.conf` write when `FREEPBX_MODE=true`, and the TURN settings are
written into `kvstore_Sipsettings` rather than a file.

One writer used not to follow it: the portal's extension API
(`src/app/api/phone/extensions/route.ts`). It wrote a WebRTC endpoint fragment
and made Asterisk load it by appending `#include pjsip_ext_<ext>.conf` **to
`pjsip.conf`** — the file FreePBX regenerates. That shape is now retired, and the
reason it had to be is the same reason the `_custom` rule exists at all.

**The endpoint decision (2026-09-25): FreePBX owns the endpoint and the portal
extends it.** `src/lib/pjsip-endpoint.ts` appends `[<ext>](+)` — Asterisk's
append-to-existing-section syntax — plus the WebRTC media settings to
`pjsip.endpoint_custom_post.conf`, the operator-owned file above. There is no
`#include` for the portal to own and no second `[<ext>]` to collide with
FreePBX's, so the whole class of defect stops existing instead of being managed.
The softphone registers as the object the PBX already routes to, with the device
secret FreePBX renders (`src/lib/pjsip-secret.ts` reads it back out of
`pjsip.auth.conf`; the create route stores that on the row).

The rejected alternative — a portal-owned endpoint under an id FreePBX will not
generate (`<ext>-webrtc`) — loses because the rest of the PBX addresses
`PJSIP/<ext>`: inbound routes, ring groups, voicemail and this console's own
device-state poll cannot reach a second endpoint, so a registration on it reads
Offline for ever. Reasoning recorded in `src/lib/pjsip-endpoint.ts` and
[docs/voice-convergence.md](../docs/voice-convergence.md) §11.5.

What still exists is the *old* shape, on boxes provisioned before the decision:
`pjsip_ext_<ext>.conf` defining `[<ext>](webrtc-template)`, a **duplicate object
id in the same load tree** — the failure documented under
[Shared `ari.conf`](#shared-ariconf) for the ARI user, where one duplicate makes
sorcery refuse the file *"and costs every user"* — and, if anything loaded it,
an `#include` in a file FreePBX rewrites. That is a migration to detect, not a
shape to write, and it is why the check below stays.

`pjsip_owner_check.py` measures it. It reads (never writes) and it derives the
answers rather than restating them: `#include` edges are followed from
`pjsip.conf` so "on disk" and "loaded" stay different facts, and a duplicate is
the same **(id, type)** in two files — which is why `[101]` in
`pjsip.endpoint.conf`, `pjsip.auth.conf` and `pjsip.aor.conf` is the benign case
and template inheritance is resolved rather than string-matched. The portal's
`[<ext>](+)` append is judged too, and is deliberately untyped — `(+)` inherits
nothing — so it is never counted as a second endpoint. A box migrated to the
decided shape reports clean.

```bash
python3 pbx/pjsip_owner_check.py --live --json      # the box; paste the JSON back
python3 pbx/pjsip_owner_check.py --config-dir /etc/asterisk   # inside the PBX
python3 -m unittest discover -s pbx/tests -p 'test_pjsip_owner_check.py'
```

Exit 0 = measured, one owner; 1 = a two-owner state (`rc=1` naming the duplicate,
the generated carrier, or the fragment nothing loads); 2 = nothing could be
evaluated. `--extension` judges one extension instead of every `pjsip_ext_*.conf`
found.

Deliberately **not** wired into `zeus-pbx-sync.sh`: the leftover-fragment states
it finds mid-migration (a fragment inert, or a duplicate) are real and need a
person to read them, not a timer that will alarm every run until the last box is
migrated. It is a measurement to run and read. The decision it fed is now made —
FreePBX keeps the endpoint and the portal extends it via
`pjsip.endpoint_custom_post.conf` — and is recorded in
[docs/voice-convergence.md](../docs/voice-convergence.md) §11.5.

## One provisioning path (for extensions)

`provision_extension.py` owns extension/device creation, because the class of
bug that motivates D6 is a *second* writer: two products creating PBX objects by
writing tables directly is how `(1,'maxchans')` — a MySQL `1062` on `pjsip`'s
primary key — came to break an unrelated feature in a GUI dialog nobody could
act on.

```bash
# judge, write nothing (exit 0 in sync, 1 an apply converges it, 3 a person)
python3 pbx/provision_extension.py --intent accounts.json --check

# the measurement, with the raw facts on stdout, to judge off-host later
python3 pbx/provision_extension.py --intent accounts.json --check --json > observed.json
python3 pbx/provision_extension.py --intent accounts.json --observed-json observed.json --check

# create, after taking the phase's pre-state; the undo is written first
python3 pbx/provision_extension.py --intent accounts.json --apply \
    --revert-out /root/zeus-ext-revert.php
docker exec -i zeus-freepbx php < /root/zeus-ext-revert.php   # the way back
docker exec zeus-freepbx fwconsole reload
```

An extension is four things in FreePBX — a `users` row, a `devices` row, a
technology row (`sip`/`pjsip`), and `AMPUSER/<ext>` state in AstDB — and the
preflight measures all four, because creating over any of them is how a new
phone silently inherits a deleted one's call forwarding. The create itself is
the framework's (`FreePBX::Core()->generateDefaultDeviceSettings()` →
`addDevice()` → `addUser()`, the sequence `Core::doConfigPageInit` runs), so the
sixty-odd columns this tool does not model are FreePBX's to fill — and the
result is **verified by re-reading the PBX**, because a framework call returning
0 is not evidence that the objects exist.

The way back is PHP, not a raw `DELETE`: `delUser`/`delDevice`
clear the technology rows, the voicemail box and the AstDB subtree, and a raw
`DELETE` is exactly the orphan this preflight refuses to create over.

**Three legs of D6 belong to somebody else, and are reported rather than
duplicated:** inbound routes (`dograh_routes.py`, below — judged, never
written), the account's voice
mapping (`PUT /api/voice/agent-mapping`), and the WebRTC endpoint, whose owner is
still an open decision (`docs/voice-convergence.md` §11.5) — the tool
creates the framework's endpoint and never the portal's fragment. The portal's
own `freepbx.addExtension` path (the FreePBX API, from the Phone screen) used to
be a second writer; it now consults the same judgement —
`src/lib/extension-preflight.ts`, mirrored from this tool and pinned equal to it
by `scripts/extension-preflight.test.mjs` — and **refuses (503) when it cannot
take the measurement**, rather than creating blind.

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

## One ingress: every platform DID names a workflow

P1 of [docs/voice-convergence.md](../docs/voice-convergence.md) is *one
ingress*: every DID the platform sells is answered by an agent, and the DID's own
FreePBX inbound route is what names the one it reaches. There is no router
context and no per-account dialplan any more — those went with the AVA engine —
so the whole ingress is one row per DID in FreePBX's `incoming` table whose
destination is `dograh-inbound,<workflow>,1`.

The failure mode is therefore a *destination*, not an outage. A route pointing at
another context still answers a call, just as the wrong thing; a route with no row
of its own is answered by FreePBX's catch-all, as whatever that reaches. Both look
like a working phone from the inside — which is how this estate came to have every
DID unwired while both products believed the numbers were routed.

**Which workflow a DID should reach is a portal decision** (`voice_bindings`, and
the account → agent view at `GET /api/admin/voice-routing`), and the row itself
belongs to FreePBX's own create path. So nothing in this repo writes one: the
judgement is `pbx/dograh_routes.py`, and it is deliberately read-only.

```bash
# the live PBX, read-only: the portal's DID list against the live route table
python3 pbx/dograh_routes.py --db /var/lib/docker/volumes/zeus-portal-data/_data/pbx.db --check

# off-host, against a route table dumped by pbx/p0-snapshot.sh
python3 pbx/dograh_routes.py --db … --incoming-tsv routes/incoming.tsv --check
```

Its status is carried through whole, because the three mean three different things
to a caller:

| status | meaning | what the caller does |
| --- | --- | --- |
| `0` | every DID the portal sells reaches a `dograh-inbound` workflow | nothing |
| `1` | a DID is off the workflow, or has no route row at all | add or repoint the row in FreePBX's Inbound Routes — only a person can |
| `2` | no portal database, no PBX, or no active DID in the plan | nothing — a host running part of the group is not a drifted host |

A DID the portal marks `fax_enabled` is excused exactly one destination — the fax
service's own ring group (`FAX_DEST_RE` in the tool) — and the line it excused is
printed rather than dropped, because an unreported "left alone" and a clean route
look identical. The flag is *not* "this number is not a voice line": measured on
this estate, the Denovo interview line is fax-enabled **and** reaches
`dograh-inbound,8005,1`. So it never skips a line and never excuses a missing row.

`scripts/zeus-pbx-sync.sh` runs the judgement on **every** tick, including the
ones where the fragments are already in sync, and puts it in the journal without
failing the unit: a DID route is a row a person adds in FreePBX, and a timer that
went red over it would be red forever. `./scripts/smoke-test.sh pbx` runs the same
judgement and *does* fail on it, because the smoke test is the run an operator
actually reads.

What the tool will not do, deliberately:

- **It never writes a route.** A hand-written `incoming` row means guessing its
  other fifteen columns, and a half-written row on a live phone system is worse
  than a named gap: the row is FreePBX's own create path's to make, and which
  workflow it should name is the portal's to decide.
- **It judges no DID the plan does not name.** A ring group, a partner's number
  and a pattern route like `_2XX` are somebody else's phone service, and this
  check says nothing about them.
- **It never claims a pass it cannot support.** No portal database, no PBX, or a
  plan that names no active DID exits `2` rather than reporting a clean ingress —
  an empty plan is the one answer worse than "cannot tell".

## The portal's extension mirror

`freepbx_extensions` is a **mirror** of FreePBX's own `users` table, and the row
is the only reason the portal knows a phone exists at all: it carries the
softphone settings, the voicemail flag and PIN, and the account whose screens
manage it. Two writers keep it — the portal's create path
(`src/app/api/phone/extensions/route.ts`) and `scripts/legacy_portal_merge.py`,
which writes one row per extension that predates the portal — so “every FreePBX
user is a portal extension” is the estate's own convention, not a rule invented
here.

Nothing checked it, and the failure has no witness: a user created straight in
FreePBX (the GUI, or a direct `INSERT`) rings, answers, and appears on no portal
screen, while every screen that does exist is correct. Measured on this estate,
`4132912045` (“Wendel”) is a real `users`/`devices` pair and the only one of the
box's eight extensions with no mirror row — and it was found because a person
read the two tables side by side.

`pbx/extension_mirror.py` is that read, as a verdict:

```bash
python3 pbx/extension_mirror.py --db /var/lib/docker/volumes/zeus-portal-data/_data/pbx.db --check
python3 pbx/extension_mirror.py --db … --users-tsv routes/users.tsv --check   # off-host (p0-snapshot.sh)
```

Its status is carried through whole, because the three mean three different
things:

| status | meaning | what the caller does |
| --- | --- | --- |
| `0` | every FreePBX user is named by the mirror | nothing |
| `1` | an extension on the PBX is in no mirror row | add it in the portal, or remove it from the PBX with `delUser`/`delDevice` — only a person can |
| `2` | no portal database, no PBX, an unread table, an empty mirror, or a PBX that names no user | nothing — a host running part of the group is not a drifted host |

Three things about it are deliberate:

- **One direction only.** A mirror row with no FreePBX user is *not* drift. The
  mirror also carries things the PBX does not own as users — the AvantFax service
  lines (`3291`–`3294`) and a demo softphone (`1001`) — and reporting those would
  make the check permanently red, which is how a report stops being read.
- **Any row counts, whatever its `status`.** A `released` extension is still one
  the portal has a record of; only a line it has no record of at all is the state
  this catches.
- **It never writes.** The mirror row belongs to the portal (its create path
  writes both sides) and removing the PBX user is FreePBX's. A row invented here
  would be a guess at an account id, and a mirror row pointing at the wrong
  account is worse than a named gap.

`./scripts/smoke-test.sh pbx` fails on it. Deliberately **not** wired into
`zeus-pbx-sync.sh`: that wrapper's rule is that the timer never goes red over work
only a person can do (the DID ingress is reported there and never fails the unit),
and a mirror row is the same kind of work.

## Voice plane gates and D7 assertions

One thing about the voice plane fails *silently*: a check that reports success
because it never ran. It is runnable from the host without a rebuild.

The *credential* half of this section went with the AVA engine, and it is worth
knowing why it existed. The engine authenticated to Asterisk with an ARI secret
that two unrelated things wrote — `bootstrap-zeus-pbx.sh` rendered it into
`ari.conf` from `scripts/pbx.env` while `.env` handed the container its own copy,
with nothing reconciling the two — and to Asterisk a wrong password is just a
failed login, so the only symptom was calls that were never answered. A compose
`voice-preflight` service and `pbx/ava_ari_check.py` existed to gate that, and
both are gone with the engine. What survives is the shape: the timer runs
`scripts/zeus-pbx-sync.sh` rather than `pbx/bootstrap-zeus-pbx.sh` directly, so a
judgement can sit in front of the apply without the unit having to know about it,
and `scripts/tests/test_pbx_sync_unit.py` pins that wiring — the wrapper now uses
it for the DID ingress above.

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
| Dograh's Stasis app registered (`dograh_*`) | An engine that is up but unregistered answers no calls, and looks identical to an idle one |
| CDR backend wired **and** writing | `odbc show` proves the DSN is connected; only a call proves rows are written. CDR was dead on this estate for nine days with every other indicator green |
| The gateway offers the pinned models this repo holds (`VOICEMAIL_SUMMARY_MODEL`) | A gateway that 502s a model returns an HTML page, so the feature dies on its first turn with nothing naming the cause |

The probe call is `Local/12@default`: it matches FreePBX's `_X.` catch-all,
answers, plays the voicemail goodbye prompt and hangs up. No trunk, no phone, no
agent — a probe that could reach a real agent would not be a probe. Exit codes
are three-valued on purpose: `0` holds, `1` is false, and `2` means *nothing was
evaluated* (no docker, no PBX container, no `.env`), which is not evidence of
health and is why the summary line repeats what it did not evaluate.

### Voicemail: the mailbox behind `*97`

`*97` is FreePBX's My Voicemail, and no file in this repo defines it — the feature
code comes from the module-generated dialplan. What the estate owned was the
mailbox, and it never created one. FreePBX's own create path is why, and both
halves are in the vendored source (`vendor/freepbx-17.0.19.32.tgz`):

* `Core::addUser()` sets the user row's voicemail **from the box that already
exists** — `Voicemail::getMailbox($ext)` reads `voicemail.conf`, and when it
returns null the row is written with `voicemail = "novm"`. `Core`'s
`generateDefaultUserSettings()` carries no `voicemail` key at all, so the D6
provisioner's sequence (`generateDefaultUserSettings` → `addUser`) lands there.
* The GraphQL `addExtension(vmEnable, vmPassword)` turns those fields into
`$input['vm']` / `$input['vmpwd']` in `core/Api/Gql/Extensions.php` — and `vmpwd`
appears **nowhere** in `Core.class.php`. The mutation accepts them, answers
"Extension has been created Successfully", and creates no box.

So every extension the platform creates — the portal's
`POST /api/phone/extensions`, `legacy_voice_migrate.py`, `provision_extension.py`
— is a desk phone that rings and a mailbox that does not exist. The voicemail
module's `app-vmmain` does `Macro(get-vmcontext,${AMPUSER})` →
`VoiceMailMain(${AMPUSER}@novm)`, finds no such box, and leaves the caller at a
bare login prompt while the PBX looks healthy from every other angle.

`pbx/voicemail_mailbox.py` is the writer for that fifth thing (an extension is a
user row, a device row, a technology row, AstDB state — and a mailbox):

```bash
python3 pbx/voicemail_mailbox.py plan  --intent mailboxes.json   # also the verify
python3 pbx/voicemail_mailbox.py apply --intent mailboxes.json
```

It creates the box through FreePBX's own `Voicemail::addMailbox`, re-points the
`users.voicemail` row and the AstDB key `Macro(get-vmcontext)` reads, and reads
the result back out of **what Asterisk loaded** (`voicemail show users`), so a
`plan` run after an `apply` is the verification. The intent carries a PIN
(`vm.pin` in the migration snapshot, `voicemail_pin` in the portal), and a row
without one is refused by name rather than given a generated one.

The gate *before* the mailbox is judged first, because it is the one a
box-shaped check cannot see. `macro-user-callerid` does not trust the caller id
it was handed: it re-derives the extension from AstDB's `DEVICE/<callerid>/user`
and then reads `AMPUSER/<ext>/cidname` — both written by FreePBX's own create
path (`Core::addDevice`, `Core::addUser`), and both absent on every extension
that reached the tables another way (the portal's GraphQL `addExtension`,
`legacy_voice_migrate.py`'s direct writes). `DEVICE/<ext>/user` missing means
`AMPUSER` is blanked, `*97` calls `macro-get-vmcontext` with no argument, and
the call ends on the priority after that lookup: one second, `ANSWERED`, and
`lastapp=Set, lastdata=VMCONTEXT=default` as the only trace. Seven of this
estate's eight extensions were in that state, with their mailboxes present and
every other indicator green — so `plan` reports it as `no-caller-id`, and
`apply` writes the pair from the PBX's own rows (`devices`, `users`), never
overwriting a mapping a person set.

The storage class is a separate, smaller thing: `res_odbc_custom.conf` registers
`[asteriskvoicemail]` against `MySQL-asteriskvoicemail`, while `/etc/odbc.ini`
(which lives in the image, not on a volume — the reason
`docker-entrypoint-full.sh` patches it every boot) defines only the CDR DSN. That
is a connection that cannot be made rather than a feature that is off, so the
entrypoint now adds any section a class names and the file lacks, and
`scripts/tests/test_odbc_dsn_parity.py` holds setup.sh's two files to the same
DSN list. `./scripts/smoke-test.sh pbx` asserts three things about `*97` — the
feature code resolving in the context a phone dials from, every extension with a
mailbox resolving from its caller id (`DEVICE/<ext>/user` and
`AMPUSER/<ext>/cidname`), and every DSN the classes name being defined — because
they fail identically at the phone. The first of those used to ask
`dialplan show *97`, which reads its argument as a *context* name and answers
"There is no existence of `'*97'` context" on every PBX there is: a string
containing `'*97'`, which the check grepped for. It passed on its own error
message and could not fail.

### `p0-snapshot.sh` — record the pre-state before touching a live box

```bash
pbx/p0-snapshot.sh                        # → /root/p0-snapshot-<UTC>/ + MANIFEST
OUT=/root/before-p1 pbx/p0-snapshot.sh    # name the phase's pre-state yourself
PBX_CONTAINER=zeus-freepbx pbx/p0-snapshot.sh   # when autodetection is ambiguous
```

It captures containers, the PBX fragment files **with hashes**, inbound routes,
the FreePBX users table (`routes/users.tsv`, which `--users-tsv` judges
off-host), units, runtime state and a CDR watermark, and it is read-only: it
copies files out and runs `show` commands, never a write. Exit 0 means a snapshot was taken
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