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
#
# Usage:
#   bash scripts/fetch-ava.sh              # checkout + seed (idempotent)
#   bash scripts/fetch-ava.sh --check      # verify pin + seeded config, no network
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

MODE="install"
FORCE=0

RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; CYAN=$'\033[0;36m'; NC=$'\033[0m'
info() { printf '%s==>%s %s\n' "${CYAN}" "${NC}" "$*"; }
pass() { printf '%s  ✓%s %s\n' "${GREEN}" "${NC}" "$*"; }
fail() { printf '%s  ✗%s %s\n' "${RED}" "${NC}" "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --check) MODE="check"; shift ;;
    --force) FORCE=1; shift ;;
    -h|--help) sed -n '2,34p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) fail "unknown argument: $1 (try --help)" ;;
  esac
done

# ── seed the runtime tree ────────────────────────────────────────────────────
seed_runtime() {
  mkdir -p "${RUNTIME_DIR}/project/config" "${RUNTIME_DIR}/data" "${RUNTIME_DIR}/models"

  local cfg="${RUNTIME_DIR}/project/config/ai-agent.yaml"
  if [ ! -f "$cfg" ] || [ "$FORCE" = "1" ]; then
    [ -f "$TEMPLATE" ] || fail "tracked template missing: ${TEMPLATE}"
    cp "$TEMPLATE" "$cfg"
    pass "seeded ${cfg#"${REPO_ROOT}/"} from config/ava/ai-agent.yaml"
  else
    pass "runtime config already present (left untouched): ${cfg#"${REPO_ROOT}/"}"
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
}

# ── check mode: no network, no writes ───────────────────────────────────────
if [ "$MODE" = "check" ]; then
  [ -d "${AVA_SRC}/.git" ] || fail "AVA checkout missing: ${AVA_SRC} (run without --check)"
  head="$(git -C "$AVA_SRC" rev-parse HEAD 2>/dev/null || true)"
  [ "$head" = "$AVA_PIN" ] || fail "AVA checkout is at ${head:-unknown}, expected ${AVA_PIN}"
  pass "AVA pinned at ${AVA_PIN:0:12}"
  [ -f "${RUNTIME_DIR}/project/config/ai-agent.yaml" ] \
    || fail "runtime config missing: data/ava/project/config/ai-agent.yaml"
  pass "runtime config present"
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
pass "AVA credentials present in .env"

info "next: docker compose --profile voice up -d"
info "      then open the Zeus portal → Voice (the portal proxies AVA's API)"
