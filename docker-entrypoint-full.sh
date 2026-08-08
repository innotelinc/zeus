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

# Start PHP-FPM
service php8.2-fpm start

# Start Apache in background
apache2ctl -D FOREGROUND &

# Start Asterisk in foreground (keep container alive)
exec asterisk -f
