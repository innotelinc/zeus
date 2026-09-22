#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# deploy-ava-voice.sh — bring up the AVA voice plane, in the order that works
#
# docs/ava-integration.md lists the steps; this runs them. The order is not
# arbitrary and each step can fail in a way the next one hides:
#
#   1. the credentials are in .env            (a blank gateway key is a
#      placeholder LLM adapter: calls connect and nobody answers)
#   2. .env and scripts/pbx.env agree on the ARI secret
#      (pbx/ava_ari_check.py — otherwise ari.conf accepts a password the
#      engine does not have)
#   3. the AVA checkout is at the pinned rev and the seeded config is current
#      (scripts/fetch-ava.sh --check)
#   4. both speech models are on disk         (the server starts without them,
#      logs two "model not found" lines, and every call has no speech)
#   5. seed, fetch assets, render the dialplan, start the profile
#   6. rotate AVA's one-time admin password into .env
#      (until then the portal logs in and every screen is 403)
#
# Usage:
#   bash scripts/deploy-ava-voice.sh --check     # verify 1-4 and stop; changes nothing
#   bash scripts/deploy-ava-voice.sh             # check, then 5-6, then report
#
# Options:
#   --check        preflight only (safe on any host, including this repo's CI box)
#   --no-models    skip scripts/fetch-ava-models.sh (models already staged)
#   --no-pbx       skip pbx/bootstrap-zeus-pbx.sh (the sync timer owns the dialplan)
#   --no-up        prepare everything, start nothing
#   --no-build     docker compose up without --build (images already built)
#   --no-password  skip the admin password rotation (do it later)
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

MODE="apply"
DO_MODELS=1; DO_PBX=1; DO_UP=1; DO_BUILD=1; DO_PASSWORD=1
for arg in "$@"; do
  case "$arg" in
    --check) MODE="check" ;;
    --no-models) DO_MODELS=0 ;;
    --no-pbx) DO_PBX=0 ;;
    --no-up) DO_UP=0 ;;
    --no-build) DO_BUILD=0 ;;
    --no-password) DO_PASSWORD=0 ;;
    -h|--help) sed -n '2,31p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg (try --help)" >&2; exit 1 ;;
  esac
done

RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; CYAN=$'\033[0;36m'; YELLOW=$'\033[0;33m'; NC=$'\033[0m'
info() { printf '\n%s==>%s %s\n' "${CYAN}" "${NC}" "$*"; }
pass() { printf '%s  ✓%s %s\n' "${GREEN}" "${NC}" "$*"; }
warn() { printf '%s  !%s %s\n' "${YELLOW}" "${NC}" "$*"; }
fail() { printf '%s  ✗%s %s\n' "${RED}" "${NC}" "$*" >&2; exit 1; }

ENV_FILE="${AVA_ENV_FILE:-${REPO_ROOT}/.env}"
RUNTIME_DIR="${AVA_RUNTIME_DIR:-${REPO_ROOT}/data/ava}"

# ── 1. credentials ──────────────────────────────────────────────────────────
info "1/6 credentials in ${ENV_FILE#"${REPO_ROOT}"/}"
[ -f "$ENV_FILE" ] || fail "no ${ENV_FILE} — copy .env.example and fill in the AVA_* block"
missing=()
for key in AVA_ADMIN_JWT_SECRET AVA_ARI_SECRET OMNIROUTE_API_KEY; do
  value="$(python3 scripts/env_file.py get "$ENV_FILE" "$key")"
  if [ -z "$value" ]; then missing+=("$key"); fi
done
if [ "${#missing[@]}" -gt 0 ]; then
  fail "unset in ${ENV_FILE}: ${missing[*]} — see .env.example; scripts/fetch-ava.sh names why each one matters"
fi
pass "AVA_ADMIN_JWT_SECRET, AVA_ARI_SECRET and OMNIROUTE_API_KEY are set"

# ── 2. one ARI secret, two files ────────────────────────────────────────────
info "2/6 the engine and the PBX share one ARI secret"
# Checked against the same two files this script validated above, not the
# defaults: run with AVA_ENV_FILE/PBX_ENV_FILE pointed elsewhere and the check
# must follow, or it approves one deployment and starts another.
python3 pbx/ava_ari_check.py --engine-env "$ENV_FILE" \
  --pbx-env "${PBX_ENV_FILE:-${REPO_ROOT}/scripts/pbx.env}" \
  || fail "fix the ARI secret before deploying: an engine the PBX does not recognise is calls that are never answered"

# ── 3. pinned checkout + seeded config ──────────────────────────────────────
info "3/6 AVA checkout and seeded runtime config"
bash scripts/fetch-ava.sh --check || fail "fetch-ava.sh --check failed — run: bash scripts/fetch-ava.sh"

