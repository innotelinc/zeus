#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
# Zeus — PBX bootstrap (mirrors the Capstone pbx/ convention)
#
# Renders the asterisk fragments in pbx/asterisk/ (AMI user, ARI user,
# HTTP/WSS transport, portal dialplan) and applies them to the FreePBX
# custom include dir, then reloads the dialplan. Idempotent.
#
# rtp_custom.conf is NOT applied here: the runtime entrypoint owns the RTP plane
# (docker-entrypoint-full.sh / scripts/setup.sh derive it from FREEPBX_RTP_PORT_*
# + PJSIP_STUN_TURN_ADDR on every boot), so bootstrap skips it entirely.
#
# extensions_custom.conf is NOT copied wholesale: it goes through
# pbx/asterisk_converge.py (per-context merge, [from-internal-custom] is
# append-shared under ownership markers) so capstone's contexts survive on
# a shared PBX. Run the converge tool once per product on shared boxes:
#   pbx/bootstrap-zeus-pbx.sh                                    # zeus half
#   python3 pbx/asterisk_converge.py --target <ext_custom.conf>  # capstone
#     --source <capstone-repo>/pbx/asterisk/extensions_custom.conf \
#     --owner capstone --append from-internal-custom
#
# Targets:
#   PBX_TARGET=local      write to the host's FreePBX (default)
#   PBX_TARGET=container  write into the `freepbx` compose container
#                         (docker compose -f docker-compose.full.yml)
#
# Usage:
#   pbx/bootstrap-zeus-pbx.sh            # apply (idempotent)
#   pbx/bootstrap-zeus-pbx.sh --check    # drift check only, exit 1 if out of sync
#   pbx/bootstrap-zeus-pbx.sh --reload   # apply + force dialplan reload
#
# Reads from pbx.env (scripts/pbx.env.example) or the environment:
#   FREEPBX_AMI_USER  (default pbxportal)   FREEPBX_AMI_SECRET
#   FREEPBX_ARI_USER  (default pbxportal)   FREEPBX_ARI_SECRET
#   AVA_ARI_USER      (default zeus-ava)    AVA_ARI_SECRET (generated if blank
#                                            — persist it; the AVA voice engine
#                                            authenticates with this pair)
#   ARI_HTTP_PORT     (default 8088)        AMI_PERMIT (permit line, default:
#                                            this host's LAN subnet — never a
#                                            docker bridge range)
#   ZEUS_PORTAL_URL   portal base URL the [zeus-ai-accounts] plan is fetched
#                     from (default http://127.0.0.1:3001)
#   PBX_SYNC_TOKEN    bearer token for that fetch (portal env PBX_SYNC_TOKEN).
#                     Without it, or when the portal is unreachable, the
#                     context is rendered from the portal's cached database.
#   ZEUS_PORTAL_DB    that SQLite database. Default: the zeus-portal-data
#                     volume. When neither is readable the static placeholder
#                     stands.
# ═══════════════════════════════════════════════════════════════════
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
FRAG_DIR="${SCRIPT_DIR}/asterisk"
STAGE_DIR="${REPO_ROOT}/.pbx-stage"

CHECK=0
RELOAD=0
for arg in "$@"; do
  case "$arg" in
    --check) CHECK=1 ;;
    --reload) RELOAD=1 ;;
    --help|-h) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 1 ;;
  esac
done

