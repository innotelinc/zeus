#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Innotel PBX Full Stack — Docker Entrypoint
# Starts MariaDB/helpers, then Asterisk in the background, waits for it to
# become ready, and only then starts the web stack (PHP-FPM + Apache) so the
# FreePBX UI can never trigger a reload before Asterisk is up. Asterisk runs
# as the foreground process keeping the container alive.
# ═══════════════════════════════════════════════════════════════
set -e

echo ">>> Starting Innotel PBX Full Stack..."

# Start MariaDB (FreePBX database) — must run before OAuth2 client registration
mkdir -p /var/run/mysqld && chown mysql:mysql /var/run/mysqld 2>/dev/null || true
service mariadb start

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
if [ -n "${FREEPBX_CLIENT_ID:-}" ] && [ -n "${FREEPBX_CLIENT_SECRET:-}" ]; then
  echo ">>> Registering OAuth2 client '${FREEPBX_CLIENT_ID}'..."
  php -r "
    \$db = new PDO('mysql:host=localhost;dbname=asterisk', 'root', '');
    \$db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    \$secretHash = hash('sha256', '${FREEPBX_CLIENT_SECRET}');
    // Check if client already exists
    \$stmt = \$db->prepare('SELECT id FROM api_applications WHERE client_id = ?');
    \$stmt->execute(['${FREEPBX_CLIENT_ID}']);
    \$existing = \$stmt->fetch(PDO::FETCH_ASSOC);
    if (!\$existing) {
      \$stmt = \$db->prepare(
        'INSERT INTO api_applications (owner, name, description, grant_type, client_id, client_secret, redirect_uri, website, algo, allowed_scopes)
         VALUES (NULL, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)'
      );
      \$stmt->execute([
        'PBX Portal API',
        'PBX Customer Portal integration client',
        'client_credentials',
        '${FREEPBX_CLIENT_ID}',
        \$secretHash,
        'sha256',
        'all'
      ]);
      echo 'OAuth2 client registered.' . PHP_EOL;
    } else {
      // Update existing client secret to match current env var
      \$stmt = \$db->prepare('UPDATE api_applications SET client_secret = ?, algo = ? WHERE client_id = ?');
      \$stmt->execute([\$secretHash, 'sha256', '${FREEPBX_CLIENT_ID}']);
      echo 'OAuth2 client secret updated.' . PHP_EOL;
    }
  " 2>/dev/null || echo 'WARNING: Could not register OAuth2 client (API module may not be installed yet)'
fi

# Start Redis (FreePBX 17 cache/session)
service redis-server start 2>/dev/null || true

# Start cron (FreePBX schedules module/cleanup jobs via crontab)
service cron start 2>/dev/null || true

# Start Postfix (mailq, voicemail-to-email, fax notifications)
service postfix start 2>/dev/null || true
echo ">>> Postfix started"

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
  sed -i "s/define('ADMIN_EMAIL',.*/define('ADMIN_EMAIL', '${FAX_EMAIL:-fax@innotel.us}');/" /var/www/html/fax/includes/local_config.php
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
    HOSTNAME_VAL="${HOSTNAME:-voice.innotel.us}"
    # Build SAN list with all expected hostnames
    SAN_LIST="DNS:${HOSTNAME_VAL},DNS:voice.innotel.us,DNS:pbx.innotel.us,DNS:ws.innotel.us,DNS:freepbx"
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
  # After Asterisk restarts, FreePBX may detect version mismatches and
  # disable critical modules. Refresh signatures and reload to keep all
  # modules enabled across reboots/rebuilds.
  echo ">>> Refreshing FreePBX module signatures..."
  fwconsole ma refreshsignatures 2>/dev/null || true
  fwconsole reload 2>/dev/null || true
  echo ">>> FreePBX modules refreshed"

  # Start Apache in background (web UI is now safe to trigger reloads)
  apache2ctl -D FOREGROUND &
fi

# Keep the container alive as long as Asterisk runs (matches the old
# `exec asterisk -f` behavior — the container exits if Asterisk dies).
wait "$ASTERISK_PID"
