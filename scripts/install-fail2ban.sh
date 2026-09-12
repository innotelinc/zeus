#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# install-fail2ban.sh — host-side SIP registration ban for the Zeus PBX.
#
# The PBX runs in Docker with *published* ports, so Asterisk cannot ban anything
# itself and the ban has to be applied on the host, in Docker's DOCKER-USER
# chain (see pbx/fail2ban/action.d/docker-user.conf for the full reasoning).
# Asterisk writes its security events into a named volume that this installer
# mounts into fail2ban's view, so the daemon reads the logs straight off disk —
# no docker exec, no log shipper.
#
# Policy: one invalid registration attempt ⇒ 48 hour ban, LAN exempt. Repeat
# offenders are handled by the recidive jail.
#
# Usage:
#   sudo scripts/install-fail2ban.sh                    # install + start
#   sudo scripts/install-fail2ban.sh --status           # jails, bans, counters
#   sudo scripts/install-fail2ban.sh --dry-run          # show what would change
#   sudo scripts/install-fail2ban.sh --uninstall        # stop + remove config
#
# Options (all optional):
#   --log-dir DIR      Asterisk log dir as seen from the host
#                      (default: the pbx-asterisk-logs volume's _data path)
#   --lan CIDR[,CIDR]  extra ignoreip entries (default: auto-detected)
#   --bantime SECONDS  ban length (default 172800 = 48h)
#   --maxretry N       failures before a ban (default 1 — first bad packet)
#   --no-install       never touch the package manager
#
# Idempotent: re-running re-renders the same files and reloads the daemon.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="${REPO_ROOT}/pbx/fail2ban"
F2B_DIR="/etc/fail2ban"
# Zeus names its PBX volumes zeus-* (capstone's mirror uses pbx-*); override
# with F2B_VOLUME when the deploy renames them.
VOLUME="${F2B_VOLUME:-zeus-asterisk-logs}"

# Left empty so precedence is CLI flag > .env (F2B_BANTIME/F2B_MAXRETRY) >
# the defaults applied after the .env read below.
BANTIME=""              # 48h
FINDTIME=3600
MAXRETRY=""            # first bad packet
LOG_DIR=""
LAN=""
DO_INSTALL=1
MODE="install"

RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'
CYAN=$'\033[0;36m'; BOLD=$'\033[1m'; NC=$'\033[0m'
info()  { printf '%s==>%s %s\n' "${CYAN}" "${NC}" "$*"; }
pass()  { printf '%s  ✓%s %s\n' "${GREEN}" "${NC}" "$*"; }
warn()  { printf '%s  !%s %s\n' "${YELLOW}" "${NC}" "$*"; }
fail()  { printf '%s  ✗%s %s\n' "${RED}" "${NC}" "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --log-dir)    LOG_DIR="${2:?--log-dir needs a value}"; shift 2 ;;
    --lan)        LAN="${2:?--lan needs a value}"; shift 2 ;;
    --bantime)    BANTIME="${2:?--bantime needs a value}"; shift 2 ;;
    --maxretry)   MAXRETRY="${2:?--maxretry needs a value}"; shift 2 ;;
    --no-install) DO_INSTALL=0; shift ;;
    --dry-run)    MODE="dry-run"; shift ;;
    --status)     MODE="status"; shift ;;
    --uninstall)  MODE="uninstall"; shift ;;
    -h|--help)    sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)            fail "unknown option: $1 (try --help)" ;;
  esac
done

