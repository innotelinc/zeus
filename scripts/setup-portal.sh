#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  Zeus — VOIP Platform Customer Portal Installer (separate from setup.sh)
# ═══════════════════════════════════════════════════════════════
#  Deploys the Next.js Zeus Customer Portal (port 3000) against an
#  EXISTING FreePBX / Asterisk server. The FreePBX server is provisioned
#  by scripts/setup.sh, which prints the portal-facing credentials
#  (FREEPBX_AMI_USER/SECRET, FREEPBX_CLIENT_ID/CLIENT_SECRET) at the end.
#
#  Run as root on the FreePBX server (or a host that can reach it):
#      bash scripts/setup-portal.sh
#
#  Required env vars (point at the FreePBX server from setup.sh):
#      HOSTNAME                  # e.g. pbx.zeus.innotel.us
#      FREEPBX_AMI_USER          # default pbxportal
#      FREEPBX_AMI_SECRET        # from setup.sh output
#      FREEPBX_CLIENT_ID         # from setup.sh output
#      FREEPBX_CLIENT_SECRET     # from setup.sh output
#
#  Optional env vars:
#      VOIPMS_USER / VOIPMS_PASS          # VoIP.ms API credentials
#      VOIPMS_SIP_SERVER                  # default newyork1.voip.ms
#      ATLAS_URL / ATLAS_API_KEY          # Atlas cross-system sync
#      STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET / STRIPE_PUBLISHABLE_KEY
#      TURN_SERVER / TURN_USERNAME / TURN_CREDENTIAL   # WebRTC NAT
#      APP_DIR                            # default /opt/zeus-voip
# ═══════════════════════════════════════════════════════════════

set -euo pipefail

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'
log()  { echo -e "${GREEN}[✓]${NC} $*"; }
warn() { echo -e "${YELLOW}[!]${NC} $*"; }
err()  { echo -e "${RED}[✗]${NC} $*"; }
info() { echo -e "${CYAN}[i]${NC} $*"; }

