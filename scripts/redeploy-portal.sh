#!/usr/bin/env bash
# redeploy-portal.sh — rebuild + restart the Zeus portal when its source changed.
#
# Why this exists: the portal is a Next.js app that is built *in place* and run
# by zeus-portal.service (scripts/setup-portal.sh: `npm run build`, then
# `systemctl start zeus-portal`). Editing src/ therefore does nothing to the
# running server until it is rebuilt and restarted — the reason a fix that
# "landed" in the repo keeps answering from the old build. That gap is how a
# sign-in fix (the `vault://` reference resolved at boot) can be committed while
# the live portal still rejects the token exchange.
#
# It is cheap when nothing changed: a content hash of the portal sources is
# compared with the stamp written by the last successful build, and npm/systemd
# are not touched when they match.
#
# Usage:
#   scripts/redeploy-portal.sh                # rebuild + restart only when source changed
#   scripts/redeploy-portal.sh --force        # always rebuild + restart
#   scripts/redeploy-portal.sh --check        # report drift, exit 1, build nothing
#   scripts/redeploy-portal.sh --dry-run      # print the commands, run nothing
#   scripts/redeploy-portal.sh --baseline F   # compare against baseline file F
#   scripts/redeploy-portal.sh --write-baseline --baseline F
#
# Layout: the portal may run from this checkout or from an installed copy
# (/opt/zeus-voip, the setup-portal.sh default). Point the script at the dir
# that is actually built/run with ZEUS_PORTAL_APP_DIR; it defaults to this repo.
# The stamp defaults to <repo>/data/.portal-redeploy.stamp (override with
# ZEUS_PORTAL_STAMP).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="${ZEUS_PORTAL_APP_DIR:-$ROOT}"
STAMP="${ZEUS_PORTAL_STAMP:-$ROOT/data/.portal-redeploy.stamp}"
# Optional committed baseline. When set, --check compares against it instead of
# the build stamp — the way CI can assert "the portal sources match the last
# reviewed baseline" without a build on the runner. A missing stamp AND missing
# baseline is not drift: --check reports it and passes.
BASELINE="${ZEUS_PORTAL_BASELINE:-}"

FORCE=0; CHECK=0; DRY_RUN=0; WRITE_BASELINE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --force)          FORCE=1 ;;
    --check)          CHECK=1 ;;
    --dry-run)        DRY_RUN=1 ;;
    --baseline)       BASELINE="${2:-}"; shift; [ -n "$BASELINE" ] || { printf 'redeploy-portal: --baseline needs a path\n' >&2; exit 2; } ;;
    --write-baseline) WRITE_BASELINE=1 ;;
    -h|--help)        sed -n '1,40p' "$0"; exit 0 ;;
    *) printf 'redeploy-portal: unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
  shift
done

log() { printf 'redeploy-portal: %s\n' "$*"; }

# Every file whose contents define the portal build.
source_file_list() {
  find "$APP_DIR/src" -type f 2>/dev/null
  find "$APP_DIR/public" -type f 2>/dev/null
  local f
  for f in \
    "$APP_DIR/package.json" \
    "$APP_DIR/package-lock.json" \
    "$APP_DIR/next.config.ts" \
    "$APP_DIR/next.config.js" \
    "$APP_DIR/next.config.mjs" \
    "$APP_DIR/tsconfig.json" \
    "$APP_DIR/postcss.config.mjs" \
    "$APP_DIR/postcss.config.js" \
    "$APP_DIR/tailwind.config.js" \
    "$APP_DIR/tailwind.config.ts" \
    "$APP_DIR/eslint.config.mjs" \
    "$APP_DIR/Dockerfile" \
    "$APP_DIR/docker-entrypoint.sh" \
    "$APP_DIR/docker-entrypoint-full.sh"; do
    [ -f "$f" ] && printf '%s\n' "$f"
  done
}

# sha256sum of (file name + contents) for every source, so a rename or a
# delete changes the hash too.
hash_sources() {
  while IFS= read -r f; do
    sha256sum "$f"
  done < <(source_file_list | LC_ALL=C sort) | sha256sum | awk '{print $1}'
}

current_hash="$(hash_sources)"

if [ "$WRITE_BASELINE" = "1" ]; then
  [ -n "$BASELINE" ] || { log "--write-baseline needs --baseline FILE"; exit 2; }
  mkdir -p "$(dirname "$BASELINE")"
  printf '%s\n' "$current_hash" > "$BASELINE"
  log "baseline updated (${current_hash:0:12})"
  exit 0
fi

# Prefer an explicit baseline (CI); otherwise the host's build stamp. Neither
# present is not drift — see the header.
compare_file=""
[ -n "$BASELINE" ] && [ -s "$BASELINE" ] && compare_file="$BASELINE"
[ -z "$compare_file" ] && [ -s "$STAMP" ] && compare_file="$STAMP"
prev_hash=""
[ -n "$compare_file" ] && prev_hash="$(tr -d '[:space:]' < "$compare_file")"

if [ -z "$compare_file" ]; then
  if [ "$CHECK" = "1" ]; then
    log "no build stamp/baseline on this runner — nothing to compare (${current_hash:0:12})"
    exit 0
  fi
fi

if [ "$FORCE" = "0" ] && [ -n "$prev_hash" ] && [ "$current_hash" = "$prev_hash" ]; then
  log "portal sources unchanged (${current_hash:0:12}) — nothing to deploy"
  exit 0
fi

if [ "$CHECK" = "1" ]; then
  log "portal sources changed: ${prev_hash:0:12} → ${current_hash:0:12} — build needed"
  exit 1
fi

cd "$APP_DIR"

run() {
  if [ "$DRY_RUN" = "1" ]; then
    log "would run: $*"
  else
    "$@"
  fi
}

log "rebuilding portal (${prev_hash:0:12} → ${current_hash:0:12})"

# A fresh checkout has no node_modules; an installed one already does. Only pay
# for `npm ci` when the tree is missing — the build below is the expensive step.
# Full install (not --production): the build needs the devDeps (typescript,
# tailwind) and the patch-package postinstall, and the portal image installs the
# same way.
if [ ! -d "$APP_DIR/node_modules" ]; then
  run npm ci
fi
run npm run build

# Restart the unit that serves the build. A host without systemd (or without the
# unit installed) is told how to finish rather than failed — the build already
# happened, and a guard should not be the thing that breaks a dev box.
if [ "$DRY_RUN" = "1" ]; then
  log "would run: systemctl restart zeus-portal"
elif command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files zeus-portal.service >/dev/null 2>&1; then
  systemctl restart zeus-portal
  log "restarted zeus-portal"
else
  log "no zeus-portal.service here — restart the server yourself to serve the new build"
fi

if [ "$DRY_RUN" != "1" ]; then
  mkdir -p "$(dirname "$STAMP")"
  printf '%s\n' "$current_hash" > "$STAMP"
  log "deployed ${current_hash:0:12}"
fi
