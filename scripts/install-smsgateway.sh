#!/usr/bin/env bash
# install-smsgateway.sh — install the Linux SMS gateway and point Zeus +
# Capstone at it.
#
#   scripts/install-smsgateway.sh                 # install, generate a key
#   scripts/install-smsgateway.sh --key osms_...  # reuse an existing key
#   scripts/install-smsgateway.sh --uninstall
#
# What it does:
#   1. checks (and, with --apt, installs) the modem tooling: ModemManager +
#      mmcli, dbus-send, usb-modeswitch, python3
#   2. writes /etc/zeus-smsgateway.env (root, 0600) with the API key
#   3. installs systemd/zeus-smsgateway.service; without systemd (containers)
#      it starts `python3 -m smsgateway` with nohup and records the pid
#   4. writes OPENSMS_URL / OPENSMS_API_KEY into this repo's .env and, when it
#      exists, ../capstone/.env — so the picker and Settings card see it
#
# The gateway binds 0.0.0.0:9292 so containers can reach it. Every request
# needs the Bearer key; keep 9292 off the public internet (it is LAN-only by
# design — the phone/modem is the trust boundary, not the network).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CAPSTONE_ENV="${CAPSTONE_ENV:-$REPO_ROOT/../capstone/.env}"
ENV_FILE="${SMSGATEWAY_ENV_FILE:-/etc/zeus-smsgateway.env}"
UNIT_SRC="$REPO_ROOT/systemd/zeus-smsgateway.service"
UNIT_DST="/etc/systemd/system/zeus-smsgateway.service"
PID_FILE="${SMSGATEWAY_PID_FILE:-$REPO_ROOT/data/smsgateway.pid}"
PORT="${SMSGATEWAY_PORT:-9292}"
KEY=""
DO_APT=0
UNINSTALL=0

say() { printf 'smsgateway: %s\n' "$*"; }
die() { printf 'smsgateway: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --key) KEY="${2:-}"; shift 2 ;;
    --key=*) KEY="${1#*=}"; shift ;;
    --apt) DO_APT=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --port) PORT="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

have() { command -v "$1" >/dev/null 2>&1; }

# ── uninstall ────────────────────────────────────────────────────────────
if [ "$UNINSTALL" = "1" ]; then
  if [ -f "$UNIT_DST" ]; then
    systemctl disable --now zeus-smsgateway 2>/dev/null || true
    rm -f "$UNIT_DST"
    systemctl daemon-reload 2>/dev/null || true
    say "removed $UNIT_DST"
  fi
  if [ -f "$PID_FILE" ]; then
    kill "$(cat "$PID_FILE")" 2>/dev/null || true
    rm -f "$PID_FILE"
    say "stopped the nohup instance"
  fi
  rm -f /etc/systemd/system/ModemManager.service.d/zeus-container.conf
  systemctl daemon-reload 2>/dev/null || true
  rm -f "$ENV_FILE"
  say "removed $ENV_FILE (the .env OpenSMS_* entries were left alone)"
  exit 0
fi

# ── dependencies ─────────────────────────────────────────────────────────
missing=()
for cmd in python3 mmcli dbus-send; do
  have "$cmd" || missing+=("$cmd")
done
have usb_modeswitch || missing+=("usb_modeswitch")

if [ "${#missing[@]}" -gt 0 ]; then
  if [ "$DO_APT" = "1" ] && have apt-get; then
    say "installing: ${missing[*]}"
    DEBIAN_FRONTEND=noninteractive apt-get update -qq || true
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      modemmanager usb-modeswitch dbus usb-modeswitch-data python3
  else
    die "missing tools: ${missing[*]}
Install them (Debian/Ubuntu):
  sudo apt-get install -y modemmanager usb-modeswitch dbus
or re-run with --apt"
  fi
fi

# ModemManager must be running for the modemmanager backend. Its stock unit
# carries `ConditionVirtualization=!container`, so inside LXC/Docker systemd
# skips it — check the process, not the unit, and fall back to starting the
# daemon directly.
mm_running() { pgrep -x ModemManager >/dev/null 2>&1; }
if ! mm_running; then
  if [ -d /run/systemd/system ]; then
    systemctl start ModemManager 2>/dev/null || true
    sleep 2
  fi
  # The stock unit carries `ConditionVirtualization=!container`, so systemd
  # skips it inside LXC/Docker. An empty assignment clears the condition — a
  # drop-in, so the distro unit stays untouched and `--uninstall` removes it.
  if ! mm_running && [ -d /run/systemd/system ] && have systemctl; then
    install -d /etc/systemd/system/ModemManager.service.d
    cat > /etc/systemd/system/ModemManager.service.d/zeus-container.conf <<'EOF'
# Installed by zeus/scripts/install-smsgateway.sh. The stock unit skips
# containers (ConditionVirtualization=!container); an empty assignment clears
# that condition so a USB modem is still managed here.
[Unit]
ConditionVirtualization=
EOF
    systemctl daemon-reload 2>/dev/null || true
    systemctl start ModemManager 2>/dev/null || true
    sleep 2
  fi
  if ! mm_running; then
    say "ModemManager did not start via systemd — starting it directly"
    nohup /usr/sbin/ModemManager >> /var/log/ModemManager.log 2>&1 &
    sleep 2
  fi
fi
if mm_running; then
  say "ModemManager is running"
