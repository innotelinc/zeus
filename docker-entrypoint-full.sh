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

# Register OAuth2 client for the portal (if API module is installed)
if [ -n "${FREEPBX_CLIENT_ID:-}" ] && [ -n "${FREEPBX_CLIENT_SECRET:-}" ]; then
  echo ">>> Registering OAuth2 client '${FREEPBX_CLIENT_ID}'..."
  php -r "
    \$db = new PDO('mysql:host=localhost;dbname=asterisk', 'root', '');
    \$db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    // Check if client already exists
    \$stmt = \$db->prepare('SELECT id FROM api_applications WHERE client_id = ?');
    \$stmt->execute(['${FREEPBX_CLIENT_ID}']);
    if (!\$stmt->fetch()) {
      \$secretHash = hash('sha256', '${FREEPBX_CLIENT_SECRET}');
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
      echo 'OAuth2 client already exists.' . PHP_EOL;
    }
  " 2>/dev/null || echo 'WARNING: Could not register OAuth2 client (API module may not be installed yet)'
fi

# Start Redis (FreePBX 17 cache/session)
service redis-server start 2>/dev/null || true

# Start cron (FreePBX schedules module/cleanup jobs via crontab)
service cron start 2>/dev/null || true

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
fi

# ── Start PHP-FPM (both versions) ────────────────────────────
service php8.2-fpm start
service php7.4-fpm start 2>/dev/null || echo ">>> PHP 7.4 FPM not available (AvantFax won't work)"

# Start Apache in background
apache2ctl -D FOREGROUND &

# Start Asterisk in foreground (keep container alive)
exec asterisk -f
