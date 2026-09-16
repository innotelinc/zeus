#!/usr/bin/env bash
# edge-turn-relay.sh — keep coturn reachable from outside without touching the router.
#
# WHY THIS EXISTS. coturn moves with the voice plane (Asterisk, the portal) and
# now runs on the platform's new host. The residential router in front of the
# estate was configured when that plane lived here, and its static port-forwards
# for TURN still deliver to THIS host:
#
#   3478/tcp+udp   TURN control (plain)
#   5349/tcp+udp   TURN over TLS
#   49152-49251/udp  the relay range — the ports peers actually send media to
#
# Verified, not assumed: with a bare listener bound to :5349 here, public probes
# from four continents connect; with nothing listening they get "Connection
# refused" (not a timeout), which is a forward to a host with no listener — not
# a missing rule. UPnP cannot correct it: AddPortMapping for 3478, 5349 and
# 49152 returns ConflictInMappingEntry, because a static rule already owns the
# port. Only the router's own UI can repoint those, and no credentials for it
# exist anywhere in the estate.
#
# So the forwarding happens one hop earlier: this host DNATs the TURN ports to
# wherever coturn actually runs. The traffic already arrives here; it just needs
# to continue. If the router rules are ever repointed at the new host, this shim
# simply sees no traffic and can be removed.
#
# The addresses are MASQUERADEd so the reply path stays on this host. Without
# that, coturn answers the peer directly from the new host and the packet leaves
# by a different route than it arrived, which the router's connection tracking
# then translates a second time — media that connects and carries no audio.
#
# Usage:
#   edge-turn-relay.sh check    # report rules and drift, change nothing
#   edge-turn-relay.sh apply    # install/refresh the rules (idempotent)
#   edge-turn-relay.sh remove   # uninstall them
#   edge-turn-relay.sh unit     # print a systemd unit that applies them at boot
#
# Env: TURN_RELAY_TARGET (host coturn runs on), TURN_LISTENING_PORT,
#      TURN_TLS_PORT, TURN_RELAY_PORT_START/END.
set -euo pipefail

TARGET_IP="${TURN_RELAY_TARGET:-}"
LISTEN_PORT="${TURN_LISTENING_PORT:-3478}"
TLS_PORT="${TURN_TLS_PORT:-5349}"
RELAY_START="${TURN_RELAY_PORT_START:-49152}"
RELAY_END="${TURN_RELAY_PORT_END:-49251}"

NAT_CHAIN="TURN-DNAT"
MASQ_CHAIN="TURN-MASQ"
FWD_CHAIN="TURN-RELAY"

die() { echo "error: $*" >&2; exit 1; }
say() { echo "  $*"; }

require_target() {
  [ -n "$TARGET_IP" ] || die "set TURN_RELAY_TARGET to the host running coturn"
  # A DNAT to ourselves is a loop, and a silent one.
  if ip -4 -o addr show | awk '{print $4}' | cut -d/ -f1 | grep -qx "$TARGET_IP"; then
    die "TURN_RELAY_TARGET ($TARGET_IP) is this host — nothing to relay"
  fi
}

# The chains are created on demand so `check` on a host that never had them is
# still a clean read rather than an error.
ensure_chains() {
  iptables -t nat -N "$NAT_CHAIN" 2>/dev/null || true
  iptables -t nat -N "$MASQ_CHAIN" 2>/dev/null || true
  iptables -N "$FWD_CHAIN" 2>/dev/null || true
}

jump_present() { # table chain
  iptables -t "$1" -C "$2" -j "$3" 2>/dev/null
}

ensure_jumps() {
  jump_present nat PREROUTING "$NAT_CHAIN" || iptables -t nat -I PREROUTING 1 -j "$NAT_CHAIN"
  jump_present nat POSTROUTING "$MASQ_CHAIN" || iptables -t nat -A POSTROUTING -j "$MASQ_CHAIN"
  jump_present filter FORWARD "$FWD_CHAIN" || iptables -I FORWARD 1 -j "$FWD_CHAIN"
}