# ── .env: F2B_* overrides ────────────────────────────────────────────────────
# .env is a compose env file — values are unquoted and may contain spaces
# (DOGRAH_ADMIN_NAME=Capstone Admin), so it cannot be `source`d: bash would try
# to run `Admin`. Read only the keys this script understands.
env_get() {
  sed -n "s/^${1}=//p" "${REPO_ROOT}/.env" 2>/dev/null | head -n 1 \
    | sed -e 's/[[:space:]]*#.*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}
if [ -f "${REPO_ROOT}/.env" ]; then
  LOG_DIR="${LOG_DIR:-$(env_get F2B_LOG_DIR)}"
  LAN="${LAN:-$(env_get F2B_IGNOREIP)}"
  BANTIME="${BANTIME:-$(env_get F2B_BANTIME)}"
  MAXRETRY="${MAXRETRY:-$(env_get F2B_MAXRETRY)}"
fi
LOG_DIR="${LOG_DIR:-}"
LAN="${LAN:-}"
BANTIME="${BANTIME:-172800}"   # 48h
MAXRETRY="${MAXRETRY:-1}"      # first invalid attempt

# ── status: read-only, no root needed beyond fail2ban-client ─────────────────
if [ "$MODE" = "status" ]; then
  command -v fail2ban-client >/dev/null 2>&1 || fail "fail2ban-client not installed"
  for jail in asterisk-security asterisk-registration recidive; do
    printf '\n%s%s%s\n' "${BOLD}" "$jail" "${NC}"
    fail2ban-client status "$jail" 2>&1 | sed 's/^/  /' || true
  done
  printf '\n%sDOCKER-USER drop rules%s\n' "${BOLD}" "${NC}"
  iptables -w -S DOCKER-USER 2>/dev/null | grep -- '-j DROP' | sed 's/^/  /' || echo "  (none)"
  exit 0
fi

[ "$(id -u)" -eq 0 ] || fail "must run as root (sudo $0)"

if [ "$MODE" = "uninstall" ]; then
  info "Uninstalling fail2ban jails"
  if command -v fail2ban-client >/dev/null 2>&1; then
    fail2ban-client unban --all >/dev/null 2>&1 || true
    systemctl disable --now fail2ban >/dev/null 2>&1 || true
    pass "fail2ban stopped and disabled"
  fi
  for f in "${F2B_DIR}/jail.local" \
           "${F2B_DIR}/filter.d/asterisk-security.conf" \
           "${F2B_DIR}/filter.d/asterisk-registration.conf" \
           "${F2B_DIR}/action.d/docker-user.conf"; do
    if [ -e "$f" ]; then
      rm -f "$f"
      pass "removed $f"
    fi
  done
  left=$(iptables -w -S DOCKER-USER 2>/dev/null | grep -c -- '-j DROP' || true)
  if [ "${left:-0}" -eq 0 ]; then
    pass "no DOCKER-USER drop rules left"
  else
    warn "${left} DOCKER-USER drop rule(s) remain — fail2ban unban needs the daemon up"
  fi
  exit 0
fi

[ -d "$SRC_DIR" ] || fail "config source not found: $SRC_DIR"

# ── 1. Docker bits: the DOCKER-USER chain + the log volume ───────────────────
info "Checking Docker prerequisites"
command -v docker >/dev/null 2>&1 || fail "docker not found on PATH"
iptables -w -n -L DOCKER-USER >/dev/null 2>&1 \
  || fail "DOCKER-USER chain missing — is the Docker daemon running?"
pass "DOCKER-USER chain present"

if ! docker volume inspect "$VOLUME" >/dev/null 2>&1; then
  if [ "$MODE" = "dry-run" ]; then
    info "would create volume $VOLUME"
  else
    docker volume create "$VOLUME" >/dev/null || fail "could not create volume $VOLUME"
    pass "created Docker volume $VOLUME"
  fi
fi
if [ -z "$LOG_DIR" ]; then
  mp=$(docker volume inspect "$VOLUME" --format '{{.Mountpoint}}' 2>/dev/null || true)
  # A dry run should preview on a host that has not deployed the stack yet, so
  # fall back to the conventional volume path instead of failing.
  if [ -z "$mp" ] && [ "$MODE" = "dry-run" ]; then
    mp="/var/lib/docker/volumes/${VOLUME}/_data"
  fi
  [ -n "$mp" ] || fail "cannot resolve the $VOLUME mountpoint; pass --log-dir"
  LOG_DIR="$mp"
fi
info "Asterisk log dir: ${LOG_DIR}"

# ── 2. ignoreip ─────────────────────────────────────────────────────────────
# The LAN is exempt so a misconfigured softphone cannot lock itself out for two
# days. Auto-detect the subnet on the interface holding the default route.
if [ -z "$LAN" ]; then
  LAN="$(python3 - <<'PY' 2>/dev/null || true
import ipaddress, json, subprocess
try:
    out = subprocess.run(["ip", "-j", "route", "get", "1.1.1.1"],
                         capture_output=True, text=True, check=True).stdout
    dev = json.loads(out)[0].get("dev")
    addr = json.loads(subprocess.run(["ip", "-j", "addr", "show", "dev", dev],
                                     capture_output=True, text=True, check=True).stdout)
    iface = ipaddress.ip_interface(
        f"{addr[0]['addr_info'][0]['local']}/{addr[0]['addr_info'][0]['prefixlen']}")
    print(iface.network)
except Exception:
    pass
PY
)"
fi
# The template pins 127.0.0.1/8 + ::1 itself; __IGNOREIP__ carries only the
# extra networks, so the rendered line never repeats the loopback pair.
#
# Docker's bridge subnets are exempt as well. Container-to-container traffic is
# not NAT'd to a public source, so no attacker can appear from one of these —
# but an in-stack client that ever fails an AMI or ARI login (a rotated secret,
# a restart race, a probe) absolutely can, and must not earn a 48h ban. Learned
# the hard way: a bridge-network AMI probe was banned within seconds of the
# jails going live.
BRIDGE_RANGES="172.16.0.0/12 10.0.0.0/8"
IGNOREIP="${LAN:+$LAN }${BRIDGE_RANGES}"
pass "ignoreip (exempt): 127.0.0.1/8 ::1 ${IGNOREIP}"
[ -n "$LAN" ] || warn "no LAN detected — only loopback and the Docker ranges will be exempt"

