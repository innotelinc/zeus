#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Zeus VOIP — FreePBX Full Stack — Docker Entrypoint
# Starts MariaDB/helpers, then Asterisk in the background, waits for it to
# become ready, and only then starts the web stack (PHP-FPM + Apache) so the
# FreePBX UI can never trigger a reload before Asterisk is up. Asterisk runs
# as the foreground process keeping the container alive.
# ═══════════════════════════════════════════════════════════════
set -e

echo ">>> Starting Zeus Full Stack..."

# Start MariaDB (FreePBX database) — must run before OAuth2 client registration
# shellcheck disable=SC2015 # best-effort dir prep, non-fatal on failure
mkdir -p /var/run/mysqld && chown mysql:mysql /var/run/mysqld 2>/dev/null || true
service mariadb start

# ── Ensure FreePBX CDR/CEL tables exist ──────────────────────
# FreePBX creates asteriskcdrdb.cdr/.cel only when the database is empty at
# install time. A pre-existing/restored mariadb-data volume (or a partial
# install that skipped cdr.sql) leaves them missing, and the CDR Reports /
# Call Event Logging pages then throw "Table 'asteriskcdrdb.cdr' doesn't
# exist" (or .cel) from Database.class.php / Cel.class.php. Recreate them
# idempotently on every boot.
mysql -u root <<'SQL' 2>/dev/null || true
CREATE DATABASE IF NOT EXISTS asteriskcdrdb;
CREATE TABLE IF NOT EXISTS asteriskcdrdb.cdr (
  calldate datetime NOT NULL DEFAULT '1000-01-01 00:00:00',
  clid varchar(80) NOT NULL DEFAULT '',
  src varchar(80) NOT NULL DEFAULT '',
  dst varchar(80) NOT NULL DEFAULT '',
  dcontext varchar(80) NOT NULL DEFAULT '',
  channel varchar(80) NOT NULL DEFAULT '',
  dstchannel varchar(80) NOT NULL DEFAULT '',
  lastapp varchar(80) NOT NULL DEFAULT '',
  lastdata varchar(80) NOT NULL DEFAULT '',
  duration int(11) NOT NULL DEFAULT '0',
  billsec int(11) NOT NULL DEFAULT '0',
  disposition varchar(45) NOT NULL DEFAULT '',
  amaflags int(11) NOT NULL DEFAULT '0',
  accountcode varchar(20) NOT NULL DEFAULT '',
  uniqueid varchar(32) NOT NULL DEFAULT '',
  userfield varchar(255) NOT NULL DEFAULT '',
  did varchar(50) NOT NULL DEFAULT '',
  recordingfile varchar(255) NOT NULL DEFAULT '',
  cnum varchar(80) NOT NULL DEFAULT '',
  cnam varchar(80) NOT NULL DEFAULT '',
  outbound_cnum varchar(80) NOT NULL DEFAULT '',
  outbound_cnam varchar(80) NOT NULL DEFAULT '',
  dst_cnam varchar(80) NOT NULL DEFAULT '',
  linkedid varchar(32) NOT NULL DEFAULT '',
  peeraccount varchar(80) NOT NULL DEFAULT '',
  sequence int(11) NOT NULL DEFAULT '0',
  KEY calldate (calldate),
  KEY dst (dst),
  KEY accountcode (accountcode),
  KEY uniqueid (uniqueid),
  KEY did (did),
  KEY recordingfile (recordingfile(191))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS asteriskcdrdb.cel (
  id int(11) NOT NULL AUTO_INCREMENT,
  eventtype varchar(30) NOT NULL,
  eventtime datetime NOT NULL,
  cid_name varchar(80) NOT NULL,
  cid_num varchar(80) NOT NULL,
  cid_ani varchar(80) NOT NULL,
  cid_rdnis varchar(80) NOT NULL,
  cid_dnid varchar(80) NOT NULL,
  exten varchar(80) NOT NULL,
  context varchar(80) NOT NULL,
  channame varchar(80) NOT NULL,
  appname varchar(80) NOT NULL,
  appdata varchar(255) NOT NULL,
  amaflags int(11) NOT NULL,
  accountcode varchar(20) NOT NULL,
  uniqueid varchar(32) NOT NULL,
  linkedid varchar(32) NOT NULL,
  peer varchar(80) NOT NULL,
  userdeftype varchar(255) NOT NULL,
  extra varchar(512) NOT NULL,
  PRIMARY KEY (id),
  KEY uniqueid_index (uniqueid),
  KEY linkedid_index (linkedid),
  KEY context_index (context)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
SQL

# ── ODBC DSN for CDR/CEL ───────────────────────────────────────────────────
# res_odbc / cdr_adaptive_odbc / cel_odbc each fail with "Data source name not
# found and no default driver specified" — and CDR/CEL then record *nothing at
# all* (no calls, no caller ID) — when /etc/odbc.ini names a driver that
# odbcinst.ini doesn't define, or when Socket= points at a mysqld socket this
# container doesn't use. The image ships `driver=MySQL` while only the MariaDB
# Connector/ODBC ("MariaDB Unicode") is installed, and its socket path is the
# distro default rather than the one mariadb actually listens on here, so
# normalise both on every boot. Runs after `service mariadb start`, so the real
# socket exists to compare against.
if [ -f /etc/odbc.ini ]; then
  odbc_driver="$(sed -nE 's/^[[:space:]]*driver[[:space:]]*=[[:space:]]*(.*)$/\1/p' /etc/odbc.ini | head -1)"
  if [ -n "$odbc_driver" ] && ! odbcinst -q -d 2>/dev/null | grep -qxF "[$odbc_driver]"; then
    for cand in "MariaDB Unicode" "MariaDB" "MySQL"; do
      if odbcinst -q -d 2>/dev/null | grep -qxF "[$cand]"; then
        sed -i "s|^[[:space:]]*driver[[:space:]]*=.*|driver=$cand|" /etc/odbc.ini
        echo ">>> [odbc] driver '$odbc_driver' is not installed — using '$cand'"
        break
      fi
    done
  fi
  odbc_socket="$(sed -nE 's/^[[:space:]]*Socket[[:space:]]*=[[:space:]]*(.*)$/\1/p' /etc/odbc.ini | head -1)"
  if [ -n "$odbc_socket" ] && [ ! -S "$odbc_socket" ]; then
    for cand in /run/mysqld/mysqld.sock /var/run/mysqld/mysqld.sock /var/lib/mysql/mysql.sock; do
      if [ -S "$cand" ]; then
        sed -i "s|^[[:space:]]*Socket[[:space:]]*=.*|Socket=$cand|" /etc/odbc.ini
        echo ">>> [odbc] Socket '$odbc_socket' does not exist — using '$cand'"
        break
      fi
    done
  fi
fi

# ── The DSNs res_odbc_custom.conf names and odbc.ini does not define ───────
# The block above repairs the DSN /etc/odbc.ini *has* — a driver from another
# distribution, a socket this container does not listen on. It cannot repair
# one that is missing, and the estate names exactly that:
# res_odbc_custom.conf registers [asteriskvoicemail] — the class app_voicemail
# stores messages through — against MySQL-asteriskvoicemail, while odbc.ini
# defines only the CDR DSN. A res_odbc class whose DSN is absent is not an
# inert one: every voicemail retrieve fails to connect with "Data source name
# not found and no default driver specified", and `*97` (FreePBX's My
# Voicemail) plays nothing at all. That section added by hand — the fix the
# upstream deploy README documents — is what does not survive this container
# being recreated, because /etc/odbc.ini lives in the image, which is why this
# file patches it on every boot in the first place.
#
# So derive it rather than restate it: for every class in res_odbc_custom.conf
# whose `dsn=>` names a section odbc.ini lacks, add that section by mirroring
# the first one odbc.ini does define — same driver, host, credentials and
# socket as the connection the block above just made resolvable — and take the
# `database` name from the class that asked for it. Nothing here assumes which
# classes exist or which are in use: "configured but unreachable" is the
# failure, so making it reachable is the whole repair. The boot's `fwconsole
# reload` below is what makes res_odbc pick it up, the same reload that applies
# the driver and socket fix above.
ODBC_INI="${ODBC_INI:-/etc/odbc.ini}"
RES_ODBC_CUSTOM="${RES_ODBC_CUSTOM:-/etc/asterisk/res_odbc_custom.conf}"
if [ -f "$RES_ODBC_CUSTOM" ] && [ -f "$ODBC_INI" ] && grep -q '^[[:space:]]*\[' "$ODBC_INI"; then
  # One `class <TAB> dsn <TAB> database` line per class in the file. FreePBX
  # writes `=>` and a hand edit leaves `=` behind, so both are read.
  while IFS="$(printf '\t')" read -r odbc_class odbc_dsn odbc_db; do
    [ -n "$odbc_dsn" ] || continue
    [ -n "$odbc_db" ] || continue
    if grep -qF "[$odbc_dsn]" "$ODBC_INI"; then
      continue
    fi
    odbc_body="$(awk -v db="$odbc_db" '
      /^[[:space:]]*\[/ { if (seen) exit; seen = 1; next }
      seen != 1 { next }
      length($0) == 0 || /^[[:space:]]*[;#]/ { next }
      /^[[:space:]]*[Dd]escription[[:space:]]*=/ { print "Description=MySQL connection to \047" db "\047 database"; next }
      /^[[:space:]]*[Dd]atabase[[:space:]]*=/ { print "database=" db; next }
      { print }
    ' "$ODBC_INI")"
    if [ -n "$odbc_body" ]; then
      {
        printf '\n[%s]\n' "$odbc_dsn"
        printf '%s\n' "$odbc_body"
      } >> "$ODBC_INI"
      echo ">>> [odbc] ${odbc_class}: $odbc_dsn was not defined — added it (database=$odbc_db)"
    fi
  done < <(awk '
    /^[[:space:]]*\[/ {
      if (cls != "") print cls "\t" dsn "\t" db
      cls = $0
      sub(/^[[:space:]]*\[/, "", cls)
      sub(/\][[:space:]]*$/, "", cls)
      dsn = ""; db = ""
      next
    }
    cls != "" && /^[[:space:]]*dsn[[:space:]]*=>?/ { d = $0; sub(/^[^=]*=>?[[:space:]]*/, "", d); sub(/[[:space:]]+$/, "", d); dsn = d; next }
    cls != "" && /^[[:space:]]*database[[:space:]]*=>?/ { d = $0; sub(/^[^=]*=>?[[:space:]]*/, "", d); sub(/[[:space:]]+$/, "", d); db = d; next }
    END { if (cls != "") print cls "\t" dsn "\t" db }
  ' "$RES_ODBC_CUSTOM")
fi

# ── Adopt an existing database's credentials ───────────────────────────────
# FreePBX's installer generates AMPDBPASS *randomly at image build time*, but
# the database lives on the shared pbx-mariadb-data volume and outlives every
# image. A volume created by a different build — a Zeus image upgrade, or the
# Capstone add-on's bundled FreePBX before this one — therefore carries a
# different password, and everything that talks to FreePBX's database breaks
# with "Access denied for user 'freepbxuser'@'localhost'": the web UI,
# `fwconsole reload`, `fwconsole chown`, module management. Asterisk itself
# keeps running on its static config, so the PBX *looks* alive while its whole
# control plane is dead — the worst kind of failure to discover later.
#
# Set PBX_DB_PASS in .env to the password the volume was created with
# (`.env.docker.example`) and both sides are reconciled to it: the config file
# this container uses *and* the MariaDB grant. That also keeps the hand-off
# between Zeus and the add-on reversible in either direction, because the
# volume's credentials never change. Unset (a fresh volume) → this image's own
# generated password is already the right one and nothing is touched.
# ── fwconsole must be executable ────────────────────────────
# `fwconsole chown` (FreePBX's Chown module, run below) rewrites the mode bits
# across /var/lib/asterisk/bin — 644 for files — and re-adds the launcher's +x
# only when it finishes. Any earlier run that aborted partway (a database
# error, a timeout, an interrupted boot) therefore leaves fwconsole itself
# non-executable in the image layer, and every fwconsole call after it fails
# with a bare "Permission denied". The image ships it 777, so restoring the bit
# is always correct and cheap.
ensure_fwconsole() {
  [ -x /var/lib/asterisk/bin/fwconsole ] && return 0
  chmod +x /var/lib/asterisk/bin/fwconsole 2>/dev/null || true
  [ -x /var/lib/asterisk/bin/fwconsole ] &&
    echo ">>> [fwconsole] restored the execute bit on /var/lib/asterisk/bin/fwconsole"
}
ensure_fwconsole

FREEPBX_CONF="/etc/freepbx.conf"
if [ -n "${PBX_DB_PASS:-}" ] && [ -f "$FREEPBX_CONF" ]; then
  if sed -i -E "s|(AMPDBPASS'\] = ')[^']*(';)|\1${PBX_DB_PASS}\2|" "$FREEPBX_CONF" &&
     grep -q "AMPDBPASS'\] = '${PBX_DB_PASS}';" "$FREEPBX_CONF"; then
    echo ">>> [db] ${FREEPBX_CONF} adopted PBX_DB_PASS"
  else
    echo ">>> [db] WARNING: could not write AMPDBPASS into ${FREEPBX_CONF}" >&2
  fi
  for host in localhost '%'; do
    mysql -u root -e \
      "ALTER USER IF EXISTS 'freepbxuser'@'${host}' IDENTIFIED BY '${PBX_DB_PASS}';" \
      2>/dev/null || true
  done
  if mysql -u freepbxuser -p"${PBX_DB_PASS}" -e 'SELECT 1' >/dev/null 2>&1; then
    echo ">>> [db] freepbxuser authenticated with PBX_DB_PASS"
  else
    echo ">>> [db] WARNING: freepbxuser still cannot authenticate — check PBX_DB_PASS" >&2
  fi
fi

# ── logger security channel — rejected-SIP records for fail2ban ────────────
# FreePBX owns logger.conf and regenerates it on Apply Config, but it ships
# `#include logger_logfiles_custom.conf` inside the [logfiles] section — the
# documented hook for extra channels. Adding `security => security` there makes
# Asterisk write one res_security_log record per rejected SIP message to
# /var/log/asterisk/security, which host-side fail2ban reads through the
# asterisk-logs volume (scripts/install-fail2ban.sh + pbx/fail2ban/).
#
# Only the security channel is added: the `full` channel already carries the
# "No matching endpoint found" / "Failed to authenticate" NOTICEs at the
# image's default level, and the registration jail matches those there.
LOGGER_CONF="/etc/asterisk/logger.conf"
LOGGER_CUSTOM="/etc/asterisk/logger_logfiles_custom.conf"
touch "${LOGGER_CUSTOM}"
if ! grep -qE '^[[:space:]]*security[[:space:]]*=>' "${LOGGER_CUSTOM}"; then
  {
    echo
    echo "; zeus: rejected-SIP records for fail2ban (scripts/install-fail2ban.sh)"
    echo "security => security"
  } >> "${LOGGER_CUSTOM}"
  echo ">>> logger.conf security channel enabled (fail2ban)"
fi
# Only if the image's logger.conf lost the include (one line inserted right
# after the [logfiles] header — never a section rewrite, which would drop the
# file's own includes).
if [ -f "${LOGGER_CONF}" ] && ! grep -q 'logger_logfiles_custom.conf' "${LOGGER_CONF}"; then
  sed -i '/^\[logfiles\]/a #include logger_logfiles_custom.conf' "${LOGGER_CONF}" 2>/dev/null || true
  echo ">>> logger.conf: added the custom logfiles include"
fi
chown asterisk:asterisk "${LOGGER_CUSTOM}" 2>/dev/null || true

# ── RTP plane: canonical rtp_custom.conf + the durable settings-DB write ────
# Zeus owns the RTP plane. Every consumer rides this one range — Zeus
# softphones/portal and the Capstone agent add-on — so the published compose
# mapping, the file Asterisk reads, and the FreePBX settings DB must all agree
# or RTP silently escapes the published ports and calls go one-way.
#
#   compose  FREEPBX_RTP_PORT_START..END      -> host publish (10101-10120)
#   file     /etc/asterisk/rtp_custom.conf    -> rtpstart/rtpend fallback
#   DB       kvstore_Sipsettings              -> what FreePBX regenerates
#            rtp_additional.conf from on Apply Config. This is the copy that
#            wins: Asterisk reads configs first-wins, so the generated file
#            shadows the included rtp_custom.conf.
#
# The Capstone repo's pbx/ layer mirrors this exact shape (same env names, same
# file, same DB write) so a shared box runs one RTP plane for both products.
# Override the STUN/TURN address with PJSIP_STUN_TURN_ADDR.
#
# PROJECT RULE: use the host's LAN IP for every service address. Docker
# addresses are not usable here — `host.docker.internal` does not resolve
# inside this container at all (there is no extra_hosts entry, so every lookup
# fails), and a bridge/service name or a subnet recorded by a different stack
# is at best a coincidence. Set PJSIP_STUN_TURN_ADDR to the LAN IP (e.g.
# 192.168.1.46) and PJSIP_LOCAL_NETS to that LAN subnet; the `coturn` compose
# alias remains only as a last-resort fallback and warns when it is used.
# Do NOT use host.docker.internal: ast_sockaddr_resolve fails on that alias and
# silently disables STUN.
ASTERISK_ETC="/etc/asterisk"
RTP_START="${FREEPBX_RTP_PORT_START:-10101}"
RTP_END="${FREEPBX_RTP_PORT_END:-10120}"
if [ -z "${PJSIP_STUN_TURN_ADDR:-}" ]; then
  echo ">>> WARNING: PJSIP_STUN_TURN_ADDR is unset — falling back to the 'coturn' compose name." >&2
  echo ">>>          Set it to this host's LAN IP (PJSIP_STUN_TURN_ADDR=192.168.x.x): docker addresses do not resolve for this project." >&2
fi
STUN_TURN_ADDR="${PJSIP_STUN_TURN_ADDR:-coturn}:${TURN_LISTENING_PORT:-3478}"
# Two TURN addresses, on purpose (see the STUN/TURN block below): Asterisk's
# own ICE reaches the TURN server from inside the compose network (no NAT
# hairpin), so the RTP rows use a docker-resolvable name, while the WebRTC rows
# are read by *browsers* — which cannot resolve a docker name at all — so they
# get the public name the portals already hand out.
TURN_PUBLIC_URI="${TURN_PUBLIC_ADDR:-coturn.zeus.innotel.us}:${TURN_LISTENING_PORT:-3478}"
if ! [[ "${RTP_START}" =~ ^[0-9]+$ && "${RTP_END}" =~ ^[0-9]+$ ]] || [ "${RTP_START}" -lt 1024 ] || [ "${RTP_START}" -gt "${RTP_END}" ]; then
  echo ">>> invalid RTP range ${RTP_START}-${RTP_END}" >&2
  exit 1
fi

# Rewrite the whole file so it always holds exactly the published block, and
# keep exactly one '#include rtp_custom.conf' in rtp.conf. The image appends
# the include at build time and FreePBX's core module template can add it again
# on reload -> "Same File included more than once". The rewrite goes through
# the symlink with python (open() follows it); `sed -i` would replace the
# symlink with a regular file and the include would vanish on the next Apply
# Config. Idempotent — safe to re-run after any fwconsole reload.
write_rtp_plane() {
  cat > "${ASTERISK_ETC}/rtp_custom.conf" <<EOF
[general]
stunaddr = ${STUN_TURN_ADDR}
icesupport = yes
rtpstart=${RTP_START}
rtpend=${RTP_END}
EOF
  chown asterisk:asterisk "${ASTERISK_ETC}/rtp_custom.conf" 2>/dev/null || true
  if [ -f "${ASTERISK_ETC}/rtp.conf" ]; then
    python3 - "${ASTERISK_ETC}/rtp.conf" <<'PYEOF' 2>/dev/null || true
import sys
p = sys.argv[1]
lines = open(p).read().split('\n')
seen = False
out = []
for line in lines:
    if line.strip() == '#include rtp_custom.conf':
        if seen:
            continue
        seen = True
    out.append(line)
if not seen:
    out.append('#include rtp_custom.conf')
open(p, 'w').write('\n'.join(out))
PYEOF
    chown asterisk:asterisk "${ASTERISK_ETC}/rtp.conf" 2>/dev/null || true
  fi
}
write_rtp_plane
echo ">>> rtp_custom.conf canonical (${RTP_START}-${RTP_END}, STUN/TURN ${STUN_TURN_ADDR})"

# Durable settings-DB write so FreePBX regenerates rtp_additional.conf with the
# published range on every Apply Config (survives `fwconsole reload`). Guarded
# against `set -e` — on a first boot FreePBX may still be populating the DB when
# MariaDB first answers.
set +e
mysql -u root asterisk -N -B 2>/dev/null \
  -e "INSERT INTO kvstore_Sipsettings (\`key\`, val, type, id) VALUES ('rtpstart','${RTP_START}',NULL,'noid') ON DUPLICATE KEY UPDATE val='${RTP_START}'; \
      INSERT INTO kvstore_Sipsettings (\`key\`, val, type, id) VALUES ('rtpend','${RTP_END}',NULL,'noid') ON DUPLICATE KEY UPDATE val='${RTP_END}';" \
  && echo ">>> rtpstart/rtpend=${RTP_START}-${RTP_END} written to kvstore_Sipsettings"
set -e

# ── Local networks (LAN only) ───────────────────────────────────────────────
# Sipsettings.localnets generates the `local_net=` lines in pjsip.transports.conf.
# Whatever an image or a shared volume carries over is eventually wrong: this box
# was declaring 172.18.0.0/16, a docker subnet that does not exist here at all
# (pbx-net is 172.31.0.0/16), so Asterisk classified a foreign range as on-net.
# Under the project rule — LAN addresses only for every service target — only the
# LAN subnet is declared. Default is the /24 of PJSIP_STUN_TURN_ADDR, so setting
# the LAN IP once configures both.
PJSIP_LOCAL_NETS="${PJSIP_LOCAL_NETS:-}"
STUN_HOST="${STUN_TURN_ADDR%:*}"
if [ -z "${PJSIP_LOCAL_NETS}" ] && [[ "${STUN_HOST}" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  PJSIP_LOCAL_NETS="$(printf '%s' "${STUN_HOST}" | awk -F. '{print $1"."$2"."$3".0/24"}')"
fi
if [ -n "${PJSIP_LOCAL_NETS}" ]; then
  LOCAL_NETS_JSON="$(python3 -c 'import json,sys; print(json.dumps([{"net": n.split("/")[0], "mask": n.split("/")[1]} for n in sys.argv[1].split(",") if n.strip()]))' "${PJSIP_LOCAL_NETS}")"
  set +e
  mysql -u root asterisk -N -B 2>/dev/null \
    -e "UPDATE kvstore_Sipsettings SET val='${LOCAL_NETS_JSON}' WHERE \`key\`='localnets'; \
        DELETE FROM kvstore_Sipsettings WHERE \`key\` LIKE 'udplocalnet-%';" \
    && echo ">>> localnets=${PJSIP_LOCAL_NETS} written to kvstore_Sipsettings"
  set -e
  # The file is what res_pjsip reads, and the transport has allow_reload=no, so
  # reconcile it now instead of waiting for the next Apply Config (which only
  # happens when someone opens the GUI). Takes effect on the next Asterisk start.
  python3 - "${ASTERISK_ETC}/pjsip.transports.conf" "${PJSIP_LOCAL_NETS}" <<'PYEOF' 2>/dev/null || true
import sys
path, nets = sys.argv[1], [n.strip() for n in sys.argv[2].split(",") if n.strip()]
try:
    lines = open(path).read().split("\n")
except OSError:
    raise SystemExit
out = []
for line in lines:
    if line.startswith("local_net="):
        continue  # stale range (docker or otherwise) — re-added below
    out.append(line)
    if line.startswith("bind="):
        out.extend(f"local_net={n}" for n in nets)
open(path, "w").write("\n".join(out))
PYEOF
  chown asterisk:asterisk "${ASTERISK_ETC}/pjsip.transports.conf" 2>/dev/null || true
fi

# ── Dograh external-media WebSocket ─────────────────────────────────────────
# The add-on's entrypoint owns this file normally, but it lives on the shared
# asterisk-config volume and its default URI is `host.docker.internal`, which
# cannot resolve here — Asterisk then fails every media WebSocket silently (no
# audio, nothing in the log). Reconcile it to a real LAN address whenever we
# know one: an explicit DOGRAH_WS_URI wins, otherwise a leftover
# host.docker.internal is repaired in place using the LAN host.
DOGRAH_CONF="${ASTERISK_ETC}/websocket_client.conf"
if [ -f "${DOGRAH_CONF}" ]; then
  if [ -n "${DOGRAH_WS_URI:-}" ]; then
    sed -i "s|^uri = .*|uri = ${DOGRAH_WS_URI}|" "${DOGRAH_CONF}" \
      && echo ">>> websocket_client.conf uri set from DOGRAH_WS_URI (${DOGRAH_WS_URI})"
  elif grep -q 'host\.docker\.internal' "${DOGRAH_CONF}" && [[ "${STUN_HOST}" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    sed -i "s|host\.docker\.internal|${STUN_HOST}|" "${DOGRAH_CONF}" \
      && echo ">>> websocket_client.conf repaired: host.docker.internal -> ${STUN_HOST}"
  fi
fi

# ── STUN / TURN / WebRTC wiring (durable, via the FreePBX settings DB) ──────
# TURN is part of the media plane Zeus owns: coturn runs as this stack's
# `coturn` service (3478/tcp+udp published, relay 49152-49251/udp published —
# the relay range is what carries media, so a forward for 3478 alone is not
# enough) and is wired in at the *settings* level, because the same values also
# live in FreePBX's SIP
# Settings — an Apply Config regenerates rtp_additional.conf from that table,
# so a file-only change is reverted the first time anyone opens the GUI.
#
# The add-on wrote these rows from its own env while its bundled FreePBX owned
# the PBX. Once Zeus owns the plane the *owner* has to write them: otherwise the
# recorded credentials keep pointing at the add-on's coturn (its `capstone-turn`
# user) the moment that container stops being the server on 3478, and Asterisk
# silently loses its relay. One pair — TURN_USERNAME / TURN_CREDENTIAL — is
# shared by coturn, Asterisk and both portals' browsers.
#
# The binds + HTTPTLS rows are the WSS half of the same wiring: they keep
# res_http_websocket listening on 8089 with TLS so the pjsip WSS transport
# accepts WebRTC connections after a reload. They are already what the box has,
# so this only stops a future Apply Config from undoing them.
#
# Guarded against `set -e` like the RTP write: on a first boot MariaDB may
# still be populating.
if [ -n "${TURN_USERNAME:-}" ]; then
  set +e
  # Hex-encode user/pass so quotes or slashes cannot break the SQL (FreePBX
  # stores them this way too and unhexes on read).
  _turn_user_hex="$(printf '%s' "${TURN_USERNAME:-}" | od -An -tx1 | tr -d ' \n')"
  _turn_pass_hex="$(printf '%s' "${TURN_CREDENTIAL:-}" | od -An -tx1 | tr -d ' \n')"
  mysql -u root asterisk -N -B 2>/dev/null <<SQL \
    && echo ">>> TURN plane wired: RTP/ICE via ${STUN_TURN_ADDR}, WebRTC via ${TURN_PUBLIC_URI} (user ${TURN_USERNAME})"
INSERT INTO kvstore_Sipsettings (\`key\`, val, type, id) VALUES
 ('stunaddr','${STUN_TURN_ADDR}',NULL,'noid'),
 ('turnaddr','${STUN_TURN_ADDR}',NULL,'noid'),
 ('turnusername',UNHEX('${_turn_user_hex}'),NULL,'noid'),
 ('turnpassword',UNHEX('${_turn_pass_hex}'),NULL,'noid'),
 ('webrtcstunaddr','${TURN_PUBLIC_URI}',NULL,'noid'),
 ('webrtcturnaddr','${TURN_PUBLIC_URI}',NULL,'noid'),
 ('webrtcturnusername',UNHEX('${_turn_user_hex}'),NULL,'noid'),
 ('webrtcturnpassword',UNHEX('${_turn_pass_hex}'),NULL,'noid'),
 ('wssport-0.0.0.0','8089',NULL,'noid')
ON DUPLICATE KEY UPDATE val=VALUES(val);
UPDATE kvstore_Sipsettings SET val='{"udp":{"0.0.0.0":"on"},"tcp":{"0.0.0.0":"off"},"tls":{"0.0.0.0":"off"},"ws":{"0.0.0.0":"off"},"wss":{"0.0.0.0":"on"}}' WHERE \`key\`='binds';
UPDATE freepbx_settings SET value='1' WHERE keyword='HTTPTLSENABLE' AND value!='1';
UPDATE freepbx_settings SET value='0.0.0.0' WHERE keyword='HTTPTLSBINDADDRESS' AND value!='0.0.0.0';
UPDATE freepbx_settings SET value='8089' WHERE keyword='HTTPTLSBINDPORT' AND value!='8089';
SQL
  set -e
fi

# Override AMI secret from env var if provided
if [ -n "${FREEPBX_AMI_SECRET:-}" ]; then
  sed -i "s/secret = .*/secret = ${FREEPBX_AMI_SECRET}/" /etc/asterisk/manager_custom.conf
fi

# Ensure ucp_events AMI user exists (may be missing from persisted volumes)
if ! grep -q '^\[ucp_events\]' /etc/asterisk/manager_custom.conf 2>/dev/null; then
  echo ">>> Adding missing ucp_events AMI user..."
  cat >> /etc/asterisk/manager_custom.conf <<'AMICFG'

[ucp_events]
secret = ucp_events_secret
deny = 0.0.0.0/0.0.0.0
permit = 127.0.0.1/255.255.255.255
read = system,call,log,verbose,command,agent,user,config,dtmf,reporting,cdr,dialplan,originate,message
write = system,call,log,verbose,command,agent,user,config,dtmf,reporting,cdr,dialplan,originate,message
eventfilter=!Event: RTCP*
eventfilter=!Event: VarSet
eventfilter=!Event: Newexten
AMICFG
fi

# ── AMI plane: LAN permits only (PROJECT RULE — no docker addresses) ────────
# The image ships manager_custom.conf with `permit = 172.16.0.0/255.240.0.0`
# (a docker bridge range) on every AMI user, and it only ever defines the
# [pbxportal] / [ucp_events] users. Neither is true for this stack:
#   * the portal runs with host networking and reaches AMI on this host's LAN
#     IP, so a bridge permit is dead weight that exists only to allow a Docker
#     address — exactly what the project rule forbids;
#   * the portal authenticates as FREEPBX_AMI_USER, so that section must exist
#     (a volume carried over from a differently-built image may not have it).
# Normalise every AMI user to loopback + the LAN subnet, and add the portal's
# own user when it is missing. Idempotent, so it is safe on every boot.
AMI_USER_NAME="${FREEPBX_AMI_USER:-pbxportal}"
AMI_LAN_NET="${PJSIP_LOCAL_NETS:-}"
AMI_LAN_NET="${AMI_LAN_NET%%,*}"
if [ -n "${AMI_LAN_NET}" ]; then
  AMI_LAN_NET="$(python3 -c 'import sys
n = sys.argv[1]
net, _, plen = n.partition("/")
plen = int(plen) if plen else 24
m = (0xffffffff << (32 - plen)) & 0xffffffff
print("%s/%d.%d.%d.%d" % (net, m >> 24 & 255, m >> 16 & 255, m >> 8 & 255, m & 255))' "${AMI_LAN_NET}" 2>/dev/null)"
fi
if [ -z "${AMI_LAN_NET}" ] && [[ "${STUN_HOST}" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  AMI_LAN_NET="$(printf '%s' "${STUN_HOST}" | awk -F. '{print $1"."$2"."$3".0/255.255.255.0"}')"
fi
if [ -n "${AMI_LAN_NET}" ] && [ -f /etc/asterisk/manager_custom.conf ]; then
  cp -f /etc/asterisk/manager_custom.conf /etc/asterisk/manager_custom.conf.pre-lan 2>/dev/null || true
  python3 - /etc/asterisk/manager_custom.conf "${AMI_USER_NAME}" "${FREEPBX_AMI_SECRET:-}" "${AMI_LAN_NET}" <<'PYEOF' \
    && echo ">>> AMI permits normalised: loopback + ${AMI_LAN_NET} (LAN only, no docker range)"
import re
import sys

path, user, secret, lan = sys.argv[1:5]
lines = open(path).read().split("\n")

header_re = re.compile(r"^\s*\[([^\]]+)\]\s*$")
starts = [i for i, line in enumerate(lines) if header_re.match(line)]

if not starts:
    raise SystemExit(0)

out = lines[: starts[0]]
seen = []
for pos, start in enumerate(starts):
    end = starts[pos + 1] if pos + 1 < len(starts) else len(lines)
    name = header_re.match(lines[start]).group(1)
    seen.append(name)
    body = [
        line
        for line in lines[start + 1 : end]
        if not re.match(r"^\s*(permit|deny)\s*=", line, re.I)
    ]
    if name == user and secret:
        # Keep the portal's AMI password in step with FREEPBX_AMI_SECRET. The
        # section itself was only ever created when it was missing, so rotating
        # the secret in .env left this file holding the old one and the portal
        # could not authenticate (it retried every 30s and the dashboard showed
        # "AMI Offline"). Rewriting one line on every boot is idempotent.
        body = [
            line for line in body if not re.match(r"^\s*secret\s*=", line, re.I)
        ]
        body.insert(0, "secret = " + secret)
    while body and body[-1].strip() == "":
        body.pop()
    body.append("deny = 0.0.0.0/0.0.0.0")
    body.append("permit = 127.0.0.1/255.255.255.255")
    body.append("permit = " + lan)
    out.append(lines[start])
    out.extend(body)
    out.append("")

if user not in seen:
    out.append("[" + user + "]")
    if secret:
        out.append("secret = " + secret)
    out.append("deny = 0.0.0.0/0.0.0.0")
    out.append("permit = 127.0.0.1/255.255.255.255")
    out.append("permit = " + lan)
    out.append("read = system,call,log,verbose,command,agent,user,config,dtmf,reporting,cdr,dialplan,message")
    out.append("write = system,call,log,verbose,command,agent,user,config,dtmf,reporting,cdr,dialplan,originate,message")
    out.append("")

while len(out) > 1 and out[-1].strip() == "" and out[-2].strip() == "":
    out.pop()

rendered = "\n".join(out)
# Refuse to write a file that lost a section — a half-parsed rewrite would
# take AMI (and therefore the portal) down on boot.
for name in seen:
    if "[" + name + "]" not in rendered:
        raise SystemExit("refusing to write: section %s vanished" % name)
open(path, "w").write(rendered)
PYEOF
  chown asterisk:asterisk /etc/asterisk/manager_custom.conf 2>/dev/null || true
fi

# Sync FreePBX internal AMI credentials (AMPMGRUSER/PASS) with manager.conf
# The auto-generated user in manager.conf may not match the database if
# the asterisk-config volume persisted from a different image build.
if [ -f /etc/asterisk/manager.conf ]; then
  # Extract the auto-generated 32-hex-char AMI user and its secret
  AMI_USER=$(grep -oP '(?<=\[)[0-9a-f]{32}(?=\])' /etc/asterisk/manager.conf | head -1)
  if [ -n "${AMI_USER}" ]; then
    AMI_PASS=$(sed -n "/\[${AMI_USER}\]/,/^\[/{/^secret *= */{s/[^=]*= *//p;q}}" /etc/asterisk/manager.conf)
  fi
  if [ -n "${AMI_USER}" ] && [ -n "${AMI_PASS}" ]; then
    mysql -u root asterisk -e "UPDATE freepbx_settings SET value = '${AMI_USER}' WHERE keyword = 'AMPMGRUSER'" 2>/dev/null || true
    mysql -u root asterisk -e "UPDATE freepbx_settings SET value = '${AMI_PASS}' WHERE keyword = 'AMPMGRPASS'" 2>/dev/null || true
    echo ">>> Synced FreePBX AMI credentials with manager.conf"
  fi
fi

# Ensure UCPMGRPASS actually matches the ucp_events secret in manager_custom.conf.
#
# The sed above rewrites every `secret =` line to FREEPBX_AMI_SECRET, but the
# original guard only wrote the DB value when the row was empty
# (`AND (value IS NULL OR value = '')`). On an existing MariaDB volume the two
# therefore diverge permanently: Asterisk rejects every UCP NodeJS ami login, so
# the security log fills with InvalidPassword for a loopback client and the node
# process pins a core restarting (measured on the capstone twin: 100% CPU,
# 72 restarts). Converge on the secret that is really in manager_custom.conf and
# bounce UCP only when it actually changed — no churn on every boot.
UCP_SECRET="$(awk '/^\[ucp_events\]/{f=1} f && /^secret[[:space:]]*=/{sub(/^[^=]*=[[:space:]]*/, ""); print; exit}' /etc/asterisk/manager_custom.conf 2>/dev/null)"
# The secret is base64/hex in every shipped .env; reject anything that could
# break out of the single-quoted SQL below.
case "${UCP_SECRET}" in
  *[!A-Za-z0-9+/=_-]*) UCP_SECRET="" ;;
esac
if [ -n "${UCP_SECRET}" ]; then
  UCP_CURRENT="$(mysql -u root asterisk -N -B -e 'SELECT value FROM freepbx_settings WHERE keyword="UCPMGRPASS" LIMIT 1;' 2>/dev/null)"
  if [ "${UCP_CURRENT}" != "${UCP_SECRET}" ]; then
    mysql -u root asterisk -e "UPDATE freepbx_settings SET value = '${UCP_SECRET}' WHERE keyword = 'UCPMGRPASS';" 2>/dev/null || true
    echo ">>> UCP AMI credential converged (ucp_events) — restarting ucp node"
    fwconsole pm2 --restart ucp >/dev/null 2>&1 || true
  fi
fi

# Register OAuth2 client for the portal (if API module is installed)
# Always updates the client_secret so that FREEPBX_CLIENT_SECRET changes take
# effect on restart without needing to manually fix the database.
#
# NOTE: this runs as a heredoc-written PHP file, NOT an inline `php -r "..."`.
# An inline double-quoted string breaks the moment the PHP code contains a
# literal double quote (it prematurely closes the shell string and mangles
# the braces) — which is exactly what used to happen here.
if [ -n "${FREEPBX_CLIENT_ID:-}" ] && [ -n "${FREEPBX_CLIENT_SECRET:-}" ]; then
  echo ">>> Registering OAuth2 client '${FREEPBX_CLIENT_ID}'..."
  cat > /tmp/register_oauth.php <<'PHPEOF'
<?php
$db = new PDO('mysql:host=localhost;dbname=asterisk', 'root', '');
$db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$clientId = getenv('FREEPBX_CLIENT_ID');
$clientSecret = getenv('FREEPBX_CLIENT_SECRET');
if ($clientId === false || $clientSecret === false) {
  fwrite(STDERR, "Missing FREEPBX_CLIENT_ID/SECRET env vars\n");
  exit(1);
}
$secretHash = hash('sha256', $clientSecret);
// Check if client already exists
$stmt = $db->prepare('SELECT id FROM api_applications WHERE client_id = ?');
$stmt->execute([$clientId]);
$existing = $stmt->fetch(PDO::FETCH_ASSOC);
if (!$existing) {
  $stmt = $db->prepare(
    'INSERT INTO api_applications (owner, name, description, grant_type, client_id, client_secret, redirect_uri, website, algo, allowed_scopes)
     VALUES (NULL, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)'
  );
  // NOTE: allowed_scopes MUST stay empty (''). ScopeRepository treats
  // empty as "no restrictions" and grants ['gql','rest'], which unlocks
  // the full GraphQL schema (extensions/voicemail/...). A non-empty but
  // invalid value like 'all' silently produces tokens with NO scopes,
  // which collapses the schema to just the 'node' field.
  $stmt->execute([
    'PBX Portal API',
    'PBX Customer Portal integration client',
    'client_credentials',
    $clientId,
    $secretHash,
    'sha256',
    ''
  ]);
  echo 'OAuth2 client registered.' . PHP_EOL;
} else {
  // Update existing client secret + scopes to match current env var
  $stmt = $db->prepare('UPDATE api_applications SET client_secret = ?, algo = ?, allowed_scopes = ? WHERE client_id = ?');
  $stmt->execute([$secretHash, 'sha256', '', $clientId]);
  echo 'OAuth2 client secret + scopes updated.' . PHP_EOL;
}
PHPEOF
  php /tmp/register_oauth.php 2>/dev/null || echo 'WARNING: Could not register OAuth2 client (API module may not be installed yet)'
fi

# Start Redis (FreePBX 17 cache/session)
service redis-server start 2>/dev/null || true

# Start cron (FreePBX schedules module/cleanup jobs via crontab)
service cron start 2>/dev/null || true

# Start Postfix (mailq, voicemail-to-email, fax notifications)
service postfix start 2>/dev/null || true
echo ">>> Postfix started"

# Start Webmin (server admin panel on port 10000)
service webmin start 2>/dev/null || echo ">>> WARNING: Webmin failed to start"

# ── AvantFax setup ─────────────────────────────────────────────
# Ensure the fax symlink exists (may be hidden by persistent volume)
if [ ! -L /var/www/html/fax ] && [ -d /usr/src/avantfax/avantfax ]; then
  ln -sf /usr/src/avantfax/avantfax /var/www/html/fax
  echo ">>> AvantFax symlink repaired"
fi

AVANTFAX_DB_PASS="${AVANTFAX_DB_PASS:-$(openssl rand -hex 8)}"
echo ">>> Setting up AvantFax database..."

# Create avantfax DB user and database.
# The ALTER is not redundant: when the password is generated (no
# AVANTFAX_DB_PASS in the environment) it differs on every boot, while CREATE
# USER IF NOT EXISTS leaves an existing user's password alone. The config below
# is rewritten to the new value every time, so without the ALTER the DB user
# and local_config.php drift apart on the first restart and every AvantFax page
# answers /no-database.php — which is exactly what this host was doing.
# Reconciling instead of only creating keeps the pair consistent whether the
# password is pinned or regenerated.
mysql -u root <<SQL 2>/dev/null
CREATE DATABASE IF NOT EXISTS avantfax;
CREATE USER IF NOT EXISTS 'avantfax'@'localhost' IDENTIFIED BY '${AVANTFAX_DB_PASS}';
ALTER USER 'avantfax'@'localhost' IDENTIFIED BY '${AVANTFAX_DB_PASS}';
GRANT ALL PRIVILEGES ON avantfax.* TO 'avantfax'@'localhost';
FLUSH PRIVILEGES;
SQL

# Import AvantFax schema if tables don't exist
if [ -f /var/www/html/fax/includes/create_tables.sql ]; then
  TABLE_COUNT=$(mysql -u root -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='avantfax'" 2>/dev/null || echo 0)
  if [ "$TABLE_COUNT" = "0" ]; then
    mysql -u root avantfax < /var/www/html/fax/includes/create_tables.sql 2>/dev/null || true
    echo ">>> AvantFax tables created"
  fi
fi

# Replace DB password placeholder in local_config.php
if [ -f /var/www/html/fax/includes/local_config.php ]; then
  sed -i "s/define('AFDB_PASS',.*/define('AFDB_PASS',     '${AVANTFAX_DB_PASS}');/" /var/www/html/fax/includes/local_config.php
  sed -i "s/define('ADMIN_EMAIL',.*/define('ADMIN_EMAIL', '${FAX_EMAIL:-fax@zeus.innotel.us}');/" /var/www/html/fax/includes/local_config.php
  sed -i "s|AVANTFAX_HOSTNAME|${HOSTNAME:-fax.zeus.innotel.us}|g" /var/www/html/fax/includes/local_config.php
fi

# Import AvantFax user SQL if available
if [ -f /var/www/html/fax/includes/create_user.sql ]; then
  mysql -u root avantfax < /var/www/html/fax/includes/create_user.sql 2>/dev/null || true
fi

# ── Fax stack services (HylaFAX+ + IAXModem) ──────────────────
echo ">>> Starting fax stack..."

# Fix IAX calltoken (the image layer may be cached without requirecalltoken=no)
# Use calltokenoptional in [general] — simpler than per-peer sed
if [ -f /etc/asterisk/iax.conf ]; then
  if ! grep -q 'calltokenoptional' /etc/asterisk/iax.conf; then
    sed -i '/^\[general\]/a calltokenoptional = 127.0.0.1/255.255.255.255' /etc/asterisk/iax.conf
    echo ">>> IAX calltoken fix applied (iax.conf general)"
  fi
fi
# Also fix iax_custom.conf if it exists
if [ -f /etc/asterisk/iax_custom.conf ]; then
  if ! grep -q 'calltokenoptional' /etc/asterisk/iax_custom.conf; then
    sed -i '/^\[general\]/a calltokenoptional = 127.0.0.1/255.255.255.255' /etc/asterisk/iax_custom.conf 2>/dev/null || true
  fi
fi

# Initialize HylaFAX spool (first-run only — idempotent)
if [ -f /usr/local/sbin/faxsetup ]; then
  if [ ! -f /var/spool/hylafax/etc/setup.cache ]; then
    yes '' | /usr/local/sbin/faxsetup -server 2>/dev/null || true
    echo ">>> HylaFAX spool initialized"
  fi
fi

# Create HylaFAX admin user if not exists
if [ -f /usr/local/sbin/faxadduser ]; then
  faxdeluser localhost 2>/dev/null || true
  faxdeluser 127.0.0.1 2>/dev/null || true
  echo "${AVANTFAX_DB_PASS}" | faxadduser -a admin "${AVANTFAX_DB_PASS}" 2>/dev/null || true
  echo ">>> HylaFAX admin user created"
fi

# Ensure HylaFAX spool dirs exist and are writable by uucp group (asterisk is in uucp)
mkdir -p /var/spool/hylafax/sendq /var/spool/hylafax/doneq /var/spool/hylafax/docq
chown -R uucp:uucp /var/spool/hylafax/sendq /var/spool/hylafax/doneq /var/spool/hylafax/docq 2>/dev/null || true
chmod -R 770 /var/spool/hylafax/sendq /var/spool/hylafax/doneq /var/spool/hylafax/docq 2>/dev/null || true

# Start hfaxd (HylaFAX client daemon) — runs as uucp like other fax services
# The systemd unit uses Type=forking with ExecStart=/usr/local/sbin/hfaxd -i hylafax
if [ -f /usr/local/sbin/hfaxd ]; then
  [ -p /var/spool/hylafax/FIFO ] || /usr/sbin/mkfifo /var/spool/hylafax/FIFO 2>/dev/null || true
  chown uucp:uucp /var/spool/hylafax/FIFO 2>/dev/null || true
  chown -R uucp:uucp /var/spool/hylafax 2>/dev/null || true
  chmod 644 /var/spool/hylafax/etc/hosts.hfaxd 2>/dev/null || true
  # Start hfaxd — drop to uucp if possible, otherwise run as root
  if su -s /bin/sh uucp -c 'true' 2>/dev/null; then
    su -s /bin/sh uucp -c '/usr/local/sbin/hfaxd -i hylafax' > /dev/null 2>&1 &
  else
    /usr/local/sbin/hfaxd -i hylafax > /dev/null 2>&1 &
  fi
  sleep 2
  # shellcheck disable=SC2009 # ps|grep pid check (intentional, [h] trick)
  if ps aux | grep -v grep | grep -q '[h]faxd'; then
    echo ">>> hfaxd is running (uucp)"
  else
    echo ">>> WARNING: hfaxd failed to start"
  fi
fi

# Start faxq (HylaFAX queue scheduler)
if [ -f /usr/local/sbin/faxq ]; then
  /usr/local/sbin/faxq &
  sleep 1
  echo ">>> faxq started"
fi

# Start IAXmodem + faxgetty for each virtual modem
FAX_NUMBER="${FAX_NUMBER:-7745057136}"
for N in 1 2 3 4; do
  # Create device node if missing
  if [ ! -c /dev/ttyIAX${N} ]; then
    mknod /dev/ttyIAX${N} c 240 ${N} 2>/dev/null || true
  fi
  # Start IAXmodem (IAX → serial bridge)
  if [ -f /usr/local/sbin/iaxmodem ] && [ -f /etc/iaxmodem/ttyIAX${N} ]; then
    /usr/local/sbin/iaxmodem ttyIAX${N} &
  fi
  # Start faxgetty (monitors modem line for incoming faxes)
  if [ -f /usr/local/sbin/faxgetty ] && [ -f /var/spool/hylafax/etc/config.ttyIAX${N} ]; then
    /usr/local/sbin/faxgetty ttyIAX${N} &
  fi
done
echo ">>> Fax modems started (ttyIAX1-4)"

# ── Start PHP-FPM (both versions) ────────────────────────────
service php8.2-fpm start
service php7.4-fpm start 2>/dev/null || echo ">>> PHP 7.4 FPM not available (AvantFax won't work)"

# ── Start UCP Node daemon (User Control Panel for WebRTC) ────
if [ -f /var/www/html/admin/modules/ucp/node/node_modules/.package-lock.json ] 2>/dev/null || [ -d /var/www/html/admin/modules/ucp/node ]; then
  fwconsole start ucp 2>/dev/null || echo ">>> WARNING: UCP daemon failed to start"
  echo ">>> UCP Node started"
fi

# ── Start Asterisk BEFORE the web UI ────────────────────────
# The FreePBX web UI (Apache) must not come up until Asterisk is
# ready. Otherwise an "Apply Config" click during the first seconds
# after boot triggers a reload against a dead Asterisk control socket
# and fails with "Unable to connect to remote asterisk (does
# /var/run/asterisk/asterisk.ctl exist?)" — surfaced by the GUI as
# "Unknown Error. Please Run: fwconsole reload --verbose".
#
# Start Asterisk in the background, wait for its CLI to answer, and
# only then expose the web UI.
echo ">>> Starting Asterisk (before web UI)..."
asterisk -f &
ASTERISK_PID=$!

# Forward SIGTERM/SIGINT to Asterisk and block until it has finished
# shutting down. Asterisk is no longer PID 1, so `docker stop` would
# otherwise tear the container down (SIGKILL) before Asterisk can
# gracefully hang up channels.
trap 'kill -TERM "$ASTERISK_PID" 2>/dev/null; wait "$ASTERISK_PID" 2>/dev/null' TERM INT

# Guard against a non-numeric override killing the deadline arithmetic.
ASTERISK_READY_TIMEOUT="${ASTERISK_READY_TIMEOUT:-120}"
case "$ASTERISK_READY_TIMEOUT" in
  ''|*[!0-9]*) ASTERISK_READY_TIMEOUT=120 ;;
esac
ASTERISK_READY_DEADLINE=$(( $(date +%s) + ASTERISK_READY_TIMEOUT ))

# Wait until `asterisk -rx` answers (asterisk.ctl exists). Bail early
# if Asterisk dies outright; otherwise fail open after the timeout so
# a hung boot doesn't take the web UI down too.
START_WEB_UI=1
until asterisk -rx 'core show version' >/dev/null 2>&1; do
  if ! kill -0 "$ASTERISK_PID" 2>/dev/null; then
    echo ">>> ERROR: Asterisk exited before becoming ready — skipping web UI start"
    START_WEB_UI=0
    break
  fi
  if [ "$(date +%s)" -ge "$ASTERISK_READY_DEADLINE" ]; then
    echo ">>> WARNING: Asterisk not ready after ${ASTERISK_READY_TIMEOUT}s — starting web UI anyway"
    echo ">>>          Check: docker logs pbx-freepbx | tail -100  (or /var/log/asterisk/full)"
    break
  fi
  sleep 2
done

# ── Blacklist destination (Terminate Call: Hangup) ────────────
# FreePBX's Blacklist module routes blacklisted callers to a destination it
# keeps in Asterisk's AstDB (family `blacklist`, key `dest`). Its default lives
# inside install() — `if (astman->connected() && empty(destinationGet()))
# destinationSet('app-blackhole,hangup,1');` — and install() does not run again
# on an already-installed module, so a PBX that never had the value seeded ships
# EMPTY. System Status reports
#
#   DEST STATUS: EMPTY   Blacklist: Destination for BlackListed Calls
#
# and a blacklisted caller falls through to a normal route instead of being
# hung up. AstDB is not on a volume here (only `/var/lib/asterisk/sounds` is),
# so `astdb.sqlite3` sits in the container's writable layer and every recreate
# starts it empty — the status simply comes back. Re-assert the destination on
# boot, once Asterisk answers, so it is a property of the stack rather than of
# one container's filesystem. Idempotent, and overridable for a PBX that should
# route blacklisted calls somewhere else.
BLACKLIST_DESTINATION="${BLACKLIST_DESTINATION:-app-blackhole,hangup,1}"

write_blacklist_destination() {
  local current
  current=$(asterisk -rx 'database get blacklist dest' 2>/dev/null \
    | sed -n 's/^Value: //p' | tr -d '\r' || true)
  if [ "$current" = "$BLACKLIST_DESTINATION" ]; then
    echo ">>> [blacklist] destination already '${BLACKLIST_DESTINATION}'"
    return 0
  fi
  if asterisk -rx "database put blacklist dest ${BLACKLIST_DESTINATION}" >/dev/null 2>&1; then
    echo ">>> [blacklist] destination set to '${BLACKLIST_DESTINATION}' (was '${current:-<empty>}')"
  else
    echo ">>> WARNING: could not set the blacklist destination in AstDB"
  fi
  return 0
}

write_blacklist_destination

# ── Cloudonix SIP peering ─────────────────────────────────────
# Applied from the repo-mounted script (docker-compose.full.yml mounts the
# repo's pbx/ at /opt/zeus/pbx) so a SIP peer lives beside the other PBX
# fragments and can be changed without rebuilding this image. Idempotent, and
# a no-op unless CLOUDONIX_* is configured. PBX_CONTAINER is deliberately
# empty: we ARE the PBX, so the script writes into this container's
# /etc/asterisk directly instead of shelling out to docker.
if [ -n "${CLOUDONIX_SIP_ENABLED:-}${CLOUDONIX_SIP_USER:-}${CLOUDONIX_DIDS:-}" ] && \
   [ -x /opt/zeus/pbx/setup-cloudonix-trunk.sh ]; then
  PBX_CONTAINER='' bash /opt/zeus/pbx/setup-cloudonix-trunk.sh || \
    echo ">>> WARNING: Cloudonix trunk setup failed — see output above"
fi

# ── Asterisk watchdog ─────────────────────────────────────────
# If the Asterisk control socket disappears while the container is
# still up (crash, hang, or a stuck Apply Config), every FreePBX
# operation fails with "Unknown Error. Please Run: fwconsole
# reload --verbose". Poll for the control socket and run
# `fwconsole reload` to self-heal. Tune with:
#   ASTERISK_WATCHDOG_INTERVAL  (default 30s)  poll cadence
#   ASTERISK_WATCHDOG_COOLDOWN  (default 60s)  pause after a reload
asterisk_watchdog() {
  # ASTERISK_CTL_FILE overrides the socket path (test hook)
  local ctl_file="${ASTERISK_CTL_FILE:-/var/run/asterisk/asterisk.ctl}"
  local interval="${ASTERISK_WATCHDOG_INTERVAL:-30}"
  local cooldown="${ASTERISK_WATCHDOG_COOLDOWN:-60}"
  # Guard against non-numeric or too-small overrides: a 0 would busy-loop
  case "$interval" in ''|*[!0-9]*) interval=30 ;; esac
  case "$cooldown" in ''|*[!0-9]*) cooldown=60 ;; esac
  if [ "$interval" -lt 5 ]; then interval=5; fi
  if [ "$cooldown" -lt 10 ]; then cooldown=10; fi
  while true; do
    sleep "$interval"
    # If the main Asterisk process is gone the entrypoint's `wait` is
    # about to return and Docker will restart the container — nothing
    # for the watchdog to do.
    if ! kill -0 "$ASTERISK_PID" 2>/dev/null; then exit 0; fi
    if [ ! -S "$ctl_file" ]; then
      echo ">>> [watchdog] $(date -u +'%Y-%m-%dT%H:%M:%SZ') Asterisk control socket missing — running 'fwconsole reload'"
      if fwconsole reload >/tmp/fwconsole-watchdog-reload.log 2>&1; then
        echo ">>> [watchdog] fwconsole reload completed"
      else
        echo ">>> [watchdog] fwconsole reload FAILED — see /tmp/fwconsole-watchdog-reload.log"
      fi
      sleep "$cooldown"
    fi
  done
}

# ── FreePBX module repair ────────────────────────────────────
# After Asterisk restarts, FreePBX can detect version mismatches and
# disable critical modules (surfacing in the UI as "Unknown Error.
# Please Run: fwconsole reload --verbose"). Refreshing signatures
# can itself trigger that disable when the module registry drifts
# from the files on disk, so instead we detect disabled modules and
# reinstall them — `--force` re-registers the DB at the version the
# files are actually at. Healthy boots skip this entirely. Needs
# internet to re-download; on failure it logs a warning and boot
# continues (fail open).
repair_disabled_modules() {
  echo ">>> Checking for disabled FreePBX modules..."
  local pass=1 mod list_output disabled remaining format_mismatch=0
  while [ "$pass" -le 2 ]; do
    # `timeout` bounds the boot delay when the module server is unreachable
    # (fail open). `|| true` keeps the assignment from tripping `set -e`.
    list_output=$(timeout 30 fwconsole ma list 2>/dev/null || true)
    # A real `ma list` always prints the full table, so empty output means
    # the command failed/timed out — don't claim the system is healthy.
    if [ -z "$list_output" ]; then
      echo ">>> [modules] module check skipped — fwconsole ma list unreachable (offline?)"
      return
    fi
    disabled=$(printf '%s\n' "$list_output" | awk -F'|' '/Disabled/{gsub(/[[:space:]]/,"",$2); if ($2 != "") print $2}')
    if printf '%s\n' "$list_output" | grep -q 'Disabled' && [ -z "$(printf '%s' "$disabled" | tr -d '[:space:]')" ]; then
      echo ">>> [modules] WARNING: disabled modules listed but none parsed — fwconsole ma list format changed?"
      format_mismatch=1
      break
    fi
    if [ -z "$disabled" ]; then
      break
    fi
    echo ">>> [modules] pass $pass: $(echo "$disabled" | wc -l) disabled — $(echo "$disabled" | tr '\n' ' ')"
    # while-read avoids `for $disabled` glob-expanding module names
    printf '%s\n' "$disabled" | while IFS= read -r mod; do
      [ -z "$mod" ] && continue
      if timeout 180 fwconsole ma install "$mod" --force >/tmp/fwconsole-module-repair.log 2>&1 \
        && grep -q 'successfully installed' /tmp/fwconsole-module-repair.log; then
        echo ">>> [modules] $mod repaired"
      else
        echo ">>> [modules] $mod not repaired — see /tmp/fwconsole-module-repair.log"
      fi
    done
    pass=$((pass + 1))
  done
  if [ "$format_mismatch" = "1" ]; then
    return
  fi
  remaining=$(timeout 30 fwconsole ma list 2>/dev/null | awk -F'|' '/Disabled/{gsub(/[[:space:]]/,"",$2); if ($2 != "") print $2}')
  if [ -n "$remaining" ]; then
    echo ">>> [modules] WARNING: still disabled after repair: $(echo "$remaining" | tr '\n' ' ')"
    echo ">>> [modules] fix manually: fwconsole ma install <module> --force (needs internet)"
  else
    echo ">>> [modules] all modules enabled"
  fi
}

# ── FreePBX API module patches ──────────────────────────────
# The Dockerfile bakes two fixes into the api module's image layer, but
# the freepbx-www volume shadows the image AND a module repair
# (`fwconsole ma install api --force`) re-downloads the upstream module,
# wiping them. Re-apply idempotently at every boot so the portal's
# GraphQL calls keep working. Missing patches: the portal's gql() request
# (no ?route= param) crashes the endpoint with "Undefined array key
# \"route\"" at Gql/Api.php, which surfaces to the user as a broken
# extensions feature.
patch_api_module() {
  local api_dir=/var/www/html/admin/modules/api
  [ -d "$api_dir" ] || return 0

  # Fix 1: getFlattenedScopes() crashes when a scope module (e.g.
  # "framework") is not in $activeModules — add a guard to skip it.
  #
  # History: the original sed `a\`-continuation append lost its leading
  # tab, writing a stray `t\t\t...if` line into Api.class.php — a PHP parse
  # error that broke fwconsole chown/reload on every boot. The patch is now
  # corruption-tolerant: strip any malformed guard lines first, then apply
  # the guard with perl (no shell-quoting sed continuations) only when the
  # well-formed guard is absent.
  if [ -f "$api_dir/Api.class.php" ]; then
    # Repair earlier corruption: a guard line starting with `t` before the
    # tabs (the mangled remains of the old append) — with tab or literal-t
    # variants — and duplicate/extra guards beyond the first.
    # shellcheck disable=SC2016  # PHP pattern: \$module etc. must stay literal for grep/sed -E
    if grep -qE '^t+\t+if \(!isset\(\$activeModules\[\$module\]\)\)' "$api_dir/Api.class.php"; then
      sed -i -E 's/^t+\t+(\tif \(!isset\(\$activeModules\[\$module\]\)\) \{ continue; \})$/\t\t\t\t\t\1/' "$api_dir/Api.class.php"
      echo ">>> [api] repaired mangled guard line(s) in Api.class.php"
    fi
    # Deduplicate: keep only the first well-formed guard after the foreach.
    # shellcheck disable=SC2016  # literal PHP fragment for grep -cF / awk matching
    if [ "$(grep -cF 'if (!isset($activeModules[$module])) { continue; }' "$api_dir/Api.class.php")" -gt 1 ]; then
      awk '
        /^\t{5}if \(!isset\(\$activeModules\[\$module\]\)\) \{ continue; \}\)$/ { c++ }
        c > 1 { next }
        { print }
      ' "$api_dir/Api.class.php" > "$api_dir/Api.class.php.tmp" &&
        mv "$api_dir/Api.class.php.tmp" "$api_dir/Api.class.php"
      echo ">>> [api] deduplicated guard lines in Api.class.php"
    fi
    # shellcheck disable=SC2016  # literal PHP guard for grep -qF / perl -pe insertion
    if ! grep -qF 'if (!isset($activeModules[$module])) { continue; }' "$api_dir/Api.class.php"; then
      perl -i -pe '
        s{^(\t+foreach \(\$validScopes\[\$type\] as \$module => \$scope\) \{)$}
          {$1\n\t\t\t\t\tif (!isset(\$activeModules[\$module])) { continue; }}
      ' "$api_dir/Api.class.php"
      echo ">>> [api] Fix 1 applied — getFlattenedScopes guard (Api.class.php)"
    fi
    php -l "$api_dir/Api.class.php" >/dev/null 2>&1 \
      || echo ">>> [api] WARNING: Api.class.php still fails php -l — check manually"
  fi

  # Fix 2: Gql/Api.php crashes on undefined $_GET['route'] (the portal's
  # gql() call sends no route param). Null-coalesce the bare access.
  if [ -f "$api_dir/Gql/Api.php" ] && \
     grep -q "&route=' \. \$_GET\['route'\]" "$api_dir/Gql/Api.php"; then
    sed -i "s|\$_GET\['route'\]|(\$_GET['route'] ?? '')|g" "$api_dir/Gql/Api.php"
    echo ">>> [api] Fix 2 applied — Gql \$_GET['route'] null-coalescing"
  fi
}

# ── Core module: trunk id picker + PJSIP write ──────────────────────────────
# Two bugs in the core module, in the class that saves trunks through the GUI:
#
#  1. Core::addTrunk picks a new trunk's id by scanning the sorted existing ids
#     against a counter starting at 1. This stack has a trunk with id 0 (the
#     `custom` VoIP.ms trunk), so the scan breaks on its first iteration and
#     every new trunk is handed id 1 — whatever already holds it.
#  2. PJSip::addTrunk is a complete settings write (one INSERT per keyword) but
#     never clears what is already stored under that id, and the caller only
#     deletes for the technology recorded in `trunks.tech`. A trunk whose
#     stored technology disagrees with the rows actually present (the usual
#     result of switching tech) therefore collides on every save.
#
# Together they surface as "SQLSTATE[23000]: Duplicate entry '1-maxchans' for
# key 'PRIMARY'" and make trunks unsaveable. Both live in files FreePBX ships,
# not in this repo, so they are re-applied on every boot: an image refresh, or
# a `fwconsole ma install core` that restores the shipped module, would revert
# them. The patcher is idempotent and refuses to touch a file it does not
# recognise rather than guessing. Fail open — a PBX that boots with the bug is
# better than one that does not boot.
patch_core_trunk_write() {
  local patcher=/usr/local/bin/patch-freepbx-trunk-next-id.py
  if [ ! -f "$patcher" ]; then
    echo ">>> [core] patcher not in image — skipping (trunk saves may fail)"
    return 0
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    echo ">>> [core] no python3 — skipping (trunk saves may fail)"
    return 0
  fi
  local out rc
  out=$(timeout 60 python3 "$patcher" 2>&1); rc=$?
  # Exit 1 means the module did not look like the version this patch was
  # written for; 2 means it could not read/back up the file. Both are worth
  # shouting about but neither may block the boot.
  printf '%s\n' "$out" | sed 's/^/>>> [core] /'
  if [ "$rc" -ne 0 ]; then
    echo ">>> [core] WARNING: trunk patch NOT applied (rc=$rc) — trunk saves may fail"
  fi
  return 0
}

if [ "$START_WEB_UI" = "1" ]; then
  echo ">>> Asterisk is ready — starting web UI..."

  # ── WebRTC WSS Transport Setup ─────────────────────────────
  # FreePBX generates http_additional.conf with bindaddr=127.0.0.1:8088
  # and tlsbindaddr=127.0.0.1:8089. Fix both to 0.0.0.0 for external access.
  # Port 8088 (plain HTTP) is used when Nginx Proxy Manager terminates TLS
  # and forwards WebSocket connections. Port 8089 (HTTPS) is used for
  # direct WSS connections (self-signed cert).
  if [ -f /etc/asterisk/http_additional.conf ]; then
    sed -i 's/^bindaddr=127.0.0.1/bindaddr=0.0.0.0/' \
      /etc/asterisk/http_additional.conf 2>/dev/null || true
    sed -i 's/tlsbindaddr=127.0.0.1:8089/tlsbindaddr=0.0.0.0:8089/' \
      /etc/asterisk/http_additional.conf 2>/dev/null || true
  fi

  # ── Regenerate self-signed TLS cert with correct SANs ──────
  # The default cert from the base image has CN=buildkitsandbox — browsers
  # reject it for WebRTC WebSocket connections. Regenerate with the actual
  # hostname and LAN IP so `wss://` works from local browsers.
  CERT_FILE=/etc/asterisk/keys/integration/certificate.pem
  # NB: not `grep -o 'CN = [^,\n]*'`. Inside a bracket expression `\n` is the
  # two characters `\` and `n`, not a newline, so that pattern also stopped at
  # the first literal "n" and read this cert's CN as "buildkitsa" — never equal
  # to "buildkitsandbox", so the regeneration below never ran and every
  # browser kept rejecting the WSS handshake on the base image's throwaway
  # cert. Strip the `subject=` prefix, then take CN up to the next comma.
  CERT_SUBJECT=$(openssl x509 -in "$CERT_FILE" -noout -subject 2>/dev/null \
    | sed -E 's/^subject=//; s/.*CN *= *([^,]+).*/\1/' | tr -d ' ')
  if [ "$CERT_SUBJECT" = "buildkitsandbox" ] || [ ! -f "$CERT_FILE" ]; then
    echo ">>> Regenerating self-signed TLS cert with proper SANs..."
    HOSTNAME_VAL="${HOSTNAME:-pbx.zeus.innotel.us}"
    # Build SAN list with all expected hostnames
    SAN_LIST="DNS:${HOSTNAME_VAL},DNS:pbx.zeus.innotel.us,DNS:app.zeus.innotel.us,DNS:ws.zeus.innotel.us,DNS:freepbx"
    SAN_LIST="${SAN_LIST},IP:127.0.0.1"

    mkdir -p /etc/asterisk/keys/integration
    openssl req -x509 -newkey rsa:2048 \
      -keyout /etc/asterisk/keys/integration/webserver.key \
      -out /etc/asterisk/keys/integration/webserver.crt \
      -days 3650 -nodes \
      -subj "/CN=${HOSTNAME_VAL}" \
      -addext "subjectAltName=${SAN_LIST}" 2>/dev/null
    cp /etc/asterisk/keys/integration/webserver.crt "$CERT_FILE"
    chown asterisk:asterisk /etc/asterisk/keys/integration/*
    chmod 600 /etc/asterisk/keys/integration/webserver.key
    echo ">>> TLS cert regenerated for CN=${HOSTNAME_VAL} SANs=${SAN_LIST}"
  fi

  # Ensure PJSIP WSS transport config exists for WebRTC softphone
  if [ ! -f /etc/asterisk/pjsip_wss.conf ]; then
    cat > /etc/asterisk/pjsip_wss.conf <<'WSSEOF'
[transport-wss]
type = transport
protocol = wss
bind = 0.0.0.0:8089

[webrtc-template](!)
type = endpoint
transport = transport-wss
context = from-internal
disallow = all
allow = ulaw,alaw,opus,gsm,g722
webrtc = yes
dtls_auto_generate_cert = yes
use_avpf = yes
media_encryption = dtls
ice_support = yes
direct_media = no
dtmf_mode = rfc4733
force_rport = yes
rewrite_contact = yes
rtp_symmetric = yes
WSSEOF
    grep -q 'pjsip_wss.conf' /etc/asterisk/pjsip.conf 2>/dev/null || \
      echo '#include pjsip_wss.conf' >> /etc/asterisk/pjsip.conf
  fi

  # WSS endpoints are provisioned by the portal container via its
  # /api/phone/extensions API (writes PJSIP configs to shared volume).
  # Asterisk restart picks up HTTP bind + WSS transport + new cert.
  asterisk -rx 'core restart now' 2>/dev/null || true
  sleep 3

  # ── FreePBX module persistence ────────────────────────────
  # Repair any modules FreePBX disabled due to version drift, then
  # reload so the web UI comes up in a clean state.
  repair_disabled_modules
  # Module repair may have re-downloaded the api module, wiping the
  # image-baked patches — re-apply them so the portal's GraphQL API
  # (extensions/voicemail provisioning) keeps working.
  patch_api_module
  # Same reasoning for core: a module reinstall restores the shipped trunk
  # code, which makes every trunk save fail with a duplicate-key error.
  patch_core_trunk_write
  # The voice-plane FreePBX module is deleted (see docs/unified-console.md §5),
  # so there is nothing to converge here. A host that still carries it from an
  # older image keeps it until someone runs `fwconsole ma uninstall voiceplane`
  # and `fwconsole ma delete voiceplane` on it — the module owns no data.
  # ── fwconsole chown on init ────────────────────────────────
  # File ownership across the freepbx-www volume drifts whenever the
  # volume outlives the container (image upgrades, module reinstalls,
  # manual fixes). Without it the web UI's reload button silently
  # fails and `fwconsole restart` misbehaves — FreePBX's own chown
  # hook (`Chown->fwcChownFiles`) also runs every module's
  # `chownFreepbx` handler, which is what fixes those up. Run it on
  # every boot, before Apache starts; fail open so a chown problem
  # can never block the PBX from coming up.
  ensure_fwconsole
  echo ">>> Fixing FreePBX file permissions (fwconsole chown)..."
  if timeout 180 fwconsole chown >/tmp/fwconsole-boot-chown.log 2>&1; then
    echo ">>> fwconsole chown completed"
  else
    echo ">>> WARNING: fwconsole chown failed — see /tmp/fwconsole-boot-chown.log (continuing)"
  fi
  # The chown rewrites mode bits across /var/lib/asterisk/bin (644 for files)
  # and only restores the launcher's +x at the very end of its own run, so an
  # aborted one leaves fwconsole non-executable and every later call in this
  # boot dies with a bare "Permission denied" — which is how "chown failed" and
  # "boot reload failed" show up together on a PBX that otherwise looks fine.
  ensure_fwconsole
  if ! fwconsole reload >/tmp/fwconsole-boot-reload.log 2>&1; then
    echo ">>> [modules] boot reload failed — see /tmp/fwconsole-boot-reload.log"
  fi
  echo ">>> FreePBX modules refreshed"

  # Re-assert the RTP plane after the boot reload. The `fwconsole reload` above
  # just regenerated rtp_additional.conf from kvstore_Sipsettings and the core
  # module template can re-add a duplicate include to rtp.conf — rewrite the
  # canonical file + include hygiene, then reload once more so the running
  # Asterisk actually loads the regenerated range (the reload above wrote the
  # file, but Asterisk still holds the previous rtpstart/rtpend).
  write_rtp_plane
  fwconsole reload >/tmp/fwconsole-rtp-reload.log 2>&1 || true

  # Start Apache in background (web UI is now safe to trigger reloads)
  apache2ctl -D FOREGROUND &

  # Start the Asterisk watchdog — it only matters once the web UI is
  # up, since that's when a dropped control socket surfaces as Apply
  # Config "Unknown Error" failures.
  asterisk_watchdog &
fi

# Keep the container alive as long as Asterisk runs (matches the old
# `exec asterisk -f` behavior — the container exits if Asterisk dies).
wait "$ASTERISK_PID"
