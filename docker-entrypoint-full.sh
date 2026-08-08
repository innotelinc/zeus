#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Innotel PBX Full Stack — Docker Entrypoint
# Starts Apache, PHP-FPM, and Asterisk in foreground.
# ═══════════════════════════════════════════════════════════════
set -e

echo ">>> Starting Innotel PBX Full Stack..."

# Override AMI secret from env var if provided
if [ -n "${AMI_SECRET:-}" ]; then
  sed -i "s/secret = .*/secret = ${AMI_SECRET}/" /etc/asterisk/manager_custom.conf
fi

# Start MariaDB (FreePBX database) — no systemd in container, use init script
mkdir -p /var/run/mysqld && chown mysql:mysql /var/run/mysqld 2>/dev/null || true
service mariadb start

# Start Redis (FreePBX 17 cache/session)
service redis-server start 2>/dev/null || true

# Start PHP-FPM
service php8.2-fpm start

# Start Apache in background
apache2ctl -D FOREGROUND &

# Start Asterisk in foreground (keep container alive)
exec asterisk -f
