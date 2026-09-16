#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# setup-cloudonix-trunk.sh — peer a Cloudonix domain with THIS PBX.
#
# WHY. Dograh can carry calls over Cloudonix's own websocket transport (which
# needs Dograh's hosted service), or over plain SIP. This script wires the
# second: the Cloudonix regional edge is trusted as a pjsip peer, calls it
# sends arrive in FreePBX's [from-trunk] and are routed by the inbound-route
# table exactly like the VoIP.ms trunk, so Dograh's agents get them through the
# same ARI path as any other carrier.
#
# It is the Zeus counterpart of Capstone's pbx/entrypoint-dograh.sh
# setup_cloudonix_trunk(). Capstone applies it at container boot (standalone
# PBX); this host-side script exists because the LIVE PBX is owned by Zeus's
# stack (docker-compose.full.yml → freepbx), whose entrypoint is baked into a
# published image. Running this applies the same configuration without waiting
# for an image rebuild — and the entrypoint calls it on boot when it is
# present, so the box also self-heals.
#
# TWO WAYS TO ADMIT CLOUDONIX TRAFFIC (both may be on at once):
#   • IP identity (default) — a pjsip `identify` block trusts the Cloudonix
#     regional edge. CLOUDONIX_EDGE_IP defaults to the Global edge IP that
#     Dograh's own region table publishes
#     (api/services/telephony/providers/cloudonix/regions.py), so PBX and
#     platform agree on the peer with no extra configuration.
#   • Registration (NAT-friendly, mirrors the VoIP.ms trunk) — set
#     CLOUDONIX_SIP_USER/CLOUDONIX_SIP_PASS and the trunk registers out to
#     Cloudonix; inbound calls then arrive on that registration, so no inbound
#     5060 port-forward is needed.
#
# READ FROM THE ENVIRONMENT (or pbx.env / the stack .env):
#   CLOUDONIX_SIP_ENABLED   1 to force on; otherwise auto-enabled when any
#                           other CLOUDONIX_* value below is set
#   CLOUDONIX_SIP_SERVER    default sip.cloudonix.net
#   CLOUDONIX_EDGE_IP       default 18.219.128.166 (Cloudonix Global edge)
#   CLOUDONIX_SIP_PORT      default 5060
#   CLOUDONIX_SIP_USER      optional trunk credentials (registration mode)
#   CLOUDONIX_SIP_PASS      optional trunk credentials (registration mode)
#   CLOUDONIX_DIDS          "did:agent-ext,did:agent-ext" → dialplan routes
#   DOGRAH_INBOUND_CONTEXT  default dograh-inbound (Capstone's ARI context)
#   PBX_CONTAINER           default zeus-freepbx (docker exec target)
#
# Usage:
#   pbx/setup-cloudonix-trunk.sh              # apply inside PBX_CONTAINER
#   PBX_CONTAINER= docker exec ...            # run directly in-container
#   pbx/setup-cloudonix-trunk.sh --check      # report drift only
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Load the stack env when the caller has not already exported values, so a bare
# invocation on the host picks up the same CLOUDONIX_* the containers see.
if [ -z "${CLOUDONIX_SIP_ENABLED:-}${CLOUDONIX_SIP_USER:-}${CLOUDONIX_DIDS:-}" ]; then
  for f in "${PBX_ENV_FILE:-}" "${REPO_ROOT}/pbx.env" "${REPO_ROOT}/.env"; do
    [ -n "$f" ] && [ -f "$f" ] || continue
    set -a
    # shellcheck disable=SC1090
    . "$f"
    set +a
    break
  done
fi

