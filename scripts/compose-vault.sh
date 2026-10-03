#!/usr/bin/env bash
# compose-vault.sh — run docker compose with this stack's `vault://` references resolved.
#
# `.env` may hold `KEY=vault://<mount>/<path>#<key>` instead of the secret
# itself. Compose cannot resolve that: it interpolates `.env` literally, so a
# service configured as `TURN_CREDENTIAL: ${TURN_CREDENTIAL:-}` (coturn) or
# `FREEPBX_AMI_SECRET: ${FREEPBX_AMI_SECRET:-}` (freepbx) receives the
# *reference string* as its credential — and those services never run the
# portal entrypoint, so nothing downstream fixes it.
#
# So: resolve first, then compose. This runs `scripts/vault-env-file.mjs` (the
# file-level companion to the portal's `scripts/vault-env.mjs`) and hands compose
# the resolved file via `--env-file` — which replaces `.env` as the interpolation
# source, not augments it, so the resolved file must be a complete copy. It is.
#
#   scripts/compose-vault.sh up -d
#   scripts/compose-vault.sh -f docker-compose.full.yml -f compose.gateway-vault.yml up -d --no-deps portal
#   scripts/compose-vault.sh --check          # resolve and report, run nothing
#
# Every `docker compose` invocation for this stack should go through here; a
# plain `docker compose up` silently regresses any service whose credential is
# a reference. `--check` is the assertion to put in CI.
#
# VAULT_ADDR / VAULT_TOKEN_FILE (or VAULT_TOKEN) are read from the environment
# first and from `.env` second. With no VAULT_ADDR set, a stack whose `.env`
# still holds references is refused rather than started with literal `vault://`
# strings as credentials.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ZEUS_ENV_FILE:-$REPO_ROOT/.env}"
RESOLVED_ENV="${ZEUS_RESOLVED_ENV:-$REPO_ROOT/data/.env.resolved}"
RESOLVER="$REPO_ROOT/scripts/vault-env-file.mjs"

CHECK=0
if [ "${1:-}" = "--check" ]; then
  CHECK=1
  shift
fi

die() { printf 'compose-vault: %s\n' "$*" >&2; exit 1; }

[ -f "$ENV_FILE" ] || die "no env file at $ENV_FILE (copy .env.example and fill it in)"
[ -f "$RESOLVER" ] || die "no resolver at $RESOLVER"
command -v node >/dev/null 2>&1 || die "node is required to resolve vault:// references"

# One key from the env file, without sourcing it (a `.env` is not shell).
env_file_value() {
  grep -m1 "^$1=" "$ENV_FILE" 2>/dev/null | cut -d= -f2- | tr -d '\r' || true
}

# Environment wins over `.env`, matching compose's own precedence.
: "${VAULT_ADDR:=$(env_file_value VAULT_ADDR)}"
: "${VAULT_TOKEN:=$(env_file_value VAULT_TOKEN)}"
: "${VAULT_TOKEN_FILE:=$(env_file_value VAULT_TOKEN_FILE)}"
: "${VAULT_PREFIX:=$(env_file_value VAULT_PREFIX)}"
export VAULT_ADDR VAULT_TOKEN VAULT_TOKEN_FILE VAULT_PREFIX

