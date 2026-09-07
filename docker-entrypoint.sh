#!/bin/sh
# ═══════════════════════════════════════════════════════════════
# Zeus — VOIP Platform Portal — Docker Entrypoint
# Auto-seeds the database on first container start.
# Runs as root to repair volume ownership, then drops privileges
# to the nextjs app user before seeding / starting the server.
# ═══════════════════════════════════════════════════════════════
set -e

DB_PATH="/app/data/pbx.db"

# Self-heal volume ownership: a persistent data volume created by an
# older image (or by tooling running as root) leaves /app/data owned by
# root, so the seed aborts with "unable to open database file" and the
# container crash-loops (restart: unless-stopped). Re-own the directory
# here so the nextjs app user can create/update the SQLite database.
if ! chown -R nextjs:nodejs /app/data 2>/dev/null; then
  echo "!!! WARNING: could not chown /app/data — the app may fail to write the database" >&2
fi

if [ ! -f "$DB_PATH" ]; then
  echo ">>> First run detected — seeding database..."
  su-exec nextjs:nodejs node scripts/seed.mjs
  echo ">>> Database ready. Demo login: demo@zeus.innotel.us / 8dpWR8wl4eYncm5v"
else
  echo ">>> Database exists — skipping seed."
fi

# ── SecretOps (Infisical) — boot-time reference resolution ──────────────
# .env values may be `infisical://<name>` references (same runtime contract
# as Cerulean/Onyx/zapit, docs/stack.md). Resolve them BEFORE boot so every
# Next.js consumer reads the plain value from process.env. Plain values are
# left untouched; a configured reference that cannot be resolved aborts the
# container instead of booting with a literal `infisical://` value.
#
# INFISICAL_* env (written by scripts/infisical-setup.py):
#   INFISICAL_ADDR / INFISICAL_TOKEN / INFISICAL_WORKSPACE_ID /
#   INFISICAL_ENVIRONMENT (default prod)
INFISICAL_KEYS="\
  SESSION_SECRET VOIPMS_SIP_PASS VOIPMS_API_PASSWORD VOIPMS_IAX_PASS \
  VOIPMS_WEBHOOK_SECRET FREEPBX_AMI_SECRET ASTERISK_AMI_SECRET \
  AVANTFAX_WEBHOOK_SECRET STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET \
  TURN_CREDENTIAL"
if [ -n "${INFISICAL_ADDR:-}" ] && [ -n "${INFISICAL_TOKEN:-}" ] && [ -n "${INFISICAL_WORKSPACE_ID:-}" ]; then
  echo ">>> Resolving Infisical secret references at boot..."
  # shellcheck disable=SC2086  # INFISICAL_KEYS is a space-separated key list for word splitting
  eval "$(node /app/scripts/infisical-env.mjs $INFISICAL_KEYS)"
fi

# Ensure a consistent SESSION_SECRET across all Next.js worker threads.
# Without this, each worker independently generates its own secret (because
# module-level variables aren't shared across workers), causing session tokens
# signed by one worker to be rejected by another.
#
# 1. Respect explicit SESSION_SECRET env var (set in .env or compose)
# 2. Fall back to persisted file (survives container restarts)
# 3. Auto-generate and persist if neither exists
SECRET_FILE="/app/data/.session-secret"
if [ -z "${SESSION_SECRET:-}" ]; then
  if [ -f "$SECRET_FILE" ] && [ -s "$SECRET_FILE" ]; then
    SESSION_SECRET=$(cat "$SECRET_FILE")
    echo ">>> Loaded session secret from $SECRET_FILE"
  else
    SESSION_SECRET=$(openssl rand -base64 32)
    printf '%s\n' "$SESSION_SECRET" > "$SECRET_FILE"
    chown nextjs:nodejs "$SECRET_FILE" 2>/dev/null || true
    echo ">>> Generated new session secret at $SECRET_FILE"
  fi
fi
export SESSION_SECRET

# Next's standalone server binds to $HOSTNAME — Docker injects the container
# id, and .env/compose may set the public IP (not a local interface), which
# makes listen() fail with EADDRNOTAVAIL. Pin it to 0.0.0.0 so the server
# listens on all local interfaces regardless of the inherited value.
exec su-exec nextjs:nodejs env HOSTNAME=0.0.0.0 SESSION_SECRET="$SESSION_SECRET" "$@"