else
  say "warning: ModemManager is not running — use SMSGATEWAY_BACKEND=serial"
  say "         with SMSGATEWAY_SERIAL_DEVICE=/dev/ttyUSB0 for an AT-capable modem"
fi

# ── API key ──────────────────────────────────────────────────────────────
if [ -z "$KEY" ]; then
  if [ -f "$ENV_FILE" ] && grep -q '^SMSGATEWAY_API_KEY=' "$ENV_FILE"; then
    KEY="$(grep -m1 '^SMSGATEWAY_API_KEY=' "$ENV_FILE" | cut -d= -f2-)"
  fi
fi
if [ -z "$KEY" ]; then
  KEY="osms_$(openssl rand -hex 24 2>/dev/null || head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  say "generated a new API key"
fi

# ── service env ──────────────────────────────────────────────────────────
install -d "$(dirname "$ENV_FILE")"
umask 077
cat > "$ENV_FILE" <<EOF
# Zeus Linux SMS gateway — written by scripts/install-smsgateway.sh
# Bind on all interfaces so the portal (host network) and the Capstone
# containers (bridge) both reach it. Every request carries the Bearer key.
SMSGATEWAY_HOST=0.0.0.0
SMSGATEWAY_PORT=$PORT
SMSGATEWAY_API_KEY=$KEY
# Same key under the name the Zeus/Capstone clients already read.
OPENSMS_API_KEY=$KEY
# auto: ModemManager first, then an AT probe on /dev/ttyUSB* / ttyACM*.
SMSGATEWAY_BACKEND=auto
SMSGATEWAY_TIMEOUT=30
EOF
chmod 600 "$ENV_FILE"
say "wrote $ENV_FILE"

# ── start ────────────────────────────────────────────────────────────────
started=0
if [ -d /run/systemd/system ] && have systemctl; then
  sed -e "s#/PATH/TO/ZEUS#$REPO_ROOT#g" \
      -e "s#^EnvironmentFile=.*#EnvironmentFile=$ENV_FILE#" \
      "$UNIT_SRC" > "$UNIT_DST"
  systemctl daemon-reload
  systemctl enable --now zeus-smsgateway
  started=1
  say "installed and started zeus-smsgateway.service"
fi

if [ "$started" = "0" ]; then
  # No systemd (a container): run it directly, replacing an older instance.
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    kill "$(cat "$PID_FILE")" 2>/dev/null || true
    sleep 1
  fi
  install -d "$(dirname "$PID_FILE")"
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
  (cd "$REPO_ROOT" && nohup python3 -u -m smsgateway >> "$REPO_ROOT/data/smsgateway.log" 2>&1 & echo $! > "$PID_FILE")
  sleep 2
  say "started python3 -m smsgateway (pid $(cat "$PID_FILE"), log data/smsgateway.log)"
fi

# ── wire the clients ─────────────────────────────────────────────────────
# Zeus runs with network_mode: host, so loopback is the right URL there.
# Capstone's containers are on the bridge; 172.17.0.1 is the host from there,
# and host scripts reach that address too.
HOST_URL="http://127.0.0.1:$PORT"
CAPSTONE_URL="${CAPSTONE_SMSGATEWAY_URL:-http://172.17.0.1:$PORT}"

set_env() { # set_env <file> <key> <value>
  local file="$1" key="$2" value="$3" current
  touch "$file"
  current="$(grep -m1 -E "^${key}=" "$file" | cut -d= -f2- || true)"
  # Never replace a Vault reference with a plaintext secret: the portal
  # resolves `vault://` on start (scripts/compose-vault.sh), and the
  # reference is the intended form there.
  case "$current" in
    vault://*)
      say "$file: keeping the existing $key vault:// reference"
      return 0
      ;;
  esac
  if [ -n "$current" ] || grep -qE "^${key}=" "$file"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$file"
  else
    printf '\n# Linux SMS gateway (scripts/install-smsgateway.sh)\n%s=%s\n' "$key" "$value" >> "$file"
  fi
}

set_env "$REPO_ROOT/.env" OPENSMS_URL "$HOST_URL"
set_env "$REPO_ROOT/.env" OPENSMS_API_KEY "$KEY"
say "zeus/.env -> OPENSMS_URL=$HOST_URL"

if [ -f "$CAPSTONE_ENV" ]; then
  set_env "$CAPSTONE_ENV" OPENSMS_URL "$CAPSTONE_URL"
  set_env "$CAPSTONE_ENV" OPENSMS_API_KEY "$KEY"
  # The standalone scripts still default to Zeus; the gateway being up is what
  # makes "Local" selectable, not a changed default.
  say "capstone/.env -> OPENSMS_URL=$CAPSTONE_URL"
fi

# ── health ───────────────────────────────────────────────────────────────
sleep 1
if have curl; then
  code="$(curl -fsS -o /tmp/smsgateway-health.json -w '%{http_code}' "$HOST_URL/health" 2>/dev/null || true)"
  if [ "$code" = "200" ]; then
    say "gateway healthy: $(cat /tmp/smsgateway-health.json)"
  else
    say "gateway answered HTTP ${code:-none} — no modem yet? Plug in the phone/USB modem,"
    say "then check: python3 -m smsgateway --check   (or mmcli -L)"
  fi
fi

say "done. Restart the consumers so they pick up the new .env:"
say "  scripts/compose-vault.sh -f docker-compose.full.yml up -d --no-deps portal"
say "  cd ../capstone && docker compose up -d --force-recreate dashboard-api"