# ── 3. render config ────────────────────────────────────────────────────────
render() {
  local src="$1" dst="$2"
  sed -e "s|__LOG_DIR__|${LOG_DIR}|g" \
      -e "s|__IGNOREIP__|${IGNOREIP}|g" \
      -e "s|__BANTIME__|${BANTIME}|g" \
      -e "s|__FINDTIME__|${FINDTIME}|g" \
      -e "s|__MAXRETRY__|${MAXRETRY}|g" "$src" > "$dst"
}

if [ "$MODE" = "dry-run" ]; then
  info "dry run — rendered jail.local follows, nothing written"
  render "${SRC_DIR}/jail.local.in" /dev/stdout
  exit 0
fi

# ── 4. package ──────────────────────────────────────────────────────────────
if [ "$DO_INSTALL" -eq 1 ] && ! command -v fail2ban-client >/dev/null 2>&1; then
  info "Installing fail2ban"
  if command -v apt-get >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq fail2ban
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y -q fail2ban
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache fail2ban
  else
    fail "no supported package manager — install fail2ban and re-run with --no-install"
  fi
fi
command -v fail2ban-client >/dev/null 2>&1 || fail "fail2ban-client still not available"

# ── 5. configs ──────────────────────────────────────────────────────────────
info "Installing jails, filters and the DOCKER-USER action"
install -d -m 0755 "${F2B_DIR}/filter.d" "${F2B_DIR}/action.d" "${F2B_DIR}/jail.d"
install -m 0644 "${SRC_DIR}/filter.d/asterisk-security.conf"     "${F2B_DIR}/filter.d/"
install -m 0644 "${SRC_DIR}/filter.d/asterisk-registration.conf" "${F2B_DIR}/filter.d/"
install -m 0644 "${SRC_DIR}/action.d/docker-user.conf"          "${F2B_DIR}/action.d/"
render "${SRC_DIR}/jail.local.in" "${F2B_DIR}/jail.local"
chmod 0644 "${F2B_DIR}/jail.local"
pass "wrote ${F2B_DIR}/jail.local (bantime=${BANTIME}s, maxretry=${MAXRETRY}, logdir=${LOG_DIR})"

# The security channel only exists once the PBX has written one; create the file
# so fail2ban can start before the first attack arrives.
[ -e "${LOG_DIR}/security" ] || : > "${LOG_DIR}/security"

# ── 6. start ────────────────────────────────────────────────────────────────
info "Starting fail2ban"
systemctl enable fail2ban >/dev/null 2>&1 || true
systemctl restart fail2ban 2>/dev/null || service fail2ban restart 2>/dev/null || fail2ban-client start
for _ in $(seq 1 20); do
  sleep 1
  fail2ban-client ping >/dev/null 2>&1 && break
done
fail2ban-client ping >/dev/null 2>&1 || fail "fail2ban did not come up — journalctl -u fail2ban"

# ── 7. verify ───────────────────────────────────────────────────────────────
status=0
for jail in asterisk-security asterisk-registration recidive; do
  if fail2ban-client status "$jail" >/dev/null 2>&1; then
    n=$(fail2ban-client status "$jail" | awk -F'\t' '/Currently banned/{print $2}' | tr -d ' ')
    pass "$jail active (currently banned: ${n:-0})"
  else
    warn "$jail NOT active — check /var/log/fail2ban.log"
    status=1
  fi
done

printf '\n%sInstalled.%s\n\n' "${BOLD}" "${NC}"
cat <<EOF
  Ban policy    1 invalid SIP attempt → ${BANTIME}s drop in DOCKER-USER
  Exempt        ${IGNOREIP}
  Log source    ${LOG_DIR}/{security,full}
  Status        scripts/install-fail2ban.sh --status
  Live bans     iptables -S DOCKER-USER | grep DROP

  The jails go live as soon as the PBX writes its security channel — the
  freepbx service must be running with the asterisk-logs volume mounted
  (see docker-compose.yml + pbx/entrypoint-dograh.sh).
EOF
exit "$status"
