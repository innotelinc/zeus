#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
# Zeus — PBX bootstrap (mirrors the Capstone pbx/ convention)
#
# Renders the asterisk fragments in pbx/asterisk/ (AMI user, ARI user,
# HTTP/WSS transport, portal dialplan) and applies them to the FreePBX
# custom include dir, then reloads the dialplan. Idempotent.
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
#   ARI_HTTP_PORT     (default 8088)        AMI_PERMIT (extra permit line)
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
ARI_HTTP_PORT="${ARI_HTTP_PORT:-8088}"
: "${FREEPBX_AMI_SECRET:?FREEPBX_AMI_SECRET is required (see scripts/pbx.env.example)}"
: "${FREEPBX_ARI_SECRET:?FREEPBX_ARI_SECRET is required (see scripts/pbx.env.example)}"
AMI_PERMIT_LINE="permit = ${AMI_PERMIT:-10.0.0.0/255.0.0.0}"

# Render every fragment with the runtime secrets substituted.
render_fragments() {
  rm -rf "$STAGE_DIR"
  mkdir -p "$STAGE_DIR"
  for frag in "$FRAG_DIR"/*.conf; do
    sed \
      -e "s/__AMI_USER__/${FREEPBX_AMI_USER}/g" \
      -e "s/__AMI_SECRET__/${FREEPBX_AMI_SECRET}/g" \
      -e "s/__ARI_USER__/${FREEPBX_ARI_USER}/g" \
      -e "s/__ARI_SECRET__/${FREEPBX_ARI_SECRET}/g" \
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
#       (ari.conf on these FreePBX builds is a plain file with NO #include of
#       a *_custom.conf, so ari_custom.conf would never be read.)
CONVERGE_OWNED="extensions_custom.conf ari.conf"

_is_converge_owned() {
  local name="$1" owned
  for owned in $CONVERGE_OWNED; do
    [ "$name" = "$owned" ] && return 0
  done
  return 1
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
  trap 'rm -rf "$work"' EXIT
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
  if ! python3 "$CONVERGE_PY" --target "$host" --source "${STAGE_DIR}/${name}" \
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
    python3 "$CONVERGE_PY" --target "$host" --source "${STAGE_DIR}/${name}" \
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