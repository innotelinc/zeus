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
#             • One ingress (P1): [zeus-ai-router] and [zeus-ai-accounts] are in
#               the live dialplan, and — where this host holds the portal
#               database — every platform DID's inbound route reaches the
#               router (pbx/ava_routes.py --check)
#   Fax       • AvantFax reachable (AVANTFAX_URL) and its MariaDB has strict
#               mode off (AvantFAX writes '' into DATE/TIMESTAMP columns, which
#               strict mode rejects with error 1292 → HTTP 500 after login)
#   Numbers   • VoIP.ms credentials configured (VOIPMS_API_USERNAME)
#
# Optional sections are skipped (with a note) when their env vars are unset,
# so the smoke runs in a bare dev checkout too.
#
#   Voice     • the D7 assertions (pbx/d7_assert.py): both agents registered
#               with the PBX, the CDR backend wired — and, with D7_CALL=1, a
#               test call that proves it writes — and the gateway offering the
#               model the engine is configured to use
#
# Usage (run from the repo root):
#   ./scripts/smoke-test.sh            # everything
#   ./scripts/smoke-test.sh portal     # portal only
#   ./scripts/smoke-test.sh pbx        # pbx only
#   ./scripts/smoke-test.sh voice      # voice plane (D7 assertions)
#
# Env: D7_CALL=1 places the CDR test call (a Local channel at 12@default — no
#      trunk, no phone, no agent). D7_PBX names the FreePBX container.
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

  # Which *address* AMI and ARI answer on is a deployment decision, not a
  # constant: this estate publishes both on the host's LAN address, because the
  # portal and the engine reach the PBX over it — so probing `127.0.0.1`
  # reported a healthy PBX as down. Ask Docker where it actually published them
  # (the same source the RTP check below uses), and keep the env override for
  # the case where the ports are reached from somewhere else.
  pbx_port_addr() {
    local port="$1" addr
    addr="$(docker port "${D7_PBX:-zeus-freepbx}" "$port" 2>/dev/null | head -1)" || true
    addr="${addr##*-> }"  # "0.0.0.0:5038" or the listing's "5038/tcp -> 0.0.0.0:5038"
    addr="${addr%% *}"
    case "$addr" in
      ''|0.0.0.0:*|"[::]:"*) printf '127.0.0.1' ;;
      *:*) printf '%s' "${addr%:*}" ;;
      *) printf '127.0.0.1' ;;
    esac
  }

  AMI_PORT="${ASTERISK_AMI_PORT:-5038}"
  AMI_HOST="${ASTERISK_AMI_HOST:-$(pbx_port_addr "${AMI_PORT}/tcp")}"
  if (exec 3<>"/dev/tcp/${AMI_HOST}/${AMI_PORT}") 2>/dev/null; then
    exec 3>&- 3<&-
    pass "AMI port open ($AMI_HOST:$AMI_PORT)"
  else
    fail "AMI port closed ($AMI_HOST:$AMI_PORT) — is the PBX running?"
  fi

  ARI_PORT="${ARI_HTTP_PORT:-8088}"
  ARI_HOST="${ASTERISK_AMI_HOST:-$(pbx_port_addr "${ARI_PORT}/tcp")}"
  if (exec 3<>"/dev/tcp/${ARI_HOST}/${ARI_PORT}") 2>/dev/null; then
    exec 3>&- 3<&-
    pass "ARI/HTTP port open ($ARI_HOST:$ARI_PORT)"
  else
    fail "ARI/HTTP port closed ($ARI_HOST:$ARI_PORT)"
  fi

  if [ -f scripts/pbx.env ] || [ -n "${FREEPBX_AMI_SECRET:-}" ]; then
    # `--check` covers the fragments *and* the DID routes, so a bare "out of
    # sync" here would send the operator to the fragments for a row that needs
    # the GUI. The run's own drift lines are what name which it was.
    if drift_out="$(pbx/bootstrap-zeus-pbx.sh --check 2>&1)"; then
      pass "PBX fragments and DID routes in sync"
    else
      fail "PBX out of sync — $(printf '%s\n' "$drift_out" | grep -E '^(drift|zeus-pbx: out of sync)' | head -3 | tr '\n' ' ')"
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

    # ── One ingress (P1) ─────────────────────────────────────────
    # Every platform DID is meant to reach [zeus-ai-router], which dispatches
    # per DID into [zeus-ai-accounts]. A PBX with the fragments *written* and
    # not *loaded* (an apply with no reload) answers "unknown extension"
    # instead of reaching an agent — the same caller-visible failure as the
    # routes being wrong, from a different cause, and neither is visible in
    # the files the last section just compared.
    # Captured first, then matched — never `docker exec … | grep -q`. `grep -q`
    # exits on the first match and closes the pipe, the writer still has output
    # buffered, and the SIGPIPE it gets back becomes the pipeline's status under
    # `set -o pipefail`: a *matched* check reported as a failure. Measured here:
    # the three-priority router context always won that race and the thirteen-
    # extension accounts context usually lost it, so the same check passed by
    # hand, passed under `bash -x`, and failed in the run.
    router_dp="$(docker exec "$FBX" asterisk -rx 'dialplan show zeus-ai-router' 2>/dev/null || true)"
    accounts_dp="$(docker exec "$FBX" asterisk -rx 'dialplan show zeus-ai-accounts' 2>/dev/null || true)"
    if grep -q 'zeus-ai-accounts' <<<"$router_dp"; then
      pass "the AVA router is loaded and dispatches into zeus-ai-accounts"
    else
      fail "the AVA router is not in the live dialplan (apply the fragments, then reload)"
    fi
    # `dialplan show` prints an extension as `  '<exten>' =>  1. <app>(…)`, not
    # as an `exten => ` line (that is the .conf syntax). Grepping for the conf
    # syntax reported a loaded context as missing — and it is the context with a
    # per-DID entry in it that matters, so that is what this asserts.
    if grep -qE "^  '[0-9]+" <<<"$accounts_dp"; then
      pass "the per-DID accounts context is loaded"
    else
      fail "zeus-ai-accounts has no per-DID entry in the live dialplan"
    fi
    # The route *rows* are a judgement about which DIDs reach the router, and
    # that needs the plan — the portal's own answer, or the cached database
    # this host holds. Where neither is readable the run says what it did not
    # judge rather than implying the ingress is fine.
    ingress_db="$(docker volume inspect zeus-portal-data --format '{{.Mountpoint}}' 2>/dev/null || true)"
    if [ -n "$ingress_db" ] && [ -f "$ingress_db/pbx.db" ] && [ -f pbx/ava_routes.py ]; then
      routes_rc=0
      python3 pbx/ava_routes.py --db "$ingress_db/pbx.db" --check >/dev/null 2>&1 || routes_rc=$?
      case "$routes_rc" in
        0) pass "every platform DID's inbound route reaches the AVA router" ;;
        # 3 is "nothing this tool may write": the plan names a DID FreePBX has no
        # route for, which is a row a person adds. Reporting it as routes being
        # *off* the router would name the wrong repair — those DIDs are not
        # pointed elsewhere, they are unwired, and only the GUI can fix it.
        3) fail "a platform DID the plan names has no inbound route in FreePBX — add it by hand (python3 pbx/ava_routes.py --db <portal.db> --check names it)" ;;
        # 1 also covers a route table that is in sync while the router is not
        # registered as a Custom Destination — FreePBX's "bad destination"
        # state, which is the same caller-invisible ingress failure: the run
        # above names which of the two it found, so this points at it rather
        # than guessing.
        *) fail "DID ingress is out of sync — routes off zeus-ai-router,s,1, or the Custom Destination is not registered (python3 pbx/ava_routes.py --db <portal.db> --check)" ;;
      esac
    else
      skip "DID inbound routes (no portal database readable here — run pbx/ava_routes.py --check with a plan)"
    fi
  else
    skip "PBX RTP plane (container $FBX not running)"
  fi
