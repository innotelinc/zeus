#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
# fetch-ava.sh — check out AVA (Asterisk AI Voice Agent) at the pinned commit
# and seed its runtime tree.
#
# AVA is the first response on the Zeus voice plane (see
# docs/ava-integration.md). It is a whole application with its own compose
# file, so it is not vendored as an artifact like the FreePBX tarballs in
# scripts/fetch-vendor.sh — but it is still pinned, and for the same reason:
# an unpinned `git pull` changes call behaviour on a live phone system with no
# review. Bump AVA_PIN deliberately, in a commit, after reading the changelog.
#
# What it does:
#   1. clone/fetch the AVA repo into vendor/ava and check out $AVA_PIN
#   2. seed the gitignored runtime tree under data/ava/:
#        data/ava/project/config/ai-agent.yaml  <- config/ava/ai-agent.yaml
#        data/ava/project/.env                  <- AVA's own .env.example
#        data/ava/data/                         (agents.db, call history)
#        data/ava/models/                       (local STT/TTS models)
#      This split is deliberate: the tracked template stays canonical and
#      diffable, while AVA's admin UI edits the runtime copy in place.
#   3. stamp the runtime config with the template revision it was seeded
#      from, and report it when the tracked template has moved on since.
#      Nothing here overwrites the runtime copy on its own — AVA's admin UI
#      owns it once calls are being taken — so a template fix (a moved
#      AudioSocket port, a renamed model key, a new transfer tool) would
#      otherwise never reach the engine, silently. The stamp is what makes
#      that visible before a call finds it.
#
# Usage:
#   bash scripts/fetch-ava.sh              # checkout + seed (idempotent)
#   bash scripts/fetch-ava.sh --check      # pin, seeded config, provenance; no network
#   AVA_PIN=<sha> bash scripts/fetch-ava.sh
#
# Notes:
#   * Nothing here writes outside the repo: vendor/ and data/ are gitignored.
#   * Seeding never overwrites an existing runtime config — the admin UI owns
#     it once calls are being taken. --force reseeds it from the template.
# ═════════════════════════════════════════════════════════════════════════════
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AVA_REPO="${AVA_REPO:-https://github.com/innotelinc/AI-Voice-Agent-for-Asterisk.git}"
# v7.6.1 — "Prepare v7.6.1 release" (2026-09-20). Agent-only routing, fails
# closed; AudioSocket + ARI attach verified against Asterisk 22 on this estate.
AVA_PIN="${AVA_PIN:-5d8f8881831a58db4143dd5595647b0ae65dc686}"
AVA_SRC="${AVA_SRC:-${REPO_ROOT}/vendor/ava}"
RUNTIME_DIR="${AVA_RUNTIME_DIR:-${REPO_ROOT}/data/ava}"
TEMPLATE="${REPO_ROOT}/config/ava/ai-agent.yaml"
CFG_REL="data/ava/project/config/ai-agent.yaml"
STAMP_NAME=".template-rev"

MODE="install"
FORCE=0

RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; CYAN=$'\033[0;36m'; YELLOW=$'\033[0;33m'; NC=$'\033[0m'
info() { printf '%s==>%s %s\n' "${CYAN}" "${NC}" "$*"; }
pass() { printf '%s  ✓%s %s\n' "${GREEN}" "${NC}" "$*"; }
warn() { printf '%s  !%s %s\n' "${YELLOW}" "${NC}" "$*"; }
fail() { printf '%s  ✗%s %s\n' "${RED}" "${NC}" "$*" >&2; exit 1; }

# ── provenance: which template revision seeded the runtime config? ──────────
# sha256 of a file, on hosts that spell the tool either way.
sha_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# Is the runtime config known to come from the CURRENT tracked template?
#   0 — yes: stamped at this revision, or its content matches the template
#   1 — no: stamped at an older revision, so the template gained fixes that
#       are not deployed (the case this stamp exists to catch)
#   2 — unknown: no stamp and the content differs — a hand edit that predates
#       the stamp. Reported, never reseeded: the file may hold real edits.
config_provenance() {
  local cfg="${RUNTIME_DIR}/project/config/ai-agent.yaml"
  local stamp="${RUNTIME_DIR}/project/config/${STAMP_NAME}"
  [ -f "$TEMPLATE" ] || fail "tracked template missing: ${TEMPLATE}"
  local tpl_sha; tpl_sha="$(sha_of "$TEMPLATE")"
  if [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$tpl_sha" ]; then return 0; fi
  if [ -f "$cfg" ] && [ "$(sha_of "$cfg")" = "$tpl_sha" ]; then return 0; fi
  if [ -f "$stamp" ]; then return 1; fi
  return 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --check) MODE="check"; shift ;;
    --force) FORCE=1; shift ;;
    -h|--help) awk 'NR>1 && /^set -euo pipefail$/{exit} NR>1{sub(/^# ?/,""); print}' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) fail "unknown argument: $1 (try --help)" ;;
  esac