PBX_ENV_FILE="${PBX_ENV_FILE:-${SCRIPT_DIR}/../scripts/pbx.env}"
if [ -f "$PBX_ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$PBX_ENV_FILE"
  set +a
fi

PBX_TARGET="${PBX_TARGET:-local}"
FREEPBX_AMI_USER="${FREEPBX_AMI_USER:-pbxportal}"
FREEPBX_ARI_USER="${FREEPBX_ARI_USER:-pbxportal}"
# AVA (first-response voice agent) gets its own ARI user: it owns the
# asterisk-ai-voice-agent Stasis application, while the portal user only
# originates/hangs up. Generate one when the operator leaves it blank so a
# fresh PBX is AVA-ready without hand-editing pbx.env — and keep the engine
# and the PBX reading the SAME value (compose passes AVA_ARI_* through).
AVA_ARI_USER="${AVA_ARI_USER:-zeus-ava}"
if [ -z "${AVA_ARI_SECRET:-}" ]; then
  AVA_ARI_SECRET="$(openssl rand -hex 16)"
  echo "  ! AVA_ARI_SECRET not set — generated one for this run; persist it in" >&2
  echo "    pbx.env or the AVA engine will fail ARI authentication after a restart" >&2
fi
ARI_HTTP_PORT="${ARI_HTTP_PORT:-8088}"
: "${FREEPBX_AMI_SECRET:?FREEPBX_AMI_SECRET is required (see scripts/pbx.env.example)}"
: "${FREEPBX_ARI_SECRET:?FREEPBX_ARI_SECRET is required (see scripts/pbx.env.example)}"
# AMI permit — LAN subnet only. PROJECT RULE: LAN addresses only; the portal
# connects to AMI over this host's LAN IP (host networking), so a docker bridge
# range must never be needed. Derive the subnet from the default-route source
# (the host's primary LAN address) rather than hard-coding one, and fall back to
# the RFC1918 192.168/16 block when the address cannot be detected.
if [ -z "${AMI_PERMIT:-}" ]; then
  _lan_ip="$(ip -4 route get 1 2>/dev/null | sed -n 's/.*src \([0-9.]*\).*/\1/p' | head -1)"
  if [ -n "$_lan_ip" ] && [ "$_lan_ip" != "127.0.0.1" ]; then
    AMI_PERMIT="$(printf '%s' "$_lan_ip" | awk -F. '{print $1"."$2"."$3".0/255.255.255.0"}')"
  else
    AMI_PERMIT="192.168.0.0/255.255.0.0"
  fi
fi
AMI_PERMIT_LINE="permit = ${AMI_PERMIT}"

# Fragments the RUNTIME entrypoint owns — it derives them from .env on every
# boot, so bootstrap must not stage, copy or drift-check them:
#   rtp_custom.conf — docker-entrypoint-full.sh (Docker) and scripts/setup.sh
#       (bare metal) write it with the exact FREEPBX_RTP_PORT_START/END range and
#       PJSIP_STUN_TURN_ADDR. A static copy from this repo would fight it and
#       always report drift on a non-default range. The repo file is the shape
#       reference the entrypoint mirrors.
#   pjsip_custom_cloudonix.conf / extensions_custom_cloudonix.conf —
#       pbx/setup-cloudonix-trunk.sh renders both from CLOUDONIX_* and keeps
#       their #include lines alive. Check them with that script's own --check
#       instead of staging them here (two owners would fight over the file).
ENTRYPOINT_OWNED="rtp_custom.conf pjsip_custom_cloudonix.conf extensions_custom_cloudonix.conf"

_is_entrypoint_owned() {
  local name="$1" owned
  for owned in $ENTRYPOINT_OWNED; do
    [ "$name" = "$owned" ] && return 0
  done
  return 1
}

# Render every fragment with the runtime secrets substituted.
render_fragments() {
  rm -rf "$STAGE_DIR"
  mkdir -p "$STAGE_DIR"
  for frag in "$FRAG_DIR"/*.conf; do
    _is_entrypoint_owned "$(basename "$frag")" && continue
    sed \
      -e "s/__AMI_USER__/${FREEPBX_AMI_USER}/g" \
      -e "s/__AMI_SECRET__/${FREEPBX_AMI_SECRET}/g" \
      -e "s/__ARI_USER__/${FREEPBX_ARI_USER}/g" \
      -e "s/__ARI_SECRET__/${FREEPBX_ARI_SECRET}/g" \
      -e "s/__AVA_ARI_USER__/${AVA_ARI_USER}/g" \
      -e "s/__AVA_ARI_SECRET__/${AVA_ARI_SECRET}/g" \
      -e "s/__ARI_HTTP_PORT__/${ARI_HTTP_PORT}/g" \
      -e "s|__AMI_PERMIT__|${AMI_PERMIT_LINE}|g" \
      "$frag" > "${STAGE_DIR}/$(basename "$frag")"
  done
}

# Where the rendered files land on the PBX.
pbx_asterisk_dir() {
  if [ "$PBX_TARGET" = "container" ]; then
    # The freepbx container mounts /etc/asterisk from a named volume; write
    # via docker cp and reload with fwconsole inside the container.
    echo "/etc/asterisk"
  else
    echo "${FREEPBX_ASTERISK_DIR:-/etc/asterisk}"
  fi
}

CONVERGE_PY="${SCRIPT_DIR}/asterisk_converge.py"
# Files converge OWNS: never copied wholesale, merged per-section instead.
#   extensions_custom.conf — the shared dialplan (capstone's [dograh-inbound]
#       must survive), zeus contexts replace, [from-internal-custom] append-shared.
#   ari.conf — the real ARI config Asterisk reads; zeus's [<user>] section
#       converges in while [general] and other products' ARI users pass through.
#       Note: on the FreePBX builds this stack ships, ari.conf is a SYMLINK
#       into the arimanager module and ari_additional.conf is regenerated on
#       every Apply Config — which is why the AVA user below goes to
#       ari_additional_custom.conf (included by ari.conf, module-owned-adjacent,
#       and the file the shared voice plane already uses for Capstone's
#       [dograh]). ari_custom.conf is NOT included on these builds.
#   ari_additional_custom.conf — AVA's own ARI user (see that fragment).
CONVERGE_OWNED="extensions_custom.conf ari.conf ari_additional_custom.conf"

_is_converge_owned() {
  local name="$1" owned
  for owned in $CONVERGE_OWNED; do
    [ "$name" = "$owned" ] && return 0
  done
  return 1
}

# ── the one GENERATED context ──────────────────────────────────────────
# Every other context in extensions_custom.conf is stored in pbx/asterisk/.
# [zeus-ai-accounts] is not: it is a per-account decision, so it is rendered
# from the portal's accounts and the Capstone hand-off gate then follows
# billing instead of a file someone has to remember to re-render.
# pbx/ava_routing.py writes ZEUS_CAPSTONE_ADDON=1 only for accounts the portal
# recorded as entitled, and treats a MISSING record as not entitled — so the
# cached-database render on its own can only ever be too strict, never too
# generous.
#
# THE PORTAL IS THE SOURCE, not its cache. GET /api/admin/voice-routing is the
# routing authority and re-checks the add-on gate against Magnate on every
# call, so fetching it (with PBX_SYNC_TOKEN) is what keeps this context in step
# with billing. Reading the cache instead would freeze the plan at whatever it
# was the last time an operator opened the screen — a lapsed subscription
# would never un-wire, and a gate that is inactive in this deployment (see
# src/lib/addons.ts) would never show up as entitled.
#
# ZEUS_PORTAL_DB names the cache explicitly; otherwise it is located through
# the compose volume the portal writes. That path is the FALLBACK for a portal
# that is down or has no token configured, and it stays fail-closed on a
# missing record: without a portal there is no authority to say otherwise.
# When neither is readable — a fresh host, a portal that has never run — the
# static placeholder stands.
AVA_ROUTING_PY="${SCRIPT_DIR}/ava_routing.py"
ACCOUNTS_DIR=""
ACCOUNTS_SRC=""

cleanup() {
  [ -n "${work:-}" ] && rm -rf "$work"
  [ -n "${ACCOUNTS_DIR:-}" ] && rm -rf "$ACCOUNTS_DIR"
  return 0
}

portal_db() {
  if [ -n "${ZEUS_PORTAL_DB:-}" ]; then
    [ -f "$ZEUS_PORTAL_DB" ] && printf '%s\n' "$ZEUS_PORTAL_DB"
    return 0
  fi
  local mp
  mp="$(docker volume inspect zeus-portal-data \
        --format '{{.Mountpoint}}' 2>/dev/null)" || return 0
  [ -n "$mp" ] && [ -f "${mp}/pbx.db" ] && printf '%s\n' "${mp}/pbx.db"
  return 0
}

# Renders [zeus-ai-accounts] into a fragment the converge tool merges last, so
# its context replaces the placeholder in the static file.
render_account_routing() {
  local db out plan
  ACCOUNTS_DIR="$(mktemp -d)"
  trap cleanup EXIT
  out="${ACCOUNTS_DIR}/accounts.conf"

  # Preferred path: ask the portal, which re-checks the gate against Magnate.
  # A 503 from the portal (indecisive gate) is deliberately NOT recovered from
  # here: the authority declining to answer must not be papered over with a
  # cached answer, which is the stale-plan failure this exists to avoid. The
  # PBX then keeps the fragment it already has.
  if [ -n "${PBX_SYNC_TOKEN:-}" ]; then
    plan="${ACCOUNTS_DIR}/accounts.json"
    if curl -fsS --max-time 20 \
         -H "Authorization: Bearer ${PBX_SYNC_TOKEN}" \
         "${ZEUS_PORTAL_URL:-http://127.0.0.1:3001}/api/admin/voice-routing" \
         -o "$plan" 2>/dev/null \
       && python3 "$AVA_ROUTING_PY" --accounts-json "$plan" --out "$out" 2>/dev/null; then
      ACCOUNTS_SRC="$out"
      return 0
    fi
    echo "zeus-pbx: portal routing plan unavailable — using the cached database" >&2
  fi

  db="$(portal_db)"
  if [ -z "$db" ]; then
    echo "zeus-pbx: no portal database — [zeus-ai-accounts] keeps the default agent" >&2
    return 0
  fi
  if ! python3 "$AVA_ROUTING_PY" --db "$db" --out "$out"; then
    # A plan that cannot be read is not a plan. Leave the placeholder rather
    # than converge a half-rendered account list onto a live PBX.
    rm -rf "$ACCOUNTS_DIR"
    ACCOUNTS_DIR=""
    echo "zeus-pbx: could not render accounts from ${db} — keeping the default agent" >&2
    return 0
  fi
  ACCOUNTS_SRC="$out"
}

apply_target() {
  local dest
  dest="$(pbx_asterisk_dir)"
  if [ "$PBX_TARGET" = "container" ]; then
    for f in "$STAGE_DIR"/*.conf; do
      _is_converge_owned "$(basename "$f")" && continue  # converge tool owns it
      docker compose -f "$REPO_ROOT/docker-compose.full.yml" cp \
        "$f" "freepbx:${dest}/$(basename "$f")"
    done
  else
    for f in "$STAGE_DIR"/*.conf; do
      _is_converge_owned "$(basename "$f")" && continue  # converge tool owns it
      cp "$f" "${dest}/$(basename "$f")"
      chown asterisk:asterisk "${dest}/$(basename "$f")" 2>/dev/null || true
      chmod 640 "${dest}/$(basename "$f")" 2>/dev/null || true
    done
  fi
}

reload_pbx() {
  if [ "$PBX_TARGET" = "container" ]; then
    docker compose -f "$REPO_ROOT/docker-compose.full.yml" exec -T freepbx \
      fwconsole reload 2>/dev/null || \
      docker compose -f "$REPO_ROOT/docker-compose.full.yml" exec -T freepbx \
        asterisk -rx 'core reload' 2>/dev/null || true
  else
    fwconsole reload 2>/dev/null || asterisk -rx 'core reload' 2>/dev/null || true
  fi
}

render_fragments
render_account_routing

# extensions_custom.conf / ari.conf are SHARED files: once another product
# (capstone's [dograh-inbound] dialplan, [dograh] ARI user) lives in them, a
# wholesale copy would clobber their content. They go through the per-context
# converge tool instead: contexts zeus owns replace wholesale and
# [from-internal-custom] is append-shared — zeus's entries are added under
# ownership markers and never touch other owners' lines. In a shared
# deployment run the tool once per product (see pbx/README.md).

# Drift check: rendered vs applied (converge-owned files handled below).
drift=0
dest="$(pbx_asterisk_dir)"
for f in "$STAGE_DIR"/*.conf; do
  name="$(basename "$f")"
  _is_converge_owned "$name" && continue
  if [ "$PBX_TARGET" = "container" ]; then
    current="$STAGE_DIR/current-${name}"
    docker compose -f "$REPO_ROOT/docker-compose.full.yml" exec -T freepbx \
      cat "${dest}/${name}" > "$current" 2>/dev/null || { drift=1; continue; }
  else
    current="${dest}/${name}"
  fi
  if ! cmp -s "$f" "$current" 2>/dev/null; then
    echo "drift: ${name}" >&2
    drift=1
  fi
done

# Pull each converge-owned live file to a host path the converge tool can
# read (container target), then drift-check against the rendered fragment.
work=""
if [ "$PBX_TARGET" = "container" ]; then
  work="$(mktemp -d)"
  trap cleanup EXIT
fi
for name in $CONVERGE_OWNED; do
  host="${work:+${work}/}${name}"
  if [ "$PBX_TARGET" = "container" ]; then
    docker compose -f "$REPO_ROOT/docker-compose.full.yml" exec -T freepbx \
      cat "${dest}/${name}" > "$host" 2>/dev/null || : > "$host"
  else
    host="${dest}/${name}"
  fi
  [ -f "$host" ] || : > "$host"
  # converge applies sources in order, so the rendered accounts fragment goes
  # last and wins for [zeus-ai-accounts].
  extra=()
  [ "$name" = "extensions_custom.conf" ] && [ -n "$ACCOUNTS_SRC" ] && \
    extra=(--source "$ACCOUNTS_SRC")
  if ! python3 "$CONVERGE_PY" --target "$host" --source "${STAGE_DIR}/${name}" \
       ${extra[@]+"${extra[@]}"} \
       --owner zeus --append from-internal-custom --check 2>/dev/null; then
    echo "drift: ${name} (shared config)" >&2
    drift=1
  fi
done

if [ "$CHECK" = 1 ]; then
  if [ "$drift" = 1 ]; then
    echo "zeus-pbx: out of sync (run pbx/bootstrap-zeus-pbx.sh to apply)" >&2
    exit 1
  fi
  echo "zeus-pbx: in sync"
  exit 0
fi

if [ "$drift" = 1 ] || [ "$RELOAD" = 1 ]; then
  apply_target
  for name in $CONVERGE_OWNED; do
    host="${work:+${work}/}${name}"
    [ "$PBX_TARGET" = "container" ] || host="${dest}/${name}"
    extra=()
    [ "$name" = "extensions_custom.conf" ] && [ -n "$ACCOUNTS_SRC" ] && \
      extra=(--source "$ACCOUNTS_SRC")
    python3 "$CONVERGE_PY" --target "$host" --source "${STAGE_DIR}/${name}" \
      ${extra[@]+"${extra[@]}"} \
      --owner zeus --append from-internal-custom
    if [ "$PBX_TARGET" = "container" ]; then
      docker compose -f "$REPO_ROOT/docker-compose.full.yml" cp \
        "$host" "freepbx:${dest}/${name}"
    else
      chown asterisk:asterisk "$host" 2>/dev/null || true
      chmod 640 "$host" 2>/dev/null || true
    fi
  done
  reload_pbx
  echo "zeus-pbx: applied (${PBX_TARGET})"
else
  echo "zeus-pbx: already in sync"
fi