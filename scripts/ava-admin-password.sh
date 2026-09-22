#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# ava-admin-password.sh — rotate AVA's admin password and record it in .env
#
# On a fresh install AVA writes `data/ava/project/config/users.json` with a
# random one-time password (admin_ui/backend/auth.py, ensure_default_user) and
# sets must_change_password. Until that password is changed, AVA answers 403 to
# every endpoint except /api/auth/me and /api/auth/change-password — so the
# Zeus portal can log in and still not read a single agent or call. The screens
# report that state by name (src/lib/ava.ts), and this script is the other half:
# it performs the rotation and puts the result where the portal reads it.
#
# It is idempotent: with a rotated password already in .env it logs in, finds
# nothing pending, and exits 0 without writing anything.
#
# Usage:
#   bash scripts/ava-admin-password.sh             # rotate if the account is still on its one-time password
#   bash scripts/ava-admin-password.sh --check     # report only; exit 1 when a rotation is pending
#
# Overrides (environment, or values already in .env):
#   AVA_ADMIN_URL       admin API base (default http://127.0.0.1:8770)
#   AVA_ADMIN_USER      admin user (default admin)
#   AVA_ENV_FILE        env file to read and update (default <repo>/.env)
#   AVA_RUNTIME_DIR     runtime tree (default <repo>/data/ava)
#   AVA_NEW_PASSWORD    the password to set (default: 32 random hex chars)
#
# Exit: 0 done, nothing pending, or (for --check) already rotated; 1 otherwise.
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${AVA_ENV_FILE:-${REPO_ROOT}/.env}"
RUNTIME_DIR="${AVA_RUNTIME_DIR:-${REPO_ROOT}/data/ava}"
FIRST_RUN_FILE="${RUNTIME_DIR}/project/config/.first-run-password"
ENV_HELPER="${REPO_ROOT}/scripts/env_file.py"

MODE="apply"
for arg in "$@"; do
  case "$arg" in
    --check) MODE="check" ;;
    -h|--help) sed -n '2,32p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg (try --help)" >&2; exit 1 ;;
  esac
done

# .env is read for the values an operator put there, but an environment
# variable set by the caller wins over it — otherwise `AVA_ADMIN_URL=... bash
# scripts/ava-admin-password.sh` would be silently overridden by the file, which
# is how a script that thinks it is talking to one admin talks to another.
_save() { eval "_pre_$1=\"\${$1:-}\""; }
_save AVA_ADMIN_URL; _save AVA_ADMIN_USER; _save AVA_ADMIN_PASSWORD; _save AVA_RUNTIME_DIR
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi
for _v in AVA_ADMIN_URL AVA_ADMIN_USER AVA_ADMIN_PASSWORD AVA_RUNTIME_DIR; do
  eval "_from_env=\"\${_pre_${_v}:-}\""
  [ -n "$_from_env" ] && eval "${_v}=\"\$_from_env\""
done
unset _v _from_env

ADMIN_USER="${AVA_ADMIN_USER:-admin}"
ADMIN_URL="${AVA_ADMIN_URL:-http://127.0.0.1:8770}"
ADMIN_URL="${ADMIN_URL%/}"
RUNTIME_DIR="${AVA_RUNTIME_DIR:-${RUNTIME_DIR}}"
FIRST_RUN_FILE="${RUNTIME_DIR}/project/config/.first-run-password"

RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; CYAN=$'\033[0;36m'; YELLOW=$'\033[0;33m'; NC=$'\033[0m'
info() { printf '%s==>%s %s\n' "${CYAN}" "${NC}" "$*"; }
pass() { printf '%s  ✓%s %s\n' "${GREEN}" "${NC}" "$*"; }
warn() { printf '%s  !%s %s\n' "${YELLOW}" "${NC}" "$*"; }
fail() { printf '%s  ✗%s %s\n' "${RED}" "${NC}" "$*" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v python3 >/dev/null 2>&1 || fail "python3 is required"
[ -f "$ENV_HELPER" ] || fail "missing helper: ${ENV_HELPER}"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
BODY="${TMP_DIR}/body"

# Sets STATUS and leaves the body in $BODY rather than printing it: a caller
# that captured the body with $( ) would do so in a subshell, and every
# assignment this function makes — including the status code — would be
# discarded with it, which looked exactly like "HTTP " on a rejected login.
STATUS=""
http() { # http METHOD PATH [BEARER] [curl args...]
  local method="$1" path="$2" token="${3:-}"
  shift 3 2>/dev/null || shift $#
  local args=(-sS -m 15 -X "$method" "${ADMIN_URL}${path}" -H 'Accept: application/json')
  if [ -n "$token" ]; then args+=(-H "Authorization: Bearer ${token}"); fi
  args+=("$@")
  local code
  code="$(curl "${args[@]}" -o "$BODY" -w '%{http_code}' 2>/dev/null || true)"
  STATUS="${code:-000}"
  return 0
}

jget() { # jget KEY  (JSON on stdin) -> prints the value, empty for null/missing
  python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    data = None
if not isinstance(data, dict):
    sys.exit(0)
value = data.get(sys.argv[1])
if value is None:
    print("")
elif value is True:
    print("true")
elif value is False:
    print("false")
else:
    print(value)
' "$1"
}

# ── what state is the account in? ───────────────────────────────────────────
info "AVA admin at ${ADMIN_URL} (user ${ADMIN_USER})"

# Ask whether it is up before asking whether the account is rotated: without a
# credential there is no login to attempt, and "nothing to rotate with" is the
# wrong thing to tell an operator whose admin container simply is not running.
http GET /health
case "$STATUS" in
  000) fail "AVA admin API is unreachable at ${ADMIN_URL} — start it first: docker compose --profile voice up -d ai-engine-admin (or set AVA_ADMIN_URL)" ;;
  2*) pass "admin API is up" ;;
  *) warn "${ADMIN_URL}/health answered HTTP ${STATUS} — continuing anyway" ;;