# ─── SECRETS (.env) ──────────────────────────────────────────
# All secrets live in an .env file (see scripts/pbx.env.example) — the
# same file scripts/setup.sh sources, so the portal picks up the exact
# credentials the FreePBX server was provisioned with.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PBX_ENV_FILE="${PBX_ENV_FILE:-${SCRIPT_DIR}/pbx.env}"
if [ -f "$PBX_ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$PBX_ENV_FILE"
  set +a
  info "Loaded secrets from ${PBX_ENV_FILE}"
else
  warn "No secrets file at ${PBX_ENV_FILE}"
  warn "Copy scripts/pbx.env.example to pbx.env and fill in the values."
fi

# ─── VARIABLES ────────────────────────────────────────────────
HOSTNAME="${HOSTNAME:-pbx.zeus.innotel.us}"
FREEPBX_AMI_USER="${FREEPBX_AMI_USER:-pbxportal}"
FREEPBX_AMI_SECRET="${FREEPBX_AMI_SECRET:-}"
FREEPBX_CLIENT_ID="${FREEPBX_CLIENT_ID:-pbxportal-api}"
FREEPBX_CLIENT_SECRET="${FREEPBX_CLIENT_SECRET:-}"
SESSION_SECRET="${SESSION_SECRET:-}"

VOIPMS_USER="${VOIPMS_USER:-}"
VOIPMS_PASS="${VOIPMS_PASS:-}"
VOIPMS_SIP_SERVER="${VOIPMS_SIP_SERVER:-newyork1.voip.ms}"
ATLAS_URL="${ATLAS_URL:-http://atlas-server:3000}"
ATLAS_API_KEY="${ATLAS_API_KEY:-}"
STRIPE_SECRET_KEY="${STRIPE_SECRET_KEY:-}"
STRIPE_WEBHOOK_SECRET="${STRIPE_WEBHOOK_SECRET:-}"
STRIPE_PUBLISHABLE_KEY="${STRIPE_PUBLISHABLE_KEY:-}"
TURN_SERVER="${TURN_SERVER:-}"
TURN_USERNAME="${TURN_USERNAME:-}"
TURN_CREDENTIAL="${TURN_CREDENTIAL:-}"
APP_DIR="${APP_DIR:-/opt/zeus-voip}"

# The AMI + OAuth2 secrets MUST match what scripts/setup.sh configured on the
# FreePBX server. If they were left blank here, the portal can't authenticate
# against FreePBX — fail loudly instead of silently generating mismatched ones.
if [ -z "${FREEPBX_AMI_SECRET}" ]; then
  err "FREEPBX_AMI_SECRET not set — copy it from setup.sh output into ${PBX_ENV_FILE}"
  exit 1
fi
if [ -z "${FREEPBX_CLIENT_SECRET}" ]; then
  err "FREEPBX_CLIENT_SECRET not set — copy it from setup.sh output into ${PBX_ENV_FILE}"
  exit 1
fi

# Generate portal-only secrets if left blank (they don't need to match a
# server), but warn so they get pinned in pbx.env for re-runs.
if [ -z "${SESSION_SECRET}" ] || [ "${SESSION_SECRET}" = "CHANGE_ME" ]; then
  SESSION_SECRET="$(openssl rand -hex 32)"
  warn "SESSION_SECRET not set in ${PBX_ENV_FILE} — generated a random one"
fi
if [ -z "${ATLAS_API_KEY}" ] || [ "${ATLAS_API_KEY}" = "CHANGE_ME" ]; then
  ATLAS_API_KEY="$(openssl rand -hex 32)"
  warn "ATLAS_API_KEY not set in ${PBX_ENV_FILE} — generated a random one"
fi

# ═══════════════════════════════════════════════════════════════
# PHASE 1 — NODE.JS & SOURCE
# ═══════════════════════════════════════════════════════════════

echo ">>> [1/4] Node.js + portal source"

# Ensure Node.js 20 (the portal build requires 18+)
if ! command -v node &>/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt -y install nodejs
fi

mkdir -p "$APP_DIR"

# Try to copy from local source, else clone
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
if [ -f "$REPO_DIR/package.json" ]; then
  info "Copying portal from $REPO_DIR..."
  rsync -a --exclude='node_modules' --exclude='.git' --exclude='data' --exclude='.next' "$REPO_DIR/" "$APP_DIR/"
else
  info "Cloning portal from GitHub..."
  git clone https://github.com/innotelinc/zeus.git "$APP_DIR"
fi

cd "$APP_DIR"
npm ci --production 2>&1 | tail -5

# ═══════════════════════════════════════════════════════════════
# PHASE 2 — ENVIRONMENT
# ═══════════════════════════════════════════════════════════════

echo ">>> [2/4] Generate .env"

cat > "${APP_DIR}/.env" <<EOF
# Bind to all interfaces so the server doesn't fail with
# EADDRNOTAVAIL when HOSTNAME is set to a public IP
HOSTNAME=0.0.0.0
# ── Generated by Zeus VOIP Platform setup ──
# Server: ${HOSTNAME}  |  Date: $(date -u +"%Y-%m-%dT%H:%M:%SZ")

SESSION_SECRET=${SESSION_SECRET}
VOIPMS_API_USERNAME=${VOIPMS_USER}
VOIPMS_API_PASSWORD=${VOIPMS_PASS}
FREEPBX_URL=https://${HOSTNAME}
FREEPBX_CLIENT_ID=${FREEPBX_CLIENT_ID}
FREEPBX_CLIENT_SECRET=${FREEPBX_CLIENT_SECRET}
NEXT_PUBLIC_FREEPBX_WSS_URL=wss://${HOSTNAME}:8089/ws
NEXT_PUBLIC_TURN_SERVER=${TURN_SERVER}
NEXT_PUBLIC_TURN_USERNAME=${TURN_USERNAME}
NEXT_PUBLIC_TURN_CREDENTIAL=${TURN_CREDENTIAL}
ASTERISK_AMI_HOST=127.0.0.1
ASTERISK_AMI_PORT=5038
ASTERISK_AMI_USERNAME=${FREEPBX_AMI_USER}
ASTERISK_AMI_SECRET=${FREEPBX_AMI_SECRET}
AVANTFAX_URL=http://${HOSTNAME}:8080/fax
NEXT_PUBLIC_AVANTFAX_URL=http://${HOSTNAME}:8080/fax
ATLAS_API_URL=${ATLAS_URL}
ATLAS_API_KEY=${ATLAS_API_KEY}
STRIPE_SECRET_KEY=${STRIPE_SECRET_KEY}
STRIPE_WEBHOOK_SECRET=${STRIPE_WEBHOOK_SECRET}
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=${STRIPE_PUBLISHABLE_KEY}
NEXT_PUBLIC_URL=https://${HOSTNAME}:3000
NODE_ENV=production
EOF

# ═══════════════════════════════════════════════════════════════
# PHASE 3 — BUILD & SEED
# ═══════════════════════════════════════════════════════════════

echo ">>> [3/4] Build & seed"
npm run build 2>&1 | tail -10
npm run seed 2>&1 || true

# ═══════════════════════════════════════════════════════════════
# PHASE 4 — SYSTEMD SERVICE & FIREWALL
# ═══════════════════════════════════════════════════════════════

echo ">>> [4/4] Systemd service + firewall"

cat > /etc/systemd/system/zeus-portal.service <<EOF
[Unit]
Description=Zeus VOIP Platform Customer Portal
After=network.target mariadb.service freepbx.service
[Service]
Type=simple
User=root
WorkingDirectory=${APP_DIR}
Environment=NODE_ENV=production
Environment=PORT=3000
ExecStart=/usr/bin/node ${APP_DIR}/node_modules/.bin/next start -H 0.0.0.0 -p 3000
Environment=HOSTNAME=0.0.0.0
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=zeus-portal
[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable zeus-portal
systemctl start  zeus-portal

# ─── Firewall ────────────────────────────────────────────────
if command -v ufw &>/dev/null; then
  ufw allow 3000/tcp comment "Zeus Portal"
  ufw --force enable 2>/dev/null || true
elif command -v iptables &>/dev/null; then
  iptables -I INPUT -p tcp --dport 3000 -j ACCEPT
fi

log "Zeus Portal installed at ${APP_DIR}"

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  ZEUS VOIP PORTAL — INSTALLATION COMPLETE              ║"
echo "╠══════════════════════════════════════════════════════════╣"
echo "║  PBX Portal   : https://${HOSTNAME}:3000                  ║"
echo "║  Demo login   : demo@zeus.innotel.us / 8dpWR8wl4eYncm5v   ║"
echo "║  FreePBX      : https://${HOSTNAME}/admin                 ║"
echo "╠══════════════════════════════════════════════════════════╣"
echo "║  Portal logs  : journalctl -u zeus-portal -f             ║"
echo "║  Portal config: ${APP_DIR}/.env                           ║"
echo "╚══════════════════════════════════════════════════════════╝"