# ── 4. speech models ────────────────────────────────────────────────────────
info "4/6 on-box speech models"
stt="$(python3 scripts/env_file.py get "$ENV_FILE" LOCAL_STT_MODEL_PATH)"
stt="${stt:-${RUNTIME_DIR}/models/stt/vosk-model-small-en-us-0.15}"
tts="$(python3 scripts/env_file.py get "$ENV_FILE" LOCAL_TTS_MODEL_PATH)"
tts="${tts:-${RUNTIME_DIR}/models/tts/en_US-lessac-medium.onnx}"
for model in "$stt" "$tts"; do
  case "$model" in
    /app/*) model="${RUNTIME_DIR}${model#/app}" ;;   # compose paths are container paths
  esac
  [ -e "$model" ] || fail "missing speech model: ${model} — run: bash scripts/fetch-ava-models.sh"
done
pass "Vosk + Piper models present"

# ── host sanity: this is the box the profile targets ────────────────────────
test_ip="$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.*src \([0-9.]*\).*/\1/p' | head -1)"
lan_ip="$(python3 scripts/env_file.py get "$ENV_FILE" LAN_IP)"
if [ -z "$test_ip" ] || [ -z "$lan_ip" ]; then
  warn "cannot tell whether this is the host ${ENV_FILE} describes (LAN_IP unset, or no"
  warn "default route to read it from). The voice profile is host-networked, so confirm"
  warn "this is the box the PBX and the portal expect AVA on before starting it."
elif [ "$test_ip" != "$lan_ip" ]; then
  warn "this host's LAN address is ${test_ip} but ${ENV_FILE} says LAN_IP=${lan_ip}."
  warn "the voice profile is host-networked: AudioSocket and ARI would be published"
  warn "on THIS box while the PBX and the portal expect them on ${lan_ip}. Deploy on"
  warn "${lan_ip}, or change LAN_IP/AVA_*_HOST with intent."
else
  pass "this is the host ${ENV_FILE} describes (${lan_ip})"
fi

if [ "$MODE" = "check" ]; then
  info "check complete — nothing was changed"
  echo "apply with: bash scripts/deploy-ava-voice.sh"
  echo "  (--no-models / --no-pbx / --no-up / --no-build / --no-password narrow it)"
  exit 0
fi

# ── 5. seed, assets, dialplan, containers ───────────────────────────────────
info "5/6 preparing AVA"
bash scripts/fetch-ava.sh
if [ "$DO_MODELS" = 1 ]; then bash scripts/fetch-ava-models.sh; else warn "--no-models: using the models already in data/ava/models"; fi
if [ "$DO_PBX" = 1 ]; then bash pbx/bootstrap-zeus-pbx.sh; else warn "--no-pbx: dialplan left to the sync timer"; fi

if [ "$DO_UP" = 1 ]; then
  up=(docker compose --profile voice up -d)
  [ "$DO_BUILD" = 1 ] && up=(docker compose --profile voice up -d --build)
  "${up[@]}"
  pass "voice profile started"
else
  warn "--no-up: containers not started"
fi

# ── 6. the admin account the portal authenticates as ────────────────────────
if [ "$DO_PASSWORD" = 1 ] && [ "$DO_UP" = 1 ]; then
  info "6/6 AVA admin password"
  admin_url="$(python3 scripts/env_file.py get "$ENV_FILE" AVA_ADMIN_URL)"; admin_url="${admin_url:-http://127.0.0.1:8770}"
  ready=0
  for _ in $(seq 1 30); do
    if curl -fsS -m 3 "${admin_url%/}/health" >/dev/null 2>&1; then ready=1; break; fi
    sleep 4
  done
  if [ "$ready" = 1 ]; then
    AVA_ADMIN_URL="$admin_url" bash scripts/ava-admin-password.sh || warn "password rotation did not complete — the portal will report AVA's first-run state until it does"
  else
    warn "AVA's admin API did not answer on ${admin_url} within 120s. It mints a one-time"
    warn "password on first start; once it is up, run: bash scripts/ava-admin-password.sh"
  fi
else
  info "6/6 admin password — skipped"
fi

# ── what to watch ───────────────────────────────────────────────────────────
info "verify"
echo "  docker compose logs -f ai-engine | grep -E 'ARI|AudioSocket'   # expect: connected to ARI"
echo "  curl -s localhost:15000/metrics | head"
echo "  bash scripts/ava-admin-password.sh --check"
echo "  point the DIDs at Custom Destination zeus-ai-router,s,1 (docs/ava-integration.md)"