done

# ── seed the runtime tree ────────────────────────────────────────────────────
seed_runtime() {
  mkdir -p "${RUNTIME_DIR}/project/config" "${RUNTIME_DIR}/data" "${RUNTIME_DIR}/models"

  # The containers run as appuser (uid 1000): the engine writes call history
  # and agents.db under /app/data, and the admin UI writes the config and
  # users.json under /app/project. Trees created by root here make both fail
  # at runtime with "unable to open database file", so hand them over while
  # they are still empty. Existing contents keep their ownership — that is
  # live state.
  if [ "$(id -u)" = "0" ]; then
    chown -R "${AVA_CONTAINER_UID:-1000}:${AVA_CONTAINER_UID:-1000}" \
      "${RUNTIME_DIR}/data" "${RUNTIME_DIR}/models" 2>/dev/null || true
    chown "${AVA_CONTAINER_UID:-1000}:${AVA_CONTAINER_UID:-1000}" \
      "${RUNTIME_DIR}/project" "${RUNTIME_DIR}/project/config" 2>/dev/null || true
  fi

  local cfg="${RUNTIME_DIR}/project/config/ai-agent.yaml"
  local stamp="${RUNTIME_DIR}/project/config/${STAMP_NAME}"
  local tpl_sha; tpl_sha="$(sha_of "$TEMPLATE")"
  if [ ! -f "$cfg" ] || [ "$FORCE" = "1" ]; then
    [ -f "$TEMPLATE" ] || fail "tracked template missing: ${TEMPLATE}"
    cp "$TEMPLATE" "$cfg"
    printf '%s\n' "$tpl_sha" > "$stamp"
    pass "seeded ${CFG_REL} from config/ava/ai-agent.yaml (${tpl_sha:0:12})"
  else
    pass "runtime config already present (left untouched): ${CFG_REL}"
    # Same content as the template (an operator copied it over by hand): adopt
    # the revision, so a later --check stops calling this file unverifiable.
    if [ "$(sha_of "$cfg")" = "$tpl_sha" ]; then
      printf '%s\n' "$tpl_sha" > "$stamp"
      pass "runtime config matches the tracked template — stamp refreshed (${tpl_sha:0:12})"
    fi
  fi

  # AVA's settings.py copies its own .env.example when .env is missing; doing
  # it here keeps the admin UI from writing to the checkout.
  local envf="${RUNTIME_DIR}/project/.env"
  if [ ! -f "$envf" ]; then
    [ -f "${AVA_SRC}/.env.example" ] || fail "AVA checkout has no .env.example — run without --check first"
    cp "${AVA_SRC}/.env.example" "$envf"
    pass "seeded ${envf#"${REPO_ROOT}/"} from AVA's .env.example"
  else
    pass "runtime env already present (left untouched): ${envf#"${REPO_ROOT}/"}"
  fi

  # The FILES, not just the directories above. Handing over the directory is
  # not enough: the admin UI rewrites this config and this .env in place as
  # uid 1000 (api/config.py — agent edits, key updates), and a root-owned 0644
  # file inside a writable directory still fails that write with EACCES, which
  # reaches the operator as "could not save" on a screen that otherwise works.
  # Idempotent: a file the admin UI created is already 1000:1000.
  if [ "$(id -u)" = "0" ]; then
    local f
    for f in "$cfg" "$stamp" "$envf"; do
      if [ -e "$f" ]; then
        chown "${AVA_CONTAINER_UID:-1000}:${AVA_CONTAINER_UID:-1000}" "$f" 2>/dev/null || true
      fi
    done
  fi
}

