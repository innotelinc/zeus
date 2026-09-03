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
read = system,call,log,verbose,command,agent,user,config,dtmf,reporting,cdr,dialplan,originate
write = system,call,log,verbose,command,agent,user,config,dtmf,reporting,cdr,dialplan,originate
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

# Ensure UCPMGRPASS matches the ucp_events secret in manager_custom.conf
# The sed above may have changed it to FREEPBX_AMI_SECRET, so use that if set.
UCP_AMI_SECRET="${FREEPBX_AMI_SECRET:-ucp_events_secret}"
mysql -u root asterisk -e "UPDATE freepbx_settings SET value = '${UCP_AMI_SECRET}' WHERE keyword = 'UCPMGRPASS' AND (value IS NULL OR value = '')" 2>/dev/null || true

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
  sed -i "s|AVANTFAX_HOSTNAME|${HOSTNAME:-fax.innotel.us}|g" /var/www/html/fax/includes/local_config.php
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
  # $module/$scope are literal PHP in the grep/sed patterns — kept in
  # variables with the directive so shellcheck doesn't treat them as shell
  # expansions (a `a\` continuation cannot carry its own directive).
  # shellcheck disable=SC2016
  grep_guard='if (!isset($activeModules[$module])) { continue; }'
  if [ -f "$api_dir/Api.class.php" ] && \
     ! grep -q "$grep_guard" "$api_dir/Api.class.php"; then
    # shellcheck disable=SC2016
    sed_guard='/foreach (\$validScopes\[\$type\] as \$module => \$scope) {/a\
\t\t\t\t\tif (!isset($activeModules[$module])) { continue; }'
    sed -i "$sed_guard" "$api_dir/Api.class.php"
    echo ">>> [api] Fix 1 applied — getFlattenedScopes guard (Api.class.php)"
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
  CERT_SUBJECT=$(openssl x509 -in "$CERT_FILE" -noout -subject 2>/dev/null | grep -o 'CN = [^,\n]*' | cut -d' ' -f3-)
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
  if ! fwconsole reload >/tmp/fwconsole-boot-reload.log 2>&1; then
    echo ">>> [modules] boot reload failed — see /tmp/fwconsole-boot-reload.log"
  fi
  echo ">>> FreePBX modules refreshed"

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
