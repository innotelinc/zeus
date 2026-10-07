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

# ── Bound DIDs: written from the portal's own decision ───────────
# The judgement above says which DIDs are off the workflow; this is what puts the
# ones the portal has *bound* onto one. `voice_bindings` is the operator's
# decision and the `incoming` row is FreePBX's, so a binding change used to reach
# nothing: the portal agreed and the calls did not. Unlike a DID route the target
# is not a guess — `pbx/dograh_bindings.py` reads the engine's own workflow ->
# number mapping — so the timer applies it, and only repoints rows that already
# exist (a DID with no route at all stays a person's to add).
if [ -f "${REPO_ROOT}/pbx/dograh_bindings.py" ] && [ -f "$PORTAL_DB" ]; then
  bind_rc=0
  bind_out="$(python3 "${REPO_ROOT}/pbx/dograh_bindings.py" --db "$PORTAL_DB" --check 2>&1)" || bind_rc=$?
  [ -n "$bind_out" ] && printf '%s\n' "$bind_out" | sed 's/^dograh-bindings: /  dograh-bindings: /' >&2
  if [ "$bind_rc" = 1 ]; then
    bind_rc=0
    bind_out="$(python3 "${REPO_ROOT}/pbx/dograh_bindings.py" --db "$PORTAL_DB" --apply 2>&1)" || bind_rc=$?
    [ -n "$bind_out" ] && printf '%s\n' "$bind_out" | sed 's/^dograh-bindings: /  dograh-bindings: /' >&2
    [ "$bind_rc" = 0 ] && echo "zeus-pbx-sync: bound DID routes re-converged (pbx/dograh_bindings.py)" >&2
  fi
  if [ "$bind_rc" != 0 ]; then
    echo "zeus-pbx-sync: bound DID routes could not be judged (dograh-bindings exit $bind_rc) — check the portal database, the engine's database and the PBX" >&2
  fi
fi

# ── Extension secrets: judged on every tick, never written ────────
# A softphone registers as the PJSIP endpoint FreePBX itself owns, so the
# credential that endpoint accepts is the one FreePBX rendered into
# `pjsip.auth.conf` (`src/lib/pjsip-secret.ts`) — not a value the portal keeps.
# A portal row holding none (a legacy-adopted extension, which
# `scripts/legacy_portal_merge.py` deliberately gives no invented credential) or
# a different one is refused on every REGISTER, and nothing else here can see
# it: the endpoint exists, the mailbox resolves, the media address is set, and
# the only symptom is a phone that never comes up. Reported on the in-sync path
# too, and never a failure, for the same reason the DID route is: adopting the
# PBX's secret is the portal's Repair button, and a tool that wrote one would be
# inventing the credential the readiness row exists to report.
if [ -f "${REPO_ROOT}/pbx/extension_secret.py" ] && [ -f "$PORTAL_DB" ]; then
  secret_rc=0
  secret_out="$(python3 "${REPO_ROOT}/pbx/extension_secret.py" --db "$PORTAL_DB" --check 2>&1)" || secret_rc=$?
  if [ -n "$secret_out" ]; then
    printf '%s\n' "$secret_out" | sed 's/^extension-secret: /  extension-secret: /' >&2
  fi
  if [ "$secret_rc" != 0 ]; then
    echo "zeus-pbx-sync: an extension's stored SIP secret is missing or is not the one the PBX renders (extension-secret exit $secret_rc) — its softphone cannot register; run Repair for it in the portal" >&2
  fi
fi

# ── Media address: judged, and converged on drift ────────────────
# (The portal's write access to the file it appends to is re-asserted below.)
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

# ── The portal's write access to its own config files ───────────
# The portal (uid 1001) writes pjsip.endpoint_custom_post.conf and
# pjsip_media_custom.conf, but `fwconsole chown` on every boot leaves them
# 0664 asterisk:asterisk — owner+group only — so the portal holds no write bit
# and its Repair button silently does nothing (the route reports the state it
# failed to change). A compose `group_add` cannot fix it either: the portal's
# entrypoint drops privileges with `su-exec nextjs:nodejs`, which resets the
# supplementary group set. The tool therefore gives the files the portal's
# PRIMARY gid, which survives `su-exec`. The entrypoint does it after each
# chown; this is what heals a box whose image predates that, or one an
# operator's own chown reverted. Judged every tick and applied on drift, like
# the media address: it is derivable and idempotent.
access_run() {
  docker exec "$PBX_CONTAINER" python3 /opt/zeus/pbx/portal_config_access.py \
    --asterisk-dir /etc/asterisk "$1" 2>&1
}
access_say() { printf '%s\n' "$1" | sed 's/^portal-access: /  portal-access: /' >&2; }

if docker exec "$PBX_CONTAINER" test -f /opt/zeus/pbx/portal_config_access.py >/dev/null 2>&1; then
  access_rc=0
  access_out="$(access_run --check)" || access_rc=$?
  [ -n "$access_out" ] && access_say "$access_out"
  if [ "$access_rc" = 1 ]; then
    access_rc=0
    access_out="$(access_run --apply)" || access_rc=$?
    [ -n "$access_out" ] && access_say "$access_out"
    [ "$access_rc" = 0 ] && echo "zeus-pbx-sync: portal config write access re-asserted (pbx/portal_config_access.py)" >&2
  fi
  if [ "$access_rc" != 0 ]; then
    echo "zeus-pbx-sync: portal config write access could not be judged (portal-access exit $access_rc) — Repair will report state instead of writing" >&2
  fi
fi