# Every rule below is guarded by -C, so `apply` twice is the same as once.
add_rule() { # table chain args...
  local table="$1" chain="$2"; shift 2
  iptables -t "$table" -C "$chain" "$@" 2>/dev/null && return 0
  iptables -t "$table" -A "$chain" "$@"
}

apply_rules() {
  ensure_chains
  ensure_jumps
  # ── where the traffic goes ────────────────────────────────────────────────
  add_rule nat "$NAT_CHAIN" -p tcp -m multiport --dports "${LISTEN_PORT},${TLS_PORT}" \
    -j DNAT --to-destination "$TARGET_IP"
  add_rule nat "$NAT_CHAIN" -p udp -m multiport --dports "${LISTEN_PORT},${TLS_PORT}" \
    -j DNAT --to-destination "$TARGET_IP"
  add_rule nat "$NAT_CHAIN" -p udp --dport "${RELAY_START}:${RELAY_END}" \
    -j DNAT --to-destination "$TARGET_IP"
  # ── so coturn answers this host, not the peer ─────────────────────────────
  add_rule nat "$MASQ_CHAIN" -p tcp -d "$TARGET_IP" -m multiport --dports "${LISTEN_PORT},${TLS_PORT}" \
    -j MASQUERADE
  add_rule nat "$MASQ_CHAIN" -p udp -d "$TARGET_IP" -m multiport --dports "${LISTEN_PORT},${TLS_PORT}" \
    -j MASQUERADE
  add_rule nat "$MASQ_CHAIN" -p udp -d "$TARGET_IP" --dport "${RELAY_START}:${RELAY_END}" \
    -j MASQUERADE
  # ── FORWARD is DROP on this host (Docker), so the relay needs its own pass,
  #    in BOTH directions. The reply leg matters as much as the first: coturn's
  #    SYN-ACK comes back addressed to the peer, so it too is forwarded and the
  #    default policy drops it silently — the handshake then times out from
  #    outside while every counter on the forward rules looks healthy. The
  #    forward leg is keyed on destination, the reply leg on source.
  add_rule filter "$FWD_CHAIN" -p tcp -d "$TARGET_IP" -m multiport --dports "${LISTEN_PORT},${TLS_PORT}" -j ACCEPT
  add_rule filter "$FWD_CHAIN" -p udp -d "$TARGET_IP" -m multiport --dports "${LISTEN_PORT},${TLS_PORT}" -j ACCEPT
  add_rule filter "$FWD_CHAIN" -p udp -d "$TARGET_IP" --dport "${RELAY_START}:${RELAY_END}" -j ACCEPT
  add_rule filter "$FWD_CHAIN" -p tcp -s "$TARGET_IP" -m multiport --sports "${LISTEN_PORT},${TLS_PORT}" -j ACCEPT
  add_rule filter "$FWD_CHAIN" -p udp -s "$TARGET_IP" -m multiport --sports "${LISTEN_PORT},${TLS_PORT}" -j ACCEPT
  add_rule filter "$FWD_CHAIN" -p udp -s "$TARGET_IP" --sport "${RELAY_START}:${RELAY_END}" -j ACCEPT
}

remove_rules() {
  # shellcheck disable=SC2086  # deliberate word splitting: "table chain" pairs
  for spec in "nat PREROUTING $NAT_CHAIN" "nat POSTROUTING $MASQ_CHAIN" "filter FORWARD $FWD_CHAIN"; do
    set -- $spec
    iptables -t "$1" -D "$2" -j "$3" 2>/dev/null || true
  done
  # shellcheck disable=SC2086
  for pair in "nat $NAT_CHAIN" "nat $MASQ_CHAIN" "filter $FWD_CHAIN"; do
    set -- $pair
    iptables -t "$1" -F "$2" 2>/dev/null || true
    iptables -t "$1" -X "$2" 2>/dev/null || true
  done
}

