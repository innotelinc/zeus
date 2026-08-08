#!/bin/sh
# ═══════════════════════════════════════════════════════════════
# Innotel PBX Portal — Docker Entrypoint
# Auto-seeds the database on first container start.
# ═══════════════════════════════════════════════════════════════
set -e

DB_PATH="/app/data/pbx.db"

if [ ! -f "$DB_PATH" ]; then
  echo ">>> First run detected — seeding database..."
  cd /app && node scripts/seed.mjs
  echo ">>> Database ready. Demo login: demo@innotel.us / 8dpWR8wl4eYncm5v"
else
  echo ">>> Database exists — skipping seed."
fi

exec "$@"