CLOUDONIX_SIP_ENABLED="${CLOUDONIX_SIP_ENABLED:-}"
CLOUDONIX_SIP_SERVER="${CLOUDONIX_SIP_SERVER:-sip.cloudonix.net}"
CLOUDONIX_EDGE_IP="${CLOUDONIX_EDGE_IP:-18.219.128.166}"
CLOUDONIX_SIP_PORT="${CLOUDONIX_SIP_PORT:-5060}"
CLOUDONIX_SIP_USER="${CLOUDONIX_SIP_USER:-}"
CLOUDONIX_SIP_PASS="${CLOUDONIX_SIP_PASS:-}"
CLOUDONIX_DIDS="${CLOUDONIX_DIDS:-}"
DOGRAH_INBOUND_CONTEXT="${DOGRAH_INBOUND_CONTEXT:-dograh-inbound}"
PBX_CONTAINER="${PBX_CONTAINER:-zeus-freepbx}"
CHECK=0
[ "${1:-}" = "--check" ] && CHECK=1

# Opt-in explicitly, or automatically when anything Cloudonix-specific is set.
if [ -z "$CLOUDONIX_SIP_ENABLED" ] && [ -z "${CLOUDONIX_SIP_USER:-}" ] && \
   [ -z "${CLOUDONIX_DIDS:-}" ]; then
  echo "cloudonix: nothing configured (set CLOUDONIX_SIP_ENABLED=1 to enable) — skipping"
  exit 0
fi

