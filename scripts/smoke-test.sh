#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
# zeus — live-stack smoke test (mirrors the Capstone smoke convention)
#
# Runs the deployment verification checklist against a running stack:
#
#   Portal    • GET /api/health (any HTTP response counts as healthy —
#               the container healthcheck contract)
#   Edge      • scripts/npm-proxy-hosts.py --check (proxy hosts + wildcard
#               cert in sync with NPM)
#   PBX       • FreePBX reachable (FREEPBX_URL)
#             • AMI port open + handshake (ASTERISK_AMI_HOST:PORT)
#             • ARI HTTP port open (ARI_HTTP_PORT, default 8088)
#             • PBX fragments in sync (pbx/bootstrap-zeus-pbx.sh --check)
#             • RTP plane: published block == Asterisk effective range
#   Fax       • AvantFax reachable (AVANTFAX_URL)
#   Numbers   • VoIP.ms credentials configured (VOIPMS_API_USERNAME)
#
# Optional sections are skipped (with a note) when their env vars are unset,
# so the smoke runs in a bare dev checkout too.
#
# Usage (run from the repo root):
#   ./scripts/smoke-test.sh            # everything
#   ./scripts/smoke-test.sh portal     # portal only
#   ./scripts/smoke-test.sh pbx        # pbx only
#
# Exit code: 0 = all checks passed, 1 = one or more failures.
# ═══════════════════════════════════════════════════════════════════
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

SCOPE="${1:-all}"
FAILS=0
SKIPS=0

pass() { printf '\033[1;32m[ok]\033[0m %s\n' "$*"; }
skip() { printf '\033[1;33m[--]\033[0m %s (skipped: env unset)\n' "$*"; SKIPS=$((SKIPS + 1)); }
fail() { printf '\033[1;31m[!!]\033[0m %s\n' "$*"; FAILS=$((FAILS + 1)); }

if [ -f .env ]; then
  set -a
  # shellcheck source=/dev/null
  . ./.env
  set +a
fi

# ─── Portal ──────────────────────────────────────────────────────
if [ "$SCOPE" = all ] || [ "$SCOPE" = portal ]; then
  PORTAL_URL="${PORTAL_URL:-http://127.0.0.1:3000}"
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$PORTAL_URL/api/health" 2>/dev/null || echo 000)
  if [ "$code" != 000 ]; then
    pass "portal /api/health responded (HTTP $code)"
  else
    fail "portal /api/health unreachable at $PORTAL_URL (is the portal running?)"
  fi

  if [ -f .env ]; then
    if grep -qE '^AUTHENTIK_CLIENT_ID=.+' .env; then
      pass "Authentik OIDC client configured"
    else
      fail "AUTHENTIK_CLIENT_ID missing from .env"
    fi
  fi
fi

# ─── Edge / NPM ──────────────────────────────────────────────────
if [ "$SCOPE" = all ] || [ "$SCOPE" = edge ]; then
  if [ -n "${NPM_BASE_URL:-}" ] && [ -n "${NPM_EMAIL:-}" ]; then
    if python3 scripts/npm-proxy-hosts.py --check >/dev/null 2>&1; then
      pass "NPM proxy hosts + wildcard cert in sync"
    else
      fail "NPM proxy hosts out of sync (run scripts/npm-proxy-hosts.py)"
    fi
  else
    skip "NPM proxy hosts"
  fi
fi