fi

# ─── Voice plane (D7 assertions) ─────────────────────────────────
# D7 is three claims — the call is recorded, both agents are registered, and
# reasoning comes from the one gateway — and every one of them has been false on
# this estate without anything failing loudly: CDR wrote nothing for nine days
# while the PBX looked healthy, an unregistered engine is indistinguishable from
# an idle one, and a gateway that 502s a model returns an HTML page the engine
# can only report as a call that did not work.
#
# They are asserted by a script rather than inline because the parsing is where
# this goes wrong: "DSN asteriskcdrdb has 0 active connections" and "the gateway
# answered 200 but does not offer the configured model" are the two shapes that
# a naive check calls healthy.
if [ "$SCOPE" = all ] || [ "$SCOPE" = voice ]; then
  if [ -f pbx/d7_assert.py ]; then
    d7_args=(--live)
    [ -n "${D7_CALL:-}" ] && d7_args+=(--call)
    [ -n "${D7_PBX:-}" ] && d7_args+=(--pbx "$D7_PBX")
    d7_out="$(python3 pbx/d7_assert.py "${d7_args[@]}" 2>&1)"
    d7_rc=$?
    printf '%s\n' "$d7_out" | sed 's/^/       /'
    case "$d7_rc" in
      0) pass "D7 assertions hold (ARI apps, CDR backend, gateway model probe)" ;;
      2) skip "D7 assertions (no PBX container, or no .env, on this host)" ;;
      *) fail "D7 assertions do not hold — see the [!!] lines above" ;;
    esac
  else
    skip "D7 assertions (pbx/d7_assert.py not present)"
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

  # The strict-mode invariant is asserted whether or not AVANTFAX_URL is set: it
  # is the difference between "the login page answers" and "the app works after
  # login", and it needs nothing but the container. Reachability alone can't see
  # this — the login page renders fine while every page after it 500s, because
  # the failure starts at the first DB write. AvantFAX 3.4.1 writes '' into
  # UserAccount's DATE/TIMESTAMP columns (last_mod on every save, plus
  # pwdexpire) and MariaDB's default STRICT_TRANS_TABLES rejects that with error
  # 1292. pbx/mariadb/zz-avantfax-sql-mode.cnf turns strict mode off for it.
  AFX=$(docker ps -aq --filter "label=com.docker.compose.service=freepbx" 2>/dev/null | while read -r c; do
    [ "$(docker inspect -f '{{.State.Status}}' "$c" 2>/dev/null)" = "running" ] && { echo "$c"; break; }
  done)
  AFX="${AFX:-zeus-freepbx}"
  afx_dbs=$(docker exec "$AFX" mysql -u root -N -B \
    -e "select count(*) from information_schema.schemata where schema_name='avantfax'" 2>/dev/null || true)
  if [ "${afx_dbs:-0}" != "1" ]; then
    skip "AvantFax DB (not deployed in $AFX)"
  else
    afx_mode=$(docker exec "$AFX" mysql -u root -N -B -e 'select @@global.sql_mode' 2>/dev/null || true)
    if [[ "$afx_mode" == *STRICT_TRANS_TABLES* ]]; then
      fail "AvantFax DB runs STRICT_TRANS_TABLES — logins/user saves will 500 (error 1292); apply pbx/mariadb/zz-avantfax-sql-mode.cnf"
    elif [ -n "$afx_mode" ]; then
      pass "AvantFax DB has strict mode off ($afx_mode)"
    else
      fail "AvantFax DB sql_mode unreadable in $AFX"
    fi
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