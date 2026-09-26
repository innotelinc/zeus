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

# ── Media address: judged, and converged on drift ────────────────
# The boot entrypoint `docker-entrypoint-full.sh` converges the address Asterisk
# advertises to a LAN phone into `pjsip_media_custom.conf`. On a box whose image
# predates that change the entrypoint never runs it, and nothing else notices:
# the endpoint answers, it just hands the phone the container's own (unreachable)
# address, and one-way audio is the only symptom. So the timer does it — checked
# on every tick, and *applied* when out of sync, because unlike a DID route this
# value is auto-derivable and the tool is idempotent. That is what re-derives it
# on a rebuilt box with no 45–90 minute image rebuild, and the window below
# (OnBootSec) is what makes it happen after a boot.
PBX_CONTAINER="${PBX_CONTAINER:-zeus-freepbx}"
# Explicit env wins, then the route-selected LAN address — the unit does not
# carry LAN_IP, and the address this file advertises is by project rule the
# host's LAN address. The tool refuses a docker/loopback value, so a wrong
# answer is skipped rather than written.
MEDIA_ADDRESS="${PJSIP_MEDIA_ADDRESS:-${LAN_IP:-$(ip -4 route get 1 2>/dev/null | sed -n 's/.*src \([0-9.]*\).*/\1/p' | head -1)}}"

# The endpoint list is the PBX's own `devices` table, read inside the container.
media_run() {
  docker exec -i -e ZEUS_MEDIA_ADDRESS="$MEDIA_ADDRESS" -e ZEUS_MEDIA_MODE="$1" \
    "$PBX_CONTAINER" sh -s <<'INNER' 2>&1
mysql -N -B -u root asterisk -e "SELECT id FROM devices WHERE tech IN ('sip','pjsip')" \
  | python3 /opt/zeus/pbx/media_address.py --devices-tsv - \
      --address "$ZEUS_MEDIA_ADDRESS" --asterisk-dir /etc/asterisk "$ZEUS_MEDIA_MODE"
INNER
}

media_say() { printf '%s\n' "$1" | sed 's/^media-address: /  media-address: /' >&2; }

if [ -n "$MEDIA_ADDRESS" ] \
   && docker exec "$PBX_CONTAINER" test -f /opt/zeus/pbx/media_address.py >/dev/null 2>&1; then
  media_rc=0
  media_out="$(media_run --check)" || media_rc=$?
  [ -n "$media_out" ] && media_say "$media_out"
  if [ "$media_rc" = 1 ]; then
    media_rc=0
    media_out="$(media_run --apply)" || media_rc=$?
    [ -n "$media_out" ] && media_say "$media_out"
    docker exec "$PBX_CONTAINER" asterisk -rx "module reload res_pjsip.so" >/dev/null 2>&1 || true
    echo "zeus-pbx-sync: media addresses re-applied (pbx/media_address.py)" >&2
  fi
  if [ "$media_rc" != 0 ]; then
    echo "zeus-pbx-sync: media addresses could not be judged (media-address exit $media_rc) — check LAN_IP/PJSIP_MEDIA_ADDRESS and the PBX" >&2
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