do_check() {
  require_target
  echo "turn relay: ${LISTEN_PORT},${TLS_PORT} tcp+udp and ${RELAY_START}-${RELAY_END} udp -> ${TARGET_IP}"
  local missing=0
  if ! jump_present nat PREROUTING "$NAT_CHAIN" || ! jump_present nat POSTROUTING "$MASQ_CHAIN" \
     || ! jump_present filter FORWARD "$FWD_CHAIN"; then
    say "chains not wired into PREROUTING/POSTROUTING/FORWARD (not applied)"
    missing=1
  fi
  for spec in \
    "nat $NAT_CHAIN -p tcp -m multiport --dports ${LISTEN_PORT},${TLS_PORT} -j DNAT --to-destination $TARGET_IP" \
    "nat $NAT_CHAIN -p udp -m multiport --dports ${LISTEN_PORT},${TLS_PORT} -j DNAT --to-destination $TARGET_IP" \
    "nat $NAT_CHAIN -p udp --dport ${RELAY_START}:${RELAY_END} -j DNAT --to-destination $TARGET_IP" \
    "nat $MASQ_CHAIN -p tcp -d $TARGET_IP -m multiport --dports ${LISTEN_PORT},${TLS_PORT} -j MASQUERADE" \
    "nat $MASQ_CHAIN -p udp -d $TARGET_IP -m multiport --dports ${LISTEN_PORT},${TLS_PORT} -j MASQUERADE" \
    "nat $MASQ_CHAIN -p udp -d $TARGET_IP --dport ${RELAY_START}:${RELAY_END} -j MASQUERADE" \
    "filter $FWD_CHAIN -p tcp -d $TARGET_IP -m multiport --dports ${LISTEN_PORT},${TLS_PORT} -j ACCEPT" \
    "filter $FWD_CHAIN -p udp -d $TARGET_IP -m multiport --dports ${LISTEN_PORT},${TLS_PORT} -j ACCEPT" \
    "filter $FWD_CHAIN -p udp -d $TARGET_IP --dport ${RELAY_START}:${RELAY_END} -j ACCEPT" \
    "filter $FWD_CHAIN -p tcp -s $TARGET_IP -m multiport --sports ${LISTEN_PORT},${TLS_PORT} -j ACCEPT" \
    "filter $FWD_CHAIN -p udp -s $TARGET_IP -m multiport --sports ${LISTEN_PORT},${TLS_PORT} -j ACCEPT" \
    "filter $FWD_CHAIN -p udp -s $TARGET_IP --sport ${RELAY_START}:${RELAY_END} -j ACCEPT"; do
    # shellcheck disable=SC2086  # each spec is split into table, chain and args
    set -- $spec
    if iptables -t "$1" -C "$2" "${@:3}" 2>/dev/null; then
      say "ok      ${*:3}"
    else
      say "MISSING ${*:3}"
      missing=1
    fi
  done
  [ "$missing" -eq 0 ] && echo "in sync" || echo "drift: run 'apply'"
}

print_unit() {
  cat <<EOF
# /etc/systemd/system/turn-edge-relay.service
# Applies the TURN relay rules at boot. RemainAfterExit so systemd treats the
# oneshot as active while the rules are in force.
[Unit]
Description=Relay the router's TURN port-forwards to the host running coturn
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
Environment=TURN_RELAY_TARGET=${TARGET_IP:-$(hostname -I | awk '{print $1}')}
Environment=TURN_LISTENING_PORT=${LISTEN_PORT}
Environment=TURN_TLS_PORT=${TLS_PORT}
Environment=TURN_RELAY_PORT_START=${RELAY_START}
Environment=TURN_RELAY_PORT_END=${RELAY_END}
ExecStart=$(readlink -f "$0") apply
ExecStop=$(readlink -f "$0") remove

[Install]
WantedBy=multi-user.target
EOF
}

case "${1:-check}" in
  check)  do_check ;;
  apply)  require_target; apply_rules; echo "applied"; do_check ;;
  remove) remove_rules; echo "removed" ;;
  unit)   print_unit ;;
  *)      die "usage: $0 {check|apply|remove|unit}" ;;
esac