# ── The pjsip fragment ────────────────────────────────────────────────────
# The AOR reference is unconditional: the endpoint needs it to place OUTBOUND
# calls through the static contact, and its qualify keeps the edge warm (the
# `pjsip show aors` output is how this peering is verified). Only auth differs
# between the two admission modes.
build_pjsip() {
  local reg_block="" auth_block="" outbound_auth_line="" aors_line="aors=cloudonix-aor"
  if [ -n "$CLOUDONIX_SIP_USER" ] && [ -n "$CLOUDONIX_SIP_PASS" ]; then
    reg_block="
[cloudonix-reg]
type=registration
outbound_auth=cloudonix-auth
server_uri=sip:${CLOUDONIX_SIP_SERVER}:${CLOUDONIX_SIP_PORT}
client_uri=sip:${CLOUDONIX_SIP_USER}@${CLOUDONIX_SIP_SERVER}
retry_interval=60"
    auth_block="
[cloudonix-auth]
type=auth
auth_type=userpass
username=${CLOUDONIX_SIP_USER}
password=${CLOUDONIX_SIP_PASS}"
    outbound_auth_line="outbound_auth=cloudonix-auth"
  fi

  cat <<EOF
; Auto-generated by pbx/setup-cloudonix-trunk.sh — Cloudonix SIP trunk.
; Managed outside FreePBX (the script keeps the #include alive); edit via
; CLOUDONIX_* in the stack .env or pbx.env.
${reg_block}
${auth_block}

[cloudonix-identify]
type=identify
endpoint=cloudonix-endpoint
match=${CLOUDONIX_EDGE_IP}/32
match=${CLOUDONIX_SIP_SERVER}

[cloudonix-endpoint]
type=endpoint
context=from-trunk
disallow=all
allow=ulaw,alaw
${outbound_auth_line}
${aors_line}
from_domain=${CLOUDONIX_SIP_SERVER}

[cloudonix-aor]
type=aor
contact=sip:${CLOUDONIX_SIP_SERVER}:${CLOUDONIX_SIP_PORT}
qualify_frequency=60
EOF
}

# ── The dialplan fragment ─────────────────────────────────────────────────
# Cloudonix's endpoint context is FreePBX's [from-trunk], so real DID routes
# come from the incoming-route table (Connectivity → Inbound Routes). This
# context carries the explicit CLOUDONIX_DIDS mappings, and the same catch-all
# the VoIP.ms trunk uses.
build_dialplan() {
  echo "; Auto-generated by pbx/setup-cloudonix-trunk.sh — Cloudonix DID routing."
  echo "; Calls from the Cloudonix edge enter FreePBX's [from-trunk] and are"
  echo "; routed by the incoming table; CLOUDONIX_DIDS entries are explicit here."
  echo "[from-trunk-cloudonix]"
  echo "exten => _X.,1,NoOp(Cloudonix inbound)"
  # shellcheck disable=SC2016  # ${EXTEN} is Asterisk dialplan syntax — must stay literal
  echo ' same => n,Goto(from-trunk,${EXTEN},1)'
  echo " same => n,Hangup()"
  if [ -n "$CLOUDONIX_DIDS" ]; then
    local pair did ext
    IFS=','
    for pair in $CLOUDONIX_DIDS; do
      did="${pair%%:*}"
      ext="${pair#*:}"
      [ "$ext" != "$did" ] || ext=8000
      [ -n "$did" ] || continue
      echo "exten => ${did},1,NoOp(Cloudonix DID ${did} -> dograh ext ${ext})"
      echo " same => n,Goto(${DOGRAH_INBOUND_CONTEXT},${ext},1)"
      echo " same => n,Hangup()"
    done
    unset IFS
  fi
}

run_in_pbx() {
  if [ -n "$PBX_CONTAINER" ] && docker inspect "$PBX_CONTAINER" >/dev/null 2>&1; then
    docker exec -i "$PBX_CONTAINER" "$@"
  else
    "$@"
  fi
}

DEST="$(run_in_pbx sh -c 'echo /etc/asterisk')"
PJSIP_TMP="$(mktemp)"; DIAL_TMP="$(mktemp)"
trap 'rm -f "$PJSIP_TMP" "$DIAL_TMP"' EXIT
build_pjsip > "$PJSIP_TMP"
build_dialplan > "$DIAL_TMP"

if [ "$CHECK" = 1 ]; then
  rc=0
  for pair in "pjsip_custom_cloudonix.conf:${PJSIP_TMP}" \
              "extensions_custom_cloudonix.conf:${DIAL_TMP}"; do
    name="${pair%%:*}"; want="${pair#*:}"
    if run_in_pbx cat "${DEST}/${name}" > /dev/null 2>&1; then
      have="$(run_in_pbx cat "${DEST}/${name}")"
    else
      have=""
    fi
    if [ "$have" != "$(cat "$want")" ]; then
      echo "drift: ${name}" >&2
      rc=1
    fi
  done
  [ "$rc" = 0 ] && echo "cloudonix: in sync"
  exit "$rc"
fi

echo ">>> [cloudonix] configuring trunk (edge ${CLOUDONIX_EDGE_IP}, server ${CLOUDONIX_SIP_SERVER})"
if [ -n "$PBX_CONTAINER" ] && docker inspect "$PBX_CONTAINER" >/dev/null 2>&1; then
  docker cp "$PJSIP_TMP" "${PBX_CONTAINER}:${DEST}/pjsip_custom_cloudonix.conf"
  docker cp "$DIAL_TMP"  "${PBX_CONTAINER}:${DEST}/extensions_custom_cloudonix.conf"
else
  install -m 640 "$PJSIP_TMP" "${DEST}/pjsip_custom_cloudonix.conf"
  install -m 640 "$DIAL_TMP"  "${DEST}/extensions_custom_cloudonix.conf"
fi

# Keep the #include lines alive in the files FreePBX owns.
run_in_pbx sh -s <<'SH'
set -e
inc=/etc/asterisk/pjsip_custom_post.conf
[ -f "$inc" ] || touch "$inc"
grep -q '#include pjsip_custom_cloudonix.conf' "$inc" 2>/dev/null || \
  printf '\n#include pjsip_custom_cloudonix.conf\n' >> "$inc"
inc=/etc/asterisk/extensions_custom.conf
[ -f "$inc" ] || touch "$inc"
grep -q '#include extensions_custom_cloudonix.conf' "$inc" 2>/dev/null || \
  printf '\n#include extensions_custom_cloudonix.conf\n' >> "$inc"
chown asterisk:asterisk /etc/asterisk/*cloudonix*.conf 2>/dev/null || true
SH

# Reload so the new endpoint/dialplan take effect now, not at the next restart.
run_in_pbx sh -c 'fwconsole reload >/dev/null 2>&1 || asterisk -rx "core reload" >/dev/null 2>&1' || true
echo ">>> [cloudonix] trunk configured (edge ${CLOUDONIX_EDGE_IP} → context from-trunk)"
