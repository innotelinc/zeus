#!/usr/bin/env bash
# Zeus — PBX fragment sync wrapper (journal-friendly, timer-driven).
# Reconciles pbx/asterisk fragments into FreePBX and reloads on drift.
# This is what systemd/zeus-pbx-sync.service runs (its ExecStart).
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

# ── DID ingress: judged on every tick, never written ──────────────
# The fragment check below cannot see this half. Which workflow a DID reaches
# is a row in FreePBX's own `incoming` table, and a route that names something
# else — or nothing at all — is a phone number that answers as the wrong agent
# while every file matches. Which workflow a DID *should* reach is a portal
# decision, so `pbx/dograh_routes.py` only reports: the timer's job is to keep
# saying it, because the row is a person's to add in FreePBX and an apply can
# never clear it. Reported on the in-sync path too, and never a failure — the
# same rule this wrapper already applies to a DID route the apply refuses.
PORTAL_DB="${PORTAL_DB:-/var/lib/docker/volumes/zeus-portal-data/_data/pbx.db}"
if [ -f "${REPO_ROOT}/pbx/dograh_routes.py" ] && [ -f "$PORTAL_DB" ]; then
  routes_rc=0
  routes_out="$(python3 "${REPO_ROOT}/pbx/dograh_routes.py" --db "$PORTAL_DB" --check 2>&1)" || routes_rc=$?
  if [ -n "$routes_out" ]; then
    printf '%s\n' "$routes_out" | sed 's/^dograh-routes: /  dograh-routes: /' >&2
  fi
  if [ "$routes_rc" != 0 ]; then
    echo "zeus-pbx-sync: DID ingress is not in sync (dograh-routes exit $routes_rc) — a person adds or repoints the row in FreePBX" >&2
  fi
fi

if "$BOOTSTRAP" --check >/dev/null 2>&1; then
  echo "zeus-pbx-sync: in sync"
  exit 0
fi

if out="$("$BOOTSTRAP" 2>&1)"; then
  echo "zeus-pbx-sync: re-applied fragments (${PBX_TARGET})"
  exit 0
fi

# Non-zero here is not necessarily an outage. The apply also refuses when it
# finds nothing it may write: a platform DID with no inbound route at all is a
# row only a person can add in FreePBX, and an apply cannot clear it however
# often it runs. Both cases keep the unit green — a slow boot is not a failure —
# but neither may be silent, so the apply's own output goes to the journal, where
# a timer's operator actually looks.
printf '%s\n' "$out" | sed 's/^zeus-pbx: /  /' >&2
echo "zeus-pbx-sync: not applied — a DID route needs a human, or the PBX is unreachable (see above)" >&2
exit 0