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
# Override the STUN/TURN address with PJSIP_STUN_TURN_ADDR — required on
# bare-metal or single-host installs where the `coturn` compose alias does not
# resolve (set it to the TURN host, e.g. 127.0.0.1; do NOT use
# host.docker.internal, ast_sockaddr_resolve fails on that alias and silently
# disables STUN).
ASTERISK_ETC="/etc/asterisk"
RTP_START="${FREEPBX_RTP_PORT_START:-10101}"
RTP_END="${FREEPBX_RTP_PORT_END:-10120}"
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

# Create avantfax DB user and database
mysql -u root <<SQL 2>/dev/null
CREATE DATABASE IF NOT EXISTS avantfax;
CREATE USER IF NOT EXISTS 'avantfax'@'localhost' IDENTIFIED BY '${AVANTFAX_DB_PASS}';
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
