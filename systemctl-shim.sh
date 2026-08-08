#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# systemctl shim for systemd-less containers (used by Dockerfile.full)
#
# The Sangoma FreePBX installer runs commands like
#   systemctl restart postfix
#   systemctl enable freepbx
# which fail with "System has not been booted with systemd as init
# system (PID 1). Can't operate." inside a Docker container where
# systemd is not PID 1.
#
# This shim:
#   - defers to real systemd when it is genuinely running (host),
#   - maps start/stop/restart/reload onto the SysV init scripts,
#   - no-ops enable/disable/mask/unmask/daemon-reload (the container
#     entrypoint manages service startup at runtime).
# ═══════════════════════════════════════════════════════════════
if [ -d /run/systemd/system ]; then
  exec /bin/systemctl "$@"
fi

cmd="$1"
svc="$2"

case "$cmd" in
  is-active|is-enabled)
    if [ -x "/etc/init.d/$svc" ] && /etc/init.d/"$svc" status >/dev/null 2>&1; then
      echo active
    else
      echo inactive
    fi
    exit 0
    ;;
  start|stop|restart|reload|force-reload|status)
    if [ -x "/etc/init.d/$svc" ]; then
      /etc/init.d/"$svc" "$cmd" || true
    fi
    exit 0
    ;;
  enable|disable|mask|unmask|daemon-reload|reset-failed)
    exit 0
    ;;
  *)
    /bin/systemctl "$@" 2>/dev/null || true
    ;;
esac
