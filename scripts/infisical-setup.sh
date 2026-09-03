#!/usr/bin/env bash
# Infisical (SecretOps) — start the opt-in profile and provision secrets.
# Set INFISICAL_ADMIN_EMAIL / INFISICAL_ADMIN_PASSWORD (and the INFISICAL_*
# keys) in .env first. Safe to re-run — idempotent.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
if [ -f .env ]; then
  set -a
  # shellcheck source=/dev/null
  . ./.env
  set +a
fi
COMPOSE_FILES="${COMPOSE_FILES:-docker-compose.yml compose.infisical.yml}"
# shellcheck disable=SC2086
docker compose -f ${COMPOSE_FILES} --profile infisical up -d
python3 scripts/infisical-setup.py
