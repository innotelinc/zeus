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

# ── SecretOps (Cerulean Vault) — boot-time reference resolution ─────────
# .env values may be `vault://<mount>/<path>#<key>` references (the same
# grammar Cerulean/Onyx/Atlas/Distro resolve, docs/stack.md). Resolve them
# BEFORE boot so every Next.js consumer reads the plain value from process.env.
# Plain values are left untouched; a reference that cannot be resolved aborts
# the container instead of booting with a literal `vault://` value.
#
# VAULT_* env (see .env.example):
#   VAULT_ADDR / VAULT_TOKEN (or VAULT_TOKEN_FILE) / VAULT_PREFIX /
#   VAULT_NAMESPACE / VAULT_SKIP_VERIFY / VAULT_CACERT
VAULT_KEYS="\
  SESSION_SECRET VOIPMS_SIP_PASS VOIPMS_API_USERNAME VOIPMS_API_PASSWORD VOIPMS_IAX_PASS \
  VOIPMS_WEBHOOK_SECRET FREEPBX_AMI_SECRET ASTERISK_AMI_SECRET \
  AVANTFAX_WEBHOOK_SECRET STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET \
  TURN_CREDENTIAL"
# Always run the resolver: with no references it is a silent no-op, and the
# status is checked explicitly so an unresolvable reference fails the container
# rather than being masked by `eval` exiting 0 on an empty substitution.
# shellcheck disable=SC2086  # VAULT_KEYS is a space-separated key list for word splitting
VAULT_EXPORTS="$(node /app/scripts/vault-env.mjs $VAULT_KEYS)" || exit 1
if [ -n "$VAULT_EXPORTS" ]; then
  eval "$VAULT_EXPORTS"
fi

# ── AMI password: adopt the one Asterisk actually authenticates against ──
# This container's AMI secret can arrive three ways — env_file (.env), the
# compose interpolation of the *host shell's* FREEPBX_AMI_SECRET, and Cerulean
# Vault above — while Asterisk checks the [FREEPBX_AMI_USER] section of
# manager_custom.conf, which the PBX writes from ITS environment. A stale
# exported value therefore produced two different passwords for one account:
# Asterisk logged "failed to authenticate as 'zeus-portal'" every 30s and the
# dashboard showed "AMI Offline" while every secret in .env looked correct.
# The shared config volume is mounted here, so the file wins — that is the
# credential that actually gets checked.
AMI_CONF=/etc/asterisk/manager_custom.conf
AMI_USER_NAME="${ASTERISK_AMI_USERNAME:-${FREEPBX_AMI_USER:-zeus-portal}}"
if [ -f "$AMI_CONF" ]; then
  AMI_FILE_SECRET=$(awk -v u="$AMI_USER_NAME" '
    $0 ~ "^\\[" u "\\]$" { inside=1; next }
    /^\[/ { inside=0 }
    inside && /^[[:space:]]*secret[[:space:]]*=/ {
      sub(/^[^=]*=[[:space:]]*/, ""); print; exit
    }' "$AMI_CONF")
  if [ -n "$AMI_FILE_SECRET" ] && [ "$AMI_FILE_SECRET" != "${ASTERISK_AMI_SECRET:-}" ]; then
    echo ">>> AMI: using the '$AMI_USER_NAME' password from $(basename "$AMI_CONF") — the environment had a different one"
    ASTERISK_AMI_SECRET="$AMI_FILE_SECRET"
    export ASTERISK_AMI_SECRET
  fi
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
