#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Innotel PBX Full Stack — Docker Entrypoint
# Starts Apache, PHP-FPM, and Asterisk in foreground.
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

# Start Apache in background
apache2ctl -D FOREGROUND &

# Start Asterisk in foreground (keep container alive)
exec asterisk -f
