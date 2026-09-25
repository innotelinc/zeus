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
#             • Voicemail: `*97` resolves in the live dialplan, and every DSN
#               the res_odbc classes name is defined in /etc/odbc.ini (a class
#               whose DSN is missing answers every retrieve with "Data source
#               name not found" — the PBX looks healthy and the phone goes
#               quiet)
#             • One ingress: [dograh-inbound] is in the live dialplan, so a DID
#               whose inbound route names a Dograh workflow reaches a loaded
#               context — and every DID the portal sells actually names one
#               (pbx/dograh_routes.py; a route off the workflow still answers a
#               call, just as the wrong thing)
#   Fax       • AvantFax reachable (AVANTFAX_URL) and its MariaDB has strict
#               mode off (AvantFAX writes '' into DATE/TIMESTAMP columns, which
#               strict mode rejects with error 1292 → HTTP 500 after login)
#   SMS       • the PJSIP SMS trunk is Registered (VOIPMS_TRUNK_NAME)
#             • the sms-out dialplan context is loaded (SMS_OUT_CONTEXT)
#             • the portal's AMI user carries the `message` class
#             • the VoIP.ms inbound webhook answers its liveness GET
#   Numbers   • VoIP.ms credentials configured (VOIPMS_API_USERNAME)
#
# Optional sections are skipped (with a note) when their env vars are unset,
# so the smoke runs in a bare dev checkout too.
#
#   Voice     • the D7 assertions (pbx/d7_assert.py): the agent registered
#               with the PBX, the CDR backend wired — and, with D7_CALL=1, a
#               test call that proves it writes — and the gateway offering the
#               model pins this repo still holds (the voicemail summary path's
#               VOICEMAIL_SUMMARY_MODEL; the call path's belongs to Dograh)
#
# Usage (run from the repo root):
#   ./scripts/smoke-test.sh            # everything
#   ./scripts/smoke-test.sh portal     # portal only
#   ./scripts/smoke-test.sh pbx        # pbx only
#   ./scripts/smoke-test.sh voice      # voice plane (D7 assertions)
#   ./scripts/smoke-test.sh sms        # SMS trunk + inbound webhook
#
# Env: D7_CALL=1 places the CDR test call (a Local channel at 12@default — no
#      trunk, no phone, no agent). D7_PBX names the FreePBX container, and
#      PORTAL_DB the portal's database the DID list is read from.
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
    # `--check` covers the fragments. The DID routes are a separate judgement
    # below, because a route row lives in FreePBX's database rather than in a
    # fragment this apply writes.
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

    # ── One ingress ──────────────────────────────────────────────
    # Every platform DID is answered by Dograh, and the call enters
    # [dograh-inbound] directly: the DID's own FreePBX inbound route names the
    # workflow (`dograh-inbound,80NN`). A PBX with the route *written* and not
    # *loaded* (an apply with no reload) answers "unknown extension" instead of
    # reaching an agent — the same caller-visible failure as the routes being
    # wrong, from a different cause, and neither is visible in the files the
    # last section just compared.
    # Captured first, then matched — never `docker exec … | grep -q`. `grep -q`
    # exits on the first match and closes the pipe, the writer still has output
    # buffered, and the SIGPIPE it gets back becomes the pipeline's status under
    # `set -o pipefail`: a *matched* check reported as a failure. Measured here:
    # a many-extension context usually lost that race, so the same check passed
    # by hand, passed under `bash -x`, and failed in the run.
    dograh_dp="$(docker exec "$FBX" asterisk -rx 'dialplan show dograh-inbound' 2>/dev/null || true)"
    if grep -q 'dograh-inbound' <<<"$dograh_dp"; then
      pass "the Dograh inbound context is loaded"
    else
      fail "dograh-inbound is not in the live dialplan (apply the fragments, then reload)"
    fi
    # `dialplan show` prints an extension as `  '<exten>' =>  1. <app>(…)`, not
    # as an `exten => ` line (that is the .conf syntax). Grepping for the conf
    # syntax reported a loaded context as missing — and it is the per-workflow
    # entries in it that matter, so that is what this asserts.
    if grep -qE "^  '[0-9]+" <<<"$dograh_dp"; then
      pass "the per-workflow entries are loaded"
    else
      fail "dograh-inbound has no per-workflow entry in the live dialplan"
    fi

    # A loaded context is not a routed DID. `dialplan show` says nothing about
    # which DIDs point into it: a route naming another context still answers a
    # call, just as the wrong thing, and one with no row at all is answered by
    # the catch-all — both look like a working phone from the inside, which is
    # how every DID came to be unwired while both products believed otherwise.
    # The portal's own database is the list of DIDs this platform sells, so the
    # judgement needs both halves. The tool never writes: which workflow a DID
    # should reach is a portal decision, and the row is FreePBX's.
    DID_DB="${PORTAL_DB:-/var/lib/docker/volumes/zeus-portal-data/_data/pbx.db}"
    if [ ! -f pbx/dograh_routes.py ]; then
      skip "DID ingress (pbx/dograh_routes.py not present)"
    elif [ ! -f "$DID_DB" ]; then
      skip "DID ingress (portal database not found at $DID_DB)"
    else
      did_out="$(python3 pbx/dograh_routes.py --db "$DID_DB" --check 2>&1)"
      did_rc=$?
      printf '%s\n' "$did_out" | sed 's/^/       /'
      case "$did_rc" in
        0) pass "every DID the portal sells reaches a dograh-inbound workflow" ;;
        2) fail "DID ingress could not be judged — the portal's DID list or the PBX was unreadable (see above); this is not a pass" ;;
        *) fail "a platform DID does not reach a Dograh workflow (see above) — repoint it in FreePBX's Inbound Routes; the sync timer reports the same rows" ;;
      esac
    fi

    # ── Voicemail — the `*97` feature code ──────────────────────
    # `*97` is FreePBX's My Voicemail, and no file in this repo defines it: the
    # feature code comes from the module-generated dialplan and the mailbox from
    # app_voicemail's storage. So "*97 does not work" cannot be answered from
    # the fragments the section above compares — it has to be asked of the
    # switch — and its two halves fail identically at the phone (nothing
    # happens), which is why they are checked one at a time.
    # `dialplan show` reads a bare argument as a CONTEXT name, so
    # `dialplan show *97` answers "There is no existence of '*97' context" on
    # every PBX there is — a string that contains `'*97'`, which the obvious
    # grep matched. The check passed on its own error message and could never
    # fail. The question that has an answer is the one a phone asks: the
    # feature code in the context it dials from.
    vm_dp="$(docker exec "$FBX" asterisk -rx 'dialplan show *97@from-internal' 2>/dev/null || true)"
    if [ -z "$vm_dp" ]; then
      fail "the live dialplan could not be read on $FBX (asterisk -rx 'dialplan show *97@from-internal' answered nothing)"
    elif grep -qF "no existence of" <<<"$vm_dp"; then
      fail "*97 is not in [from-internal] — FreePBX's Voicemail / Feature Codes modules are not providing it, so a phone dialling it gets nothing"
    elif grep -qF "'*97'" <<<"$vm_dp"; then
      pass "*97 (My Voicemail) resolves in the dialplan a phone dials from"
    else
      fail "*97 is not in [from-internal] — FreePBX's Voicemail / Feature Codes modules are not providing it"
    fi
    # Reaching the feature code is not reaching the box. `macro-user-callerid`
    # re-derives the extension from AstDB's DEVICE/<callerid>/user and reads
    # AMPUSER/<ext>/cidname; with either absent it blanks AMPUSER, so
    # macro-get-vmcontext is called with no argument, resolves no context, and
    # the call ends on the priority after that lookup — one second, ANSWERED,
    # nothing at the phone. Every extension this portal's create path made was
    # in exactly that state, and the dialplan check above cannot see it. Asked
    # of the extensions that have a mailbox, because those are the ones a
    # caller is told to reach with *97.
    vm_boxes="$(docker exec "$FBX" mysql -uroot asterisk -N -B -e \
      "select extension from users where voicemail not in ('novm','disabled','')" 2>/dev/null || true)"
    vm_amp="$(docker exec "$FBX" asterisk -rx 'database show AMPUSER' 2>/dev/null || true)"
    vm_dev="$(docker exec "$FBX" asterisk -rx 'database show DEVICE' 2>/dev/null || true)"
    if [ -z "$vm_amp" ] || [ -z "$vm_dev" ]; then
      fail "AstDB could not be read on $FBX — cannot tell whether *97 resolves the caller to an extension"
    elif [ -z "$vm_boxes" ]; then
      skip "*97 caller resolution (no extension on $FBX has a mailbox)"
    else
      vm_unwired=""
      while IFS= read -r vm_ext; do
        [ -n "$vm_ext" ] || continue
        grep -qF "/DEVICE/$vm_ext/user" <<<"$vm_dev" \
          || vm_unwired="$vm_unwired $vm_ext (no DEVICE/$vm_ext/user)"
        grep -qE "/AMPUSER/$vm_ext/cidname *: *[^[:space:]]" <<<"$vm_amp" \
          || vm_unwired="$vm_unwired $vm_ext (no AMPUSER/$vm_ext/cidname)"
      done <<<"$vm_boxes"
      if [ -z "$vm_unwired" ]; then
        pass "every extension with a mailbox resolves from its caller id (*97 can reach its box)"
      else
        fail "*97 hangs up before the mailbox for:$vm_unwired — macro-user-callerid blanks AMPUSER and macro-get-vmcontext is called with nothing (pbx/voicemail_mailbox.py applies this)"
      fi
    fi
    # The other half is where the messages are stored. res_odbc_custom.conf
    # registers [asteriskvoicemail] against a DSN, and a res_odbc class whose
    # DSN /etc/odbc.ini does not define fails every retrieve with "Data source
    # name not found and no default driver specified": voicemail that records
    # nothing and plays nothing while the PBX is otherwise healthy. The DSN is
    # read out of the class that names it rather than restated here, because
    # that file is what owns the name — and this is the check that would have
    # said so before a caller did.
    vm_res="$(docker exec "$FBX" cat /etc/asterisk/res_odbc_custom.conf 2>/dev/null || true)"
    vm_ini="$(docker exec "$FBX" cat /etc/odbc.ini 2>/dev/null || true)"
    vm_dsns="$(sed -nE 's/^[[:space:]]*dsn[[:space:]]*=>?[[:space:]]*(.*[^[:space:]])[[:space:]]*$/\1/p' <<<"$vm_res")"
    if [ -z "$vm_ini" ]; then
      fail "/etc/odbc.ini could not be read on $FBX — cannot tell which DSNs are defined"
    elif [ -z "$vm_dsns" ]; then
      skip "voicemail storage DSN (no res_odbc class on $FBX)"
    else
      vm_undefined=""
      while IFS= read -r vm_dsn; do
        [ -n "$vm_dsn" ] || continue
        grep -qF "[$vm_dsn]" <<<"$vm_ini" || vm_undefined="$vm_undefined $vm_dsn"
      done <<<"$vm_dsns"
      if [ -z "$vm_undefined" ]; then
        pass "every res_odbc DSN is defined in /etc/odbc.ini ($(tr '\n' ' ' <<<"$vm_dsns"))"
      else
        fail "res_odbc names a DSN /etc/odbc.ini does not define:$vm_undefined — voicemail fails with 'Data source name not found' (the boot entrypoint adds it; see docker-entrypoint-full.sh)"
      fi
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