# A token file named relative to the repo must resolve from the repo, not from
# wherever compose happened to be invoked.
case "${VAULT_TOKEN_FILE:-}" in
  /*|"") ;;
  *) VAULT_TOKEN_FILE="$REPO_ROOT/$VAULT_TOKEN_FILE"; export VAULT_TOKEN_FILE ;;
esac

# `.env` names the token where the *portal container* sees it
# (`/vault/token/zeus.token`, a bind mount). On the host that same file lives at
# `./data/vault/token/`. Map the mount path back to the checkout when the
# container path is not readable here, so the same `.env` serves both.
if [ -n "${VAULT_TOKEN_FILE:-}" ] && [ ! -f "$VAULT_TOKEN_FILE" ]; then
  case "$VAULT_TOKEN_FILE" in
    /vault/token/*)
      host_token="$REPO_ROOT/data/vault/token/$(basename "$VAULT_TOKEN_FILE")"
      if [ -f "$host_token" ]; then
        VAULT_TOKEN_FILE="$host_token"
        export VAULT_TOKEN_FILE
      fi
      ;;
  esac
fi

# Count only real assignments — `.env` carries commented `vault://` examples
# that must not be treated as references (or trip the post-resolution check).
REFS="$(grep -cE '^[A-Za-z_][A-Za-z0-9_]*=vault://' "$ENV_FILE" 2>/dev/null || true)"

if [ "${REFS:-0}" -gt 0 ] && [ -z "${VAULT_ADDR:-}" ]; then
  die "$ENV_FILE has $REFS vault:// reference(s) but VAULT_ADDR is unset — \
set VAULT_ADDR (and VAULT_TOKEN_FILE) in .env, or the services will receive the \
reference string as a credential"
fi

if [ "${REFS:-0}" -eq 0 ]; then
  # Nothing to resolve; don't write a second copy of the env that could drift.
  if [ "$CHECK" = "1" ]; then
    echo "compose-vault: $ENV_FILE has no vault:// references — nothing to resolve"
    exit 0
  fi
  exec docker compose --env-file "$ENV_FILE" "$@"
fi

if [ "$CHECK" = "1" ]; then
  node "$RESOLVER" --check "$ENV_FILE" || die "a vault:// reference did not resolve"
  echo "compose-vault: resolved $REFS reference(s) (not running compose)"
  exit 0
fi

# Resolve into a sibling file first, then move into place: a crash midway must
# not leave a half-written env that the next compose run would happily read.
TMP="$(mktemp "$RESOLVED_ENV.XXXXXX")"
trap 'rm -f "$TMP"' EXIT

node "$RESOLVER" --out "$TMP" "$ENV_FILE" >&2

if grep -qE '^[A-Za-z_][A-Za-z0-9_]*=vault://' "$TMP"; then
  die "resolution left vault:// references in $TMP — refusing to start"
fi

chmod 600 "$TMP"
mkdir -p "$(dirname "$RESOLVED_ENV")"
mv -f "$TMP" "$RESOLVED_ENV"
trap - EXIT

# ── Guard: --remove-orphans must not take down a sibling service ──────────
# `docker compose -f docker-compose.yml up --remove-orphans` removes every
# container in the project that the *chosen* compose file does not declare.
# The portal file declares only `pbx` + `coturn`; FreePBX lives in
# docker-compose.full.yml. Deploying the portal that way deletes zeus-freepbx
# and takes the voice plane with it -- which is what happened on .30: the portal
# came back healthy while freepbx_api, asterisk_ami and extension_preflight all
# went `down` and Asterisk stopped routing.
#
# Refuse rather than remove. If the caller did not pass the full stack file and
# a container the full stack owns is running, --remove-orphans is about to
# delete it.
if printf '%s\n' "$@" | grep -q -- '--remove-orphans'; then
  uses_full=0
  for a in "$@"; do
    case "$a" in
      *docker-compose.full.yml) uses_full=1 ;;
    esac
  done
  if [ "$uses_full" -eq 0 ] && [ -f "$REPO_ROOT/docker-compose.full.yml" ]; then
    at_risk=""
    # The container names the full stack owns and the portal file does not.
    for n in zeus-freepbx pbx-coturn; do
      if docker ps --filter "name=^${n}$" --format '{{.Names}}' 2>/dev/null | grep -qx "$n"; then
        at_risk="$at_risk $n"
      fi
    done
    if [ -n "$at_risk" ]; then
      die "--remove-orphans would delete running stack member(s):$at_risk
They are declared in docker-compose.full.yml but not in the compose file you
passed, so compose treats them as orphans. Deploy the full stack instead:

  scripts/compose-vault.sh -f docker-compose.full.yml up -d

or drop --remove-orphans. Refusing to remove them."
    fi
  fi
fi

exec docker compose --env-file "$RESOLVED_ENV" "$@"