# ── check mode: no network, no writes ───────────────────────────────────────
if [ "$MODE" = "check" ]; then
  [ -d "${AVA_SRC}/.git" ] || fail "AVA checkout missing: ${AVA_SRC} (run without --check)"
  head="$(git -C "$AVA_SRC" rev-parse HEAD 2>/dev/null || true)"
  [ "$head" = "$AVA_PIN" ] || fail "AVA checkout is at ${head:-unknown}, expected ${AVA_PIN}"
  pass "AVA pinned at ${AVA_PIN:0:12}"
  [ -f "${RUNTIME_DIR}/project/config/ai-agent.yaml" ] \
    || fail "runtime config missing: ${CFG_REL}"
  pass "runtime config present"

  # The runtime config is never overwritten on its own, so this is the only
  # place a template fix that never reached the engine can be seen. Stale
  # provenance is a hard failure in check mode (the deploy is not what the
  # repo says); unverifiable provenance is a warning, because the file may
  # legitimately hold admin edits that --force would destroy.
  drift=0
  config_provenance || drift=$?
  case "$drift" in
    0) pass "runtime config comes from the current template" ;;
    2) warn "runtime config carries no stamp and differs from config/ava/ai-agent.yaml, so a stale"
       warn "seed cannot be told apart from a deliberate edit (provenance unverifiable):"
       warn "  diff ${TEMPLATE} ${RUNTIME_DIR}/project/config/ai-agent.yaml"
       warn "  bash scripts/fetch-ava.sh --force   # only if the template's fixes are missing" ;;
    *) fail "runtime config was seeded from an older config/ava/ai-agent.yaml — the template has changed since, and the runtime copy is never overwritten. Review: diff ${TEMPLATE} ${RUNTIME_DIR}/project/config/ai-agent.yaml ; then: bash scripts/fetch-ava.sh --force" ;;
  esac
  exit 0
fi

# ── checkout ────────────────────────────────────────────────────────────────
command -v git >/dev/null 2>&1 || fail "git is required"

if [ ! -d "${AVA_SRC}/.git" ]; then
  info "cloning AVA into vendor/ava"
  mkdir -p "$(dirname "$AVA_SRC")"
  git clone --quiet "$AVA_REPO" "$AVA_SRC"
else
  info "fetching AVA"
  git -C "$AVA_SRC" fetch --quiet origin
fi

if ! git -C "$AVA_SRC" cat-file -e "${AVA_PIN}^{commit}" 2>/dev/null; then
  git -C "$AVA_SRC" fetch --quiet origin "$AVA_PIN" 2>/dev/null \
    || fail "commit ${AVA_PIN} not found in ${AVA_REPO}"
fi

git -C "$AVA_SRC" checkout --quiet "$AVA_PIN"
pass "AVA checked out at ${AVA_PIN:0:12}"

seed_runtime

# A template that gained a fix since this file was seeded leaves the deployed
# config untouched by design. Say so here, where the deployment is prepared,
# rather than leaving a caller to discover it.
drift=0
config_provenance || drift=$?
case "$drift" in
  0) : ;;
  1) warn "the tracked config/ava/ai-agent.yaml has changed since ${CFG_REL} was seeded."
     warn "the runtime copy was left alone (AVA's admin UI owns it). To apply the template:"
     warn "  diff ${TEMPLATE} ${RUNTIME_DIR}/project/config/ai-agent.yaml"
     warn "  bash scripts/fetch-ava.sh --force   # discards admin edits — diff first" ;;
  2) warn "${CFG_REL} differs from the tracked template and carries no stamp, so a stale seed"
     warn "cannot be told apart from a deliberate edit (provenance unverifiable). diff them:"
     warn "  diff ${TEMPLATE} ${RUNTIME_DIR}/project/config/ai-agent.yaml"
     warn "  bash scripts/fetch-ava.sh --force   # only if the template's fixes are missing" ;;
esac

# The voice profile will not run without these, and each one fails in a way
# that is hard to read from the logs: a blank JWT secret silently accepts
# AVA's published dev default (anyone could mint an admin session), and a
# blank ARI secret leaves the engine unable to attach to Asterisk at all.
# Checked here because this script is on the required path for the profile.
if [ -f "${REPO_ROOT}/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "${REPO_ROOT}/.env"
  set +a
fi
if [ -z "${AVA_ADMIN_JWT_SECRET:-}" ]; then
  fail "AVA_ADMIN_JWT_SECRET is not set in .env (openssl rand -hex 32) — AVA's admin would otherwise fall back to a published dev secret"
fi
if [ -z "${AVA_ARI_SECRET:-}" ]; then
  fail "AVA_ARI_SECRET is not set in .env (openssl rand -hex 16) — the engine could not authenticate to Asterisk"
fi
# Blank here is not a smaller configuration, it is a broken one that looks
# healthy: AVA deletes an inline api_key from its YAML (src/config/security.py,
# inject_provider_api_keys) and takes the gateway credential from the
# environment, so with this unset the engine keeps a placeholder adapter —
# calls connect, the agent never answers, and the log says only "requires an
# API key".
if [ -z "${OMNIROUTE_API_KEY:-}" ]; then
  fail "OMNIROUTE_API_KEY is not set in .env — without it AVA falls back to a placeholder LLM adapter and the agent cannot answer (see docker-compose.yml, ai-engine)"
fi
pass "AVA credentials present in .env"

info "next: docker compose --profile voice up -d"
info "      then open the Zeus portal → Voice (the portal proxies AVA's API)"