esac

TOKEN=""
OLD_PASSWORD=""
PENDING=""

configured="${AVA_ADMIN_PASSWORD:-}"
if [ -n "$configured" ]; then
  http POST /api/auth/login "" \
    -H 'Content-Type: application/x-www-form-urlencoded' \
    --data-urlencode "username=${ADMIN_USER}" --data-urlencode "password=${configured}"
  case "$STATUS" in
    200)
      token="$(jget access_token < "$BODY")"
      must="$(jget must_change_password < "$BODY")"
      if [ "$must" = "true" ]; then
        PENDING="the password in ${ENV_FILE} is still the one-time password"
        TOKEN="$token"; OLD_PASSWORD="$configured"
      else
        TOKEN="$token"
      fi
      ;;
    000) fail "AVA admin API is unreachable at ${ADMIN_URL} — start it first: docker compose --profile voice up -d ai-engine-admin (or set AVA_ADMIN_URL)" ;;
    *) warn "AVA_ADMIN_PASSWORD was rejected (HTTP ${STATUS}): ${BODY:-no body}" ;;
  esac
fi

if [ -z "$PENDING" ] && [ -z "$TOKEN" ] && [ -f "$FIRST_RUN_FILE" ]; then
  one_time="$(head -1 "$FIRST_RUN_FILE")"
  http POST /api/auth/login "" \
    -H 'Content-Type: application/x-www-form-urlencoded' \
    --data-urlencode "username=${ADMIN_USER}" --data-urlencode "password=${one_time}"
  if [ "$STATUS" = "200" ]; then
    PENDING="AVA is still on the one-time password it minted at first start"
    TOKEN="$(jget access_token < "$BODY")"
    OLD_PASSWORD="$one_time"
  else
    warn "${FIRST_RUN_FILE} exists but its password was refused (HTTP ${STATUS})"
  fi
fi

if [ -z "$PENDING" ] && [ -z "$TOKEN" ]; then
  hint="If AVA has never started on this host, that is expected: start the profile"
  hint="${hint} (bash scripts/deploy-ava-voice.sh) and this will have a password to rotate."
  hint="${hint} If it has started, set AVA_ADMIN_PASSWORD in ${ENV_FILE} to the account's"
  hint="${hint} password — the portal authenticates with it either way."
  if [ "$MODE" = "check" ]; then
    fail "cannot tell whether the admin password is rotated: AVA_ADMIN_PASSWORD is unset and no one-time password is waiting in ${RUNTIME_DIR}/project/config/. ${hint}"
  fi
  fail "nothing to rotate with — no AVA_ADMIN_PASSWORD and no one-time password in ${RUNTIME_DIR}/project/config/. ${hint}"
fi

if [ -z "$PENDING" ]; then
  pass "already rotated — the password in ${ENV_FILE} authenticates, and AVA is not asking for a change"
  exit 0
fi

if [ "$MODE" = "check" ]; then
  fail "${PENDING} (run without --check to rotate it)"
fi

# ── rotate ──────────────────────────────────────────────────────────────────
info "${PENDING} — rotating"
NEW_PASSWORD="${AVA_NEW_PASSWORD:-$(openssl rand -hex 16)}"

http POST /api/auth/change-password "$TOKEN" \
  -H 'Content-Type: application/json' \
  --data "$(python3 -c '
import json, sys
# Passed as argv, not interpolated: an operator-chosen password must not be
# able to break out of the JSON.
print(json.dumps({"old_password": sys.argv[1], "new_password": sys.argv[2]}))
' "$OLD_PASSWORD" "$NEW_PASSWORD")"
[ "$STATUS" = "200" ] || fail "change-password failed (HTTP ${STATUS}): ${BODY:-no body}"

# The portal authenticates with this value, so it has to be recorded before
# anything else is reported as done.
if [ ! -f "$ENV_FILE" ]; then
  fail "rotated, but ${ENV_FILE} does not exist to record it — copy .env.example first, then set AVA_ADMIN_PASSWORD manually"
fi
BACKUP="${ENV_FILE}.bak-$(date +%Y%m%d-%H%M%S)"
cp -p "$ENV_FILE" "$BACKUP"
printf '%s' "$NEW_PASSWORD" | python3 "$ENV_HELPER" set "$ENV_FILE" AVA_ADMIN_PASSWORD \
  || fail "rotated, but writing ${ENV_FILE} failed (backup: ${BACKUP}) — set AVA_ADMIN_PASSWORD manually"
pass "wrote AVA_ADMIN_PASSWORD to ${ENV_FILE#"${REPO_ROOT}"/} (backup: ${BACKUP##*/})"

# AVA's own instruction on that file: change it at first login, then delete it.
if [ -f "$FIRST_RUN_FILE" ]; then
  rm -f "$FIRST_RUN_FILE"
  pass "removed ${FIRST_RUN_FILE#"${REPO_ROOT}"/} (the one-time password is spent)"
fi

info "next: restart the portal so it picks up the new value, then reload /dashboard/voice"