# ── Outbound route: judged, and converged on drift ──────────────
# The boot entrypoint and `scripts/setup.sh` converge the route that gives a
# dialled number the digits the trunk needs (ten-digit -> `1`). A box whose
# image predates that, or whose route was hand-edited in the GUI, goes back to
# a bare `X.` catch-all — which matches every number and normalises nothing, so
# outbound calls stop completing while the trunk stays registered and every
# other check stays green. Unlike a DID route this is derivable and the tool is
# idempotent, so the timer checks it and applies on drift.
route_run() {
  docker exec "$PBX_CONTAINER" python3 /opt/zeus/pbx/outbound_route.py \
    --check --local 2>&1
}
route_say() { printf '%s\n' "$1" | sed 's/^outbound-route: /  outbound-route: /' >&2; }

if docker exec "$PBX_CONTAINER" test -f /opt/zeus/pbx/outbound_route.py >/dev/null 2>&1; then
  route_rc=0
  route_out="$(route_run)" || route_rc=$?
  [ -n "$route_out" ] && route_say "$route_out"
  if [ "$route_rc" = 1 ]; then
    route_rc=0
    route_out="$(docker exec "$PBX_CONTAINER" python3 /opt/zeus/pbx/outbound_route.py \
      --apply --local 2>&1)" || route_rc=$?
    [ -n "$route_out" ] && route_say "$route_out"
    [ "$route_rc" = 0 ] && echo "zeus-pbx-sync: outbound route re-converged (pbx/outbound_route.py)" >&2
  fi
  if [ "$route_rc" != 0 ]; then
    echo "zeus-pbx-sync: outbound route could not be judged (outbound-route exit $route_rc) — check the voipms trunk and the PBX" >&2
  fi
fi

# ── Inbound SMS: the trunk's Message Context ────────────────────
# The [sms-in] dialplan converged above is only reached if the trunk names it as
# its `message_context`. On this Asterisk (22.11) that endpoint option is the
# only MESSAGE routing there is — the legacy `[general] accept_outofcall_message`
# block `scripts/setup.sh` wrote does not exist in res_pjsip.so or
# res_pjsip_messaging.so, so an estate with it set and no message_context accepts
# the text and drops it. The value is derivable (SMS_IN_CONTEXT), so unlike a DID
# route the timer converges it rather than only reporting it.
sms_say() { printf '%s\n' "$1" | sed 's/^sms-message-context: /  sms-message-context: /' >&2; }

if docker exec "$PBX_CONTAINER" test -f /opt/zeus/pbx/sms_message_context.py >/dev/null 2>&1; then
  sms_rc=0
  sms_out="$(docker exec "$PBX_CONTAINER" python3 /opt/zeus/pbx/sms_message_context.py \
    --check --local 2>&1)" || sms_rc=$?
  [ -n "$sms_out" ] && sms_say "$sms_out"
  if [ "$sms_rc" = 1 ]; then
    sms_rc=0
    sms_out="$(docker exec "$PBX_CONTAINER" python3 /opt/zeus/pbx/sms_message_context.py \
      --apply --local 2>&1)" || sms_rc=$?
    [ -n "$sms_out" ] && sms_say "$sms_out"
    [ "$sms_rc" = 0 ] && echo "zeus-pbx-sync: trunk Message Context re-converged (pbx/sms_message_context.py)" >&2
  fi
  if [ "$sms_rc" != 0 ]; then
    echo "zeus-pbx-sync: inbound SMS routing could not be judged (sms-message-context exit $sms_rc) — check the voipms trunk and the PBX" >&2
  fi
fi

# ── Voicemail mailboxes: judged, and converged on drift ─────────
# `*97` needs the four facts the tool judges to line up, and the one a rebuilt
# box loses is the caller-id gate: `macro-user-callerid` re-derives the
# extension from AstDB's `DEVICE/<callerid>/user` and `AMPUSER/<ext>/cidname`,
# and it is FreePBX's own create path — not this repo's direct writes — that
# used to write them (see `pbx/README.md`, "The mailbox behind `*97`"). The
# portal's own `freepbx_extensions` is the intent (`voicemail_enabled` plus
# `voicemail_pin`), so unlike a DID route this is derivable and the tool is
# idempotent: the timer judges it and applies on drift, which is what re-derives
# a caller-id pair a rebuild dropped rather than leaving `*97` dead until
# somebody runs the tool by hand.
vm_say() { printf '%s\n' "$1" | sed 's/^/  /' >&2; }

if [ -f "${REPO_ROOT}/pbx/voicemail_mailbox.py" ] && [ -f "$PORTAL_DB" ]; then
  vm_rc=0
  vm_out="$(python3 "${REPO_ROOT}/pbx/voicemail_mailbox.py" plan --db "$PORTAL_DB" 2>&1)" || vm_rc=$?
  [ -n "$vm_out" ] && vm_say "$vm_out"
  if [ "$vm_rc" = 1 ]; then
    vm_rc=0
    vm_out="$(python3 "${REPO_ROOT}/pbx/voicemail_mailbox.py" apply --db "$PORTAL_DB" 2>&1)" || vm_rc=$?
    [ -n "$vm_out" ] && vm_say "$vm_out"
    [ "$vm_rc" = 0 ] && echo "zeus-pbx-sync: voicemail mailboxes re-converged (pbx/voicemail_mailbox.py)" >&2
  fi
  if [ "$vm_rc" != 0 ]; then
    echo "zeus-pbx-sync: voicemail mailboxes could not be judged (voicemail-mailbox exit $vm_rc) — check the portal database and the PBX" >&2
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