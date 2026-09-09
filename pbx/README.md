# Zeus — PBX layer (`pbx/`)

The version-controlled Asterisk/FreePBX scaffolding for the Zeus voice plane —
mirroring the Capstone `pbx/` convention so the two platforms share one
operational shape.

## What lives here

| Path | Purpose |
|---|---|
| `asterisk/manager_custom.conf` | AMI user for the portal (`pbxportal`) with a deny-by-default permit list (genuinely included) |
| `asterisk/ari.conf` | `[pbxportal]` ARI user section — **converged into the real `/etc/asterisk/ari.conf`** (see below) |
| `asterisk/http_custom.conf` | Asterisk HTTP server + WebSocket transport for the WebRTC softphone (genuinely included) |
| `asterisk/extensions_custom.conf` | Portal dialplan context (`[from-zeus-portal]`) — converge-owned |
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

Tests: `npm test` — includes wizard stanza + semver-gate tests against a fake
`asterisk` binary, adapter dry-run/audit tests, and a full API-mode integration
test against the committed mock (`scripts/fixtures/cerulean-api-mock.mjs`,
mirroring Cerulean's REST contract with a real RSA-2048 fixture certificate).

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