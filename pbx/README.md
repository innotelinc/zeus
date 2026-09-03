# Zeus — PBX layer (`pbx/`)

The version-controlled Asterisk/FreePBX scaffolding for the Zeus voice plane —
mirroring the Capstone `pbx/` convention so the two platforms share one
operational shape.

## What lives here

| Path | Purpose |
|---|---|
| `asterisk/manager_custom.conf` | AMI user for the portal (`pbxportal`) with a deny-by-default permit list |
| `asterisk/ari_custom.conf` | ARI user for portal call control (Stasis apps) |
| `asterisk/http_custom.conf` | Asterisk HTTP server + WebSocket transport for the WebRTC softphone |
| `asterisk/extensions_custom.conf` | Portal dialplan context (`[from-zeus-portal]`) |
| `bootstrap-zeus-pbx.sh` | Render + apply the fragments idempotently; `--check` drift mode |

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