# ─── SMS ─────────────────────────────────────────────────────────
# SMS deliberately does not ride the VoIP.ms REST API (a per-message fee): the
# portal hands a SIP MESSAGE to Asterisk, which sends it over the PJSIP trunk
# (docs/ops-sms-trunk.md). Four things have to be true for that to work, and
# every one of them has failed on this estate while the Messages screen still
# said "sent" — so none of them is visible from the product's own UI.
if [ "$SCOPE" = all ] || [ "$SCOPE" = sms ]; then
  SMS_TRUNK="${VOIPMS_TRUNK_NAME:-voipms_pjsip}"
  SMS_CTX="${SMS_OUT_CONTEXT:-sms-out}"
  AMI_USER="${ASTERISK_AMI_USERNAME:-pbxportal}"

  FBX_SMS=$(docker ps -aq --filter "label=com.docker.compose.service=freepbx" 2>/dev/null | while read -r c; do
    [ "$(docker inspect -f '{{.State.Status}}' "$c" 2>/dev/null)" = "running" ] && { echo "$c"; break; }
  done)
  FBX_SMS="${D7_PBX:-${FBX_SMS:-zeus-freepbx}}"
  if [ "$(docker inspect -f '{{.State.Status}}' "$FBX_SMS" 2>/dev/null)" = "running" ]; then
    # ── the trunk ───────────────────────────────────────────────
    # A `Rejected` trunk is the estate's classic false green: outbound SIP is
    # fine, the router eats the REGISTER reply, and every send silently stops.
    # The state is the whole check, so the failing line is printed verbatim.
    regs="$(docker exec "$FBX_SMS" asterisk -rx 'pjsip show registrations' 2>/dev/null || true)"
    trunk_line=""
    while IFS= read -r line; do
      case "$line" in
        *"$SMS_TRUNK"*) trunk_line="$line" ;;
      esac
    done <<<"$regs"
    if [ -z "$trunk_line" ]; then
      fail "no PJSIP registration for the SMS trunk '$SMS_TRUNK' — outbound SMS cannot leave the PBX"
    elif [ "${trunk_line#*Registered}" = "$trunk_line" ]; then
      fail "SMS trunk '$SMS_TRUNK' is not Registered:$(printf '%s' "$trunk_line" | head -c 120) — see docs/ops-sms-trunk.md"
    else
      pass "SMS trunk '$SMS_TRUNK' is registered"
    fi

    # ── the dialplan the MESSAGE is built from ──────────────────
    # The trunk can be up with nowhere to put a MESSAGE: `sms-out` is written by
    # scripts/setup.sh on bare metal, and the full stack has to have applied it.
    # An AMI MessageSend against a missing context is accepted and delivered to
    # nothing, so this is the difference between "sent" and "sent somewhere".
    sms_dp="$(docker exec "$FBX_SMS" asterisk -rx "dialplan show $SMS_CTX" 2>/dev/null || true)"
    if grep -qE "^  '[^']" <<<"$sms_dp"; then
      pass "the '$SMS_CTX' dialplan context is loaded"
    else
      fail "'$SMS_CTX' is not in the live dialplan — an outbound SMS has no MESSAGE to build (scripts/setup.sh writes it)"
    fi

    # ── the AMI class the portal sends with ─────────────────────
    # Without the `message` class AMI answers `Permission denied`, the send
    # endpoint turns that into a 502, and the stored row is the only thing that
    # ever said otherwise. Read from the effective config, because the class is
    # only ever granted there — a probe send would spend money to find out.
    ami_grants="$(docker exec "$FBX_SMS" awk -v u="$AMI_USER" \
      'BEGIN{f=0} $0 ~ "^\\[" u "\\]" {f=1; next} /^\[/ {f=0} f {print}' \
      /etc/asterisk/manager.conf /etc/asterisk/manager_custom.conf /etc/asterisk/manager_additional.conf 2>/dev/null || true)"
    if [ -z "$ami_grants" ]; then
      fail "AMI user '$AMI_USER' is not defined on the PBX — the portal cannot send SMS or read call events"
    elif grep -qE '(^|[^a-zA-Z])message([^a-zA-Z]|$)' <<<"$ami_grants"; then
      pass "AMI user '$AMI_USER' is granted the message class (MessageSend permitted)"
    else
      fail "AMI user '$AMI_USER' has no message class — MessageSend returns Permission denied (docs/ops-sms-trunk.md)"
    fi
  else
    skip "SMS trunk / sms-out context / AMI class (PBX container $FBX_SMS not running)"
  fi

  # ── the inbound side ────────────────────────────────────────
  # VoIP.ms verifies the callback URL with a GET before it posts anything, so
  # the carrier's own liveness probe is the assertion — unauthenticated, and
  # 200 by contract. The failure this catches is the old deployed image that
  # 404s every /api/* route: inbound SMS then stops with nothing erroring.
  if [ -n "${PORTAL_URL:-}" ]; then
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "${PORTAL_URL}/api/webhooks/voipms" 2>/dev/null || echo 000)
    if [ "$code" = 200 ]; then
      pass "the VoIP.ms inbound webhook answers its liveness GET (HTTP 200)"
    else
      fail "the VoIP.ms inbound webhook did not answer 200 (HTTP $code) — inbound SMS stops silently"
    fi
  else
    skip "VoIP.ms inbound webhook (PORTAL_URL unset)"
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