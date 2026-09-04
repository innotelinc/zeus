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
| `asterisk_converge.py` | Per-context merge for the **shared** `extensions_custom.conf` (ownership markers) |
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
```

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