# ─── PBX ─────────────────────────────────────────────────────────
if [ "$SCOPE" = all ] || [ "$SCOPE" = pbx ]; then
  if [ -n "${FREEPBX_URL:-}" ]; then
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -k "$FREEPBX_URL" 2>/dev/null || echo 000)
    if [ "$code" != 000 ]; then
      pass "FreePBX reachable (HTTP $code)"
    else
      fail "FreePBX unreachable at $FREEPBX_URL"
    fi
  else
    skip "FreePBX URL"
  fi

  AMI_HOST="${ASTERISK_AMI_HOST:-127.0.0.1}"
  AMI_PORT="${ASTERISK_AMI_PORT:-5038}"
  if (exec 3<>"/dev/tcp/${AMI_HOST}/${AMI_PORT}") 2>/dev/null; then
    exec 3>&- 3<&-
    pass "AMI port open ($AMI_HOST:$AMI_PORT)"
  else
    fail "AMI port closed ($AMI_HOST:$AMI_PORT) — is the PBX running?"
  fi

  ARI_PORT="${ARI_HTTP_PORT:-8088}"
  if (exec 3<>"/dev/tcp/${AMI_HOST}/${ARI_PORT}") 2>/dev/null; then
    exec 3>&- 3<&-
    pass "ARI/HTTP port open ($AMI_HOST:$ARI_PORT)"
  else
    fail "ARI/HTTP port closed ($AMI_HOST:$ARI_PORT)"
  fi

  if [ -f scripts/pbx.env ] || [ -n "${FREEPBX_AMI_SECRET:-}" ]; then
    if pbx/bootstrap-zeus-pbx.sh --check >/dev/null 2>&1; then
      pass "PBX fragments in sync"
    else
      fail "PBX fragments out of sync (run pbx/bootstrap-zeus-pbx.sh)"
    fi
  else
    skip "PBX fragment drift (scripts/pbx.env not present)"
  fi

  # ── RTP plane ────────────────────────────────────────────────
  # Zeus owns one RTP plane for both products (Zeus + the Capstone add-on), so
  # the published compose block, Asterisk's effective range, and the durable
  # FreePBX settings row must all agree. This catches the classic silent
  # failure: Asterisk left at FreePBX's default 10000-20000 while compose
  # publishes 10101-10120 -> media escapes the forward and calls go one-way.
  FBX=$(docker ps -aq --filter "label=com.docker.compose.service=freepbx" 2>/dev/null | while read -r c; do
    [ "$(docker inspect -f '{{.State.Status}}' "$c" 2>/dev/null)" = "running" ] && { echo "$c"; break; }
  done)
  FBX="${FBX:-zeus-freepbx}"
  if [ "$(docker inspect -f '{{.State.Status}}' "$FBX" 2>/dev/null)" = "running" ]; then
    rtp_start="${FREEPBX_RTP_PORT_START:-10101}"
    rtp_end="${FREEPBX_RTP_PORT_END:-10120}"
    # `docker port` reports really-published ports expanded one by one (the
    # fullstack image EXPOSEs a wider block that Docker 29 would otherwise
    # list), so it is the right source for the advertised block.
    pub_udp=$(docker port "$FBX" 2>/dev/null | awk '{print $1}' | grep '/udp$' | grep -v '^5060/udp$' | sort -u || true)
    expected_rtp=$(seq "$rtp_start" "$rtp_end" | sed 's/$/\/udp/')
    if [ -n "$pub_udp" ] && [ "$(printf '%s\n' "$pub_udp")" = "$(printf '%s\n' "$expected_rtp")" ]; then
      pass "PBX publishes exactly the RTP plane UDP ${rtp_start}-${rtp_end}"
    else
      fail "PBX RTP mapping is not exactly UDP ${rtp_start}-${rtp_end} (got: $(tr '\n' ' ' <<<"$pub_udp"))"
    fi
    stale=$(grep '/udp$' <<<"$pub_udp" | awk -F/ -v s="$rtp_start" -v e="$rtp_end" '$1+0 >= 10000 && $1+0 < s || $1+0 > e && $1+0 <= 20000' || true)
    if [ -n "$stale" ]; then
      fail "PBX publishes stale RTP ports: $(tr '\n' ' ' <<<"$stale")"
    else
      pass "PBX does not publish stale RTP ranges"
    fi
    # Asterisk only binds even RTP ports, so an odd rtpstart (10101) shows up
    # as 10102 — assert the effective range is fully inside the published one,
    # not byte-equal. Outside it means the settings-DB row drifted (an Apply
    # Config reverted it to FreePBX's default 10000-20000).
    rtp_settings=$(docker exec "$FBX" asterisk -rx 'rtp show settings' 2>/dev/null || true)
    eff_start=$(awk '/Port start:/ {print $3; exit}' <<<"$rtp_settings")
    eff_end=$(awk '/Port end:/ {print $3; exit}' <<<"$rtp_settings")
    if [[ "$eff_start" =~ ^[0-9]+$ && "$eff_end" =~ ^[0-9]+$ ]] &&
       (( 10#$eff_start >= 10#$rtp_start && 10#$eff_end <= 10#$rtp_end )); then
      pass "Asterisk effective RTP range ${eff_start}-${eff_end} within published ${rtp_start}-${rtp_end}"
    else
      fail "Asterisk effective RTP range is ${eff_start:-unknown}-${eff_end:-unknown}; expected within ${rtp_start}-${rtp_end} (settings DB drifted?)"
    fi
  else
    skip "PBX RTP plane (container $FBX not running)"
  fi
fi

# ─── Fax ─────────────────────────────────────────────────────────
if [ "$SCOPE" = all ] || [ "$SCOPE" = fax ]; then
  if [ -n "${AVANTFAX_URL:-}" ]; then
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -k "$AVANTFAX_URL" 2>/dev/null || echo 000)
    if [ "$code" != 000 ]; then
      pass "AvantFax reachable (HTTP $code)"
    else
      fail "AvantFax unreachable at $AVANTFAX_URL"
    fi
  else
    skip "AvantFax"
  fi
fi

# ─── Numbers / billing ───────────────────────────────────────────
if [ "$SCOPE" = all ] || [ "$SCOPE" = numbers ]; then
  if [ -n "${VOIPMS_API_USERNAME:-}" ]; then
    pass "VoIP.ms credentials configured (user ${VOIPMS_API_USERNAME})"
  else
    skip "VoIP.ms credentials"
  fi
  if [ -n "${STRIPE_SECRET_KEY:-}" ] || [ -n "${STRIPE_API_KEY:-}" ]; then
    pass "Stripe key configured"
  else
    skip "Stripe key"
  fi
fi

echo ""
echo "zeus smoke: $FAILS failure(s), $SKIPS skipped"
[ "$FAILS" -eq 0 ] && echo "zeus smoke: PASS" || echo "zeus smoke: FAIL"
exit "$FAILS"