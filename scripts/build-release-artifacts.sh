#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# build-release-artifacts.sh — Zeus release artifact builder.
#
# Produces, under dist/:
#   source-bundle/zeus-source-bundle.tar.gz   (+ .sha256) — full source tree
#   deployment/zeus-deployment.tar.gz         (+ .sha256) — everything needed
#                                              to deploy from a fresh host
#                                              (compose files, Dockerfiles,
#                                              entrypoints, env template,
#                                              NPM automation, migrations, README)
#   deployment/SHA256SUMS
#
# Consumed by .github/workflows/release.yml and attachable to every v* release.
# ═══════════════════════════════════════════════════════════════
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

VERSION="${1:-$(git describe --tags --abbrev=0 2>/dev/null || echo dev)}"
DIST="$REPO_ROOT/dist"
SRC_DIR="$DIST/source-bundle"
DEPLOY_DIR="$DIST/deployment"
mkdir -p "$SRC_DIR" "$DEPLOY_DIR"

# ── 1. Source bundle (everything git tracks, tagged with the version) ──
# git archive only includes committed files — build artifacts, node_modules,
# data/ and .env are excluded by gitignore automatically.
echo ">>> Building source bundle (${VERSION})..."
git archive --format=tar.gz \
  --prefix="zeus-voip-platform-${VERSION}/" \
  -o "$SRC_DIR/zeus-source-bundle.tar.gz" \
  HEAD
sha256sum "$SRC_DIR/zeus-source-bundle.tar.gz" \
  > "$SRC_DIR/zeus-source-bundle.tar.gz.sha256"

# ── 2. Deployment payload ─────────────────────────────────────
# A focused bundle for provisioning a fresh host + reverse proxy: compose
# files, Dockerfiles, entrypoints, env template, the NPM automation, the
# bare-metal installers, schema/migrations, and docs.
echo ">>> Building deployment payload..."
DEPLOY_FILES=(
  docker-compose.yml
  docker-compose.full.yml
  docker-compose.full.build.yml
  docker-compose.platform.yml
  Dockerfile
  Dockerfile.full
  docker-entrypoint.sh
  docker-entrypoint-full.sh
  systemctl-shim.sh
  .dockerignore
  .env.docker.example
  README.md
  scripts/setup.sh
  scripts/setup-portal.sh
  scripts/npm-proxy-hosts.py
  scripts/pbx.env.example
  scripts/stage-fax-sources.sh
  scripts/schema.sql
  scripts/seed.mjs
  scripts/migrations
)

rm -rf "$DEPLOY_DIR/zeus-voip-platform"
mkdir -p "$DEPLOY_DIR/zeus-voip-platform"
for f in "${DEPLOY_FILES[@]}"; do
  if [ -e "$f" ]; then
    mkdir -p "$DEPLOY_DIR/zeus-voip-platform/$(dirname "$f")"
    cp -r "$f" "$DEPLOY_DIR/zeus-voip-platform/$f"
  else
    echo "WARN missing deployment file: $f" >&2
  fi
done

tar -czf "$DEPLOY_DIR/zeus-deployment.tar.gz" \
  -C "$DEPLOY_DIR" \
  zeus-voip-platform
rm -rf "$DEPLOY_DIR/zeus-voip-platform"

# ── 3. Checksums for the whole release ────────────────────────
(
  cd "$DEPLOY_DIR"
  sha256sum zeus-deployment.tar.gz > SHA256SUMS
  cd "$SRC_DIR"
  sha256sum zeus-source-bundle.tar.gz >> "$DEPLOY_DIR/SHA256SUMS"
)

echo ""
echo "Artifacts ready:"
echo "  $(du -h "$SRC_DIR/zeus-source-bundle.tar.gz" | cut -f1)  $SRC_DIR/zeus-source-bundle.tar.gz"
echo "  $(du -h "$DEPLOY_DIR/zeus-deployment.tar.gz" | cut -f1)  $DEPLOY_DIR/zeus-deployment.tar.gz"
echo "  $DEPLOY_DIR/SHA256SUMS"