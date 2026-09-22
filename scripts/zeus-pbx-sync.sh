#!/usr/bin/env bash
# Zeus — PBX fragment sync wrapper (journal-friendly, timer-driven).
# Reconciles pbx/asterisk fragments into FreePBX and reloads on drift.
# This is what systemd/zeus-pbx-sync.service runs (its ExecStart), so the
# credential gate below is in front of every timer-driven apply, not only of a
# hand-run `bootstrap-zeus-pbx.sh`.
# Mirrors the Capstone pbx-sync convention:
#   - drift check; apply + reload only when out of sync (no-op otherwise)
#   - exit 0 even if the PBX is unreachable (a slow boot is not a failure)
set -uo pipefail

PBX_TARGET="${PBX_TARGET:-local}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# bootstrap resolves the repo root from its own path, so hand it an absolute
# one instead of a relative path: the apply must not depend on the caller
# happening to sit in the repo root (a unit's WorkingDirectory is not a
# contract, and a hand-run wrapper from elsewhere used to fail at the apply).
BOOTSTRAP="${REPO_ROOT}/pbx/bootstrap-zeus-pbx.sh"

# ── the engine's ARI credential must be the one ari.conf will carry ─────────
# Checked first, and allowed to fail the unit, because it is not an outage:
# both files are local, the disagreement will not clear on the next tick, and
# its symptom on a live system is calls that are never answered — Asterisk just
# refuses a login, so nothing logs a mismatched secret. Applying the dialplan
# over a credential the engine cannot use would only hide it.
if ! python3 "${REPO_ROOT}/pbx/ava_ari_check.py" --quiet; then
  echo "zeus-pbx-sync: not applying — AVA_ARI_SECRET disagrees between .env and scripts/pbx.env" >&2
  exit 1
fi

if "$BOOTSTRAP" --check >/dev/null 2>&1; then
  echo "zeus-pbx-sync: in sync"
  exit 0
fi

if "$BOOTSTRAP" >/dev/null 2>&1; then
  echo "zeus-pbx-sync: re-applied fragments (${PBX_TARGET})"
  exit 0
fi

echo "zeus-pbx-sync: pbx unreachable or apply failed (retrying next timer)" >&2
exit 0