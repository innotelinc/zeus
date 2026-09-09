#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
# Zeus — MS Teams Direct Routing trust plane (Cerulean TrustOps)
#
# Cerulean is the stack's TrustOps platform: it owns certificate
# lifecycle, ACME automation, PKI, and DNS automation. This adapter asks
# Cerulean to make a Zeus PBX MS-Teams-Direct-Routing-ready BEFORE
# pbx/MSTeams-DR-Wizard.sh touches Asterisk:
#
#   1. DNS    — upsert the SBC FQDN's public A record. API mode posts to
#               Cerulean (which writes your BIND server-side over
#               SSH + nsupdate + TSIG); direct mode talks RFC 2136
#               nsupdate from this host (the NPM_TSIG_* convention).
#   2. CERT   — RSA-2048 certificate via DNS-01. API mode asks Cerulean
#               to issue/poll/download the material and installs it where
#               the wizard looks (/etc/letsencrypt/live/<fqdn>/ and
#               /etc/asterisk/ssl/); direct mode runs local certbot
#               dns-rfc2136. RSA-2048 is mandatory: MS Teams rejects
#               ECDSA and ECDSA handshakes core-dump Asterisk.
#   3. WIZARD — (--full) chain into pbx/MSTeams-DR-Wizard.sh with
#               --fqdn=<fqdn> --use-existing-cert plus any extra flags
#               after `--` (e.g. --greenfield --version=22). The wizard
#               owns everything Asterisk-side (transport, endpoint,
#               reload); this script owns the trust plane.
#
# Modes:
#   (default)          DNS upsert + certificate issue/renew
#   --full             DNS + cert, then run MSTeams-DR-Wizard.sh
#   --dns-only         DNS upsert only
#   --cert-only        certificate issue/renew only
#   --check            read-only audit; exit code = failed checks
#   --no-dns           skip the DNS step (record managed elsewhere)
#   --force-renew      renew the certificate even when not due
#   --dry-run          print what would run; change nothing
#   --fqdn=<name>      SBC FQDN (default: CERULEAN_SBC_FQDN, then the
#                      HOSTNAME from pbx.env, then hostname -f)
#
# Mode selection:
#   CERULEAN_API_URL set → API mode (Cerulean REST API; recommended)
#   otherwise            → direct mode (local nsupdate + certbot)
#
# API mode environment (CERULEAN_* fall back to NPM_* twins / pbx.env):
#   CERULEAN_API_URL        e.g. https://api.cerulean.innotel.us
#   CERULEAN_API_TOKEN      bearer token (skip login)
#   CERULEAN_API_PASSWORD   admin password → POST /api/auth/login
#   CERULEAN_TENANT         optional tenant slug (X-Cerulean-Tenant)
#   CERULEAN_ZONE           zone to upsert into (default: FQDN minus
#                           first label); registered in Cerulean if missing
#   CERULEAN_SBC_FQDN       SBC FQDN override
#   MS_TEAMS_SBC_IP         public IPv4 for the A record (auto-detected)
# Direct mode environment:
#   CERULEAN_TSIG_NAMESERVER / _KEY_NAME / _KEY_SECRET / _ALGORITHM
#   CERULEAN_LE_EMAIL       ACME account email (NPM_LETSENCRYPT_EMAIL)
# Shared: PBX_ENV_FILE (default scripts/pbx.env) is sourced first; real
# environment variables win.
#
# Usage:
#   pbx/cerulean-msteams.sh --check
#   pbx/cerulean-msteams.sh --full --fqdn=teams.zeus.innotel.us
#   pbx/cerulean-msteams.sh --full -- --greenfield --version=22
# ═══════════════════════════════════════════════════════════════════
set -euo pipefail

CERULEAN_VERSION="1.1.0"
SCRIPT_NAME="cerulean-msteams"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
WIZARD="${SCRIPT_DIR}/MSTeams-DR-Wizard.sh"
API_POLL_INTERVAL=4     # seconds between certificate-status polls
API_POLL_MAX=40         # ~160 s — DNS-01 issuance typically lands well inside

# ── runtime state ────────────────────────────────────────────────────
DRY_RUN=false
MODE_FULL=false
MODE_DNS_ONLY=false
MODE_CERT_ONLY=false
MODE_CHECK=false
NO_DNS=false
FORCE_RENEW=false
CLI_FQDN=""

# ── output helpers (stack-lib style) ─────────────────────────────────
cerulean_say()  { printf '\033[1m%s\033[0m\n' "$*"; }
cerulean_warn() { printf '\033[33mwarning: %s\033[0m\n' "$*" >&2; }
cerulean_die()  { printf '\033[31merror: %s\033[0m\n' "$*" >&2; exit 1; }
cerulean_step() { printf '\033[1m── %s ──\033[0m\n' "$*"; }

# ── env resolution ───────────────────────────────────────────────────
# Load scripts/pbx.env (the same file setup.sh/setup-portal.sh source),
# then let real env vars win — identical precedence to stack_lib_load_env.
cerulean_load_env() {
    local pbx_env="${PBX_ENV_FILE:-${REPO_ROOT}/scripts/pbx.env}"
    if [ -f "$pbx_env" ]; then
        local line key val
        while IFS= read -r line; do
            line="${line%%$'\r'*}"
            case "$line" in ''|\#*) continue ;; esac
            key="${line%%=*}"
            val="${line#*=}"
            if [ -n "$key" ] && [ -z "${!key:-}" ]; then
                export "$key=$val"
            fi
        done < "$pbx_env"
    fi
}

# First non-empty var lookup: cerulean_first_var KEY1 KEY2... prints value.
cerulean_first_var() {
    local key
    for key in "$@"; do
        if [ -n "${!key:-}" ]; then
            printf '%s' "${!key}"
            return 0
        fi
    done
    printf ''
}

# TSIG algorithm as BIND/nsupdate expects: hmac-sha256 (tolerates
# HMAC-SHA256 / SHA256 / already-normalized input).
cerulean_bind_algorithm() {
    local algo="${1:-HMAC-SHA256}"
    algo="$(printf '%s' "$algo" | tr '[:upper:]' '[:lower:]')"
    case "$algo" in
        hmac-*) ;;
        *) algo="hmac-${algo}" ;;
    esac
    printf '%s' "$algo"
}

# Split host:port → prints "<host> <port>" (port defaults to 53).
cerulean_split_hostport() {
    local addr="$1"
    if [[ "$addr" == *:* ]]; then
        printf '%s %s' "${addr%%:*}" "${addr##*:}"
    else
        printf '%s 53' "$addr"
    fi
}

# Zone the FQDN lives in: CERULEAN_ZONE wins, else FQDN minus first label
# (teams.zeus.innotel.us → zeus.innotel.us) — the per-platform zone rule.
cerulean_zone_for() {
    local fqdn="$1"
    if [ -n "${CERULEAN_ZONE:-}" ]; then
        printf '%s' "$CERULEAN_ZONE"
    else
        printf '%s' "${fqdn#*.}"
    fi
}

# Build the certbot-dns-rfc2136 credentials INI. Byte-compatible with
# scripts/npm-proxy-hosts.py:build_rfc2136_credentials so both tools
# render the same credential content from the same env.
cerulean_build_rfc2136_ini() { # <server> <key_name> <key_secret> [algorithm] [port]
    local server="$1" key_name="$2" key_secret="$3"
    local algorithm="${4:-HMAC-SHA256}" port="${5:-53}"
    local host_port
    host_port="$(cerulean_split_hostport "$server")"
    cat <<INI
# Target DNS server
dns_rfc2136_server = ${host_port%% *}
# Target DNS port
dns_rfc2136_port = ${host_port##* }
# TSIG key name
dns_rfc2136_name = ${key_name}
# TSIG key secret
dns_rfc2136_secret = ${key_secret}
# TSIG key algorithm
dns_rfc2136_algorithm = ${algorithm}

INI
}

# Write the nsupdate TSIG key file (chmod 600) so the secret never
# appears on a command line. Prints the file path.
cerulean_write_key_file() { # <dest>
    local dest="$1" algo
    algo="$(cerulean_bind_algorithm "${CERULEAN_TSIG_ALGORITHM:-HMAC-SHA256}")"
    cat > "$dest" <<KEY
key "${CERULEAN_TSIG_KEY_NAME:-}" {
    algorithm ${algo};
    secret "${CERULEAN_TSIG_KEY_SECRET:-}";
};
KEY
    chmod 600 "$dest"
    printf '%s' "$dest"
}

# Public IPv4 detection — the same providers the vendored wizard uses,
# so the A record and the wizard's external_signaling_address agree.
cerulean_detect_public_ip() {
    if [ -n "${MS_TEAMS_SBC_IP:-}" ]; then
        printf '%s' "$MS_TEAMS_SBC_IP"
        return 0
    fi
    local ip provider
    for provider in "https://api4.ipify.org" "https://ifconfig.me" "https://ipv4.icanhazip.com"; do
        ip="$(curl -4 -s --max-time 5 "$provider" 2>/dev/null | tr -d '[:space:]' || true)"
        if [[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
            printf '%s' "$ip"
            return 0
        fi
    done
    ip="$(ip route get 1.1.1.1 2>/dev/null | grep -oP 'src \K[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
    if [ -n "$ip" ]; then
        printf '%s' "$ip"
        return 0
    fi
    return 1
}

# Resolve the effective settings once env is loaded.
cerulean_resolve_fqdn() {
    local fqdn="${CLI_FQDN:-$(cerulean_first_var CERULEAN_SBC_FQDN HOSTNAME)}"
    if [ -z "$fqdn" ]; then
        fqdn="$(hostname -f 2>/dev/null || hostname)"
    fi
    printf '%s' "$fqdn"
}

cerulean_resolve_tsig() {
    CERULEAN_TSIG_NAMESERVER="$(cerulean_first_var CERULEAN_TSIG_NAMESERVER NPM_TSIG_NAMESERVER)"
    CERULEAN_TSIG_KEY_NAME="$(cerulean_first_var CERULEAN_TSIG_KEY_NAME NPM_TSIG_KEY_NAME)"
    CERULEAN_TSIG_KEY_SECRET="$(cerulean_first_var CERULEAN_TSIG_KEY_SECRET NPM_TSIG_KEY_SECRET)"
    CERULEAN_TSIG_ALGORITHM="$(cerulean_first_var CERULEAN_TSIG_ALGORITHM NPM_TSIG_ALGORITHM)"
    CERULEAN_TSIG_ALGORITHM="${CERULEAN_TSIG_ALGORITHM:-HMAC-SHA256}"
    CERULEAN_LE_EMAIL="$(cerulean_first_var CERULEAN_LE_EMAIL NPM_LETSENCRYPT_EMAIL)"
}

cerulean_tsig_complete() {
    [ -n "${CERULEAN_TSIG_NAMESERVER:-}" ] && [ -n "${CERULEAN_TSIG_KEY_NAME:-}" ] \
        && [ -n "${CERULEAN_TSIG_KEY_SECRET:-}" ]
}

# Verify the record through the authoritative resolver when known.
cerulean_dns_verify() { # <fqdn> <ip>
    local fqdn="$1" ip="$2" resolved host port
    if [ -n "${CERULEAN_TSIG_NAMESERVER:-}" ]; then
        read -r host port <<< "$(cerulean_split_hostport "${CERULEAN_TSIG_NAMESERVER}")"
        resolved="$(dig "@${host}" -p "$port" +short +time=2 +tries=2 A "$fqdn" 2>/dev/null \
            | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | head -1 || true)"
    else
        resolved="$(dig +short +time=2 +tries=2 A "$fqdn" 2>/dev/null \
            | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | head -1 || true)"
    fi
    if [ -z "$resolved" ]; then
        cerulean_warn "${fqdn} not resolvable (yet)"
        return 1
    fi
    if [ "$resolved" != "$ip" ]; then
        cerulean_warn "${fqdn} resolves to ${resolved}, expected ${ip}"
        return 1
    fi
    cerulean_say "DNS verify: ${fqdn} → ${resolved} [OK]"
}

# ── Cerulean REST API (recommended) ──────────────────────────────────
# Every dashboard action is a JSON endpoint: POST /api/auth/login
# {password} → {token}; GET/POST /api/domains; POST/DELETE
# /api/domains/:id/records; GET/POST /api/certificates + :id/renew +
# :id/material. Tenant scoping rides on the X-Cerulean-Tenant header.

cerulean_api_mode() {
    [ -n "${CERULEAN_API_URL:-}" ] || [ -n "${CERULEAN_API_TOKEN:-}" ]
}

cerulean_api() { # <method> <path> [json-body]
    local method="$1" path="$2" body="${3:-}"
    local -a curl_args=(-sS --max-time 30 -X "$method"
        -H "Authorization: Bearer ${CERULEAN_API_TOKEN:-}")
    [ -n "${CERULEAN_TENANT:-}" ] && curl_args+=(-H "X-Cerulean-Tenant: ${CERULEAN_TENANT}")
    [ -n "$body" ] && curl_args+=(-H 'Content-Type: application/json' -d "$body")
    curl "${curl_args[@]}" "${CERULEAN_API_URL%/}${path}"
}

# jq is the only JSON parser the API path needs (stack-lib posture:
# stdlib curl/jq/dig). Fail with an actionable message.
cerulean_require_jq() {
    command -v jq >/dev/null 2>&1 \
        || cerulean_die "API mode needs jq (apt-get install -y jq)"
}

cerulean_api_login() {
    if [ -z "${CERULEAN_API_TOKEN:-}" ]; then
        [ -n "${CERULEAN_API_PASSWORD:-}" ] \
            || cerulean_die "CERULEAN_API_URL set but no credentials — set CERULEAN_API_TOKEN or CERULEAN_API_PASSWORD"
        local login_body resp
        # jq builds the body so every password byte is JSON-escaped.
        login_body="$(jq -cn --arg p "$CERULEAN_API_PASSWORD" '{password: $p}')"
        resp="$(cerulean_api POST /api/auth/login "$login_body")" || true
        CERULEAN_API_TOKEN="$(printf '%s' "${resp:-}" | jq -r '.token // empty' 2>/dev/null || true)"
        [ -n "$CERULEAN_API_TOKEN" ] || cerulean_die "Cerulean login failed — check CERULEAN_API_PASSWORD / CERULEAN_API_URL"
    fi
    cerulean_say "Cerulean API: ${CERULEAN_API_URL%/} [OK]"
}

# The zone's Cerulean domain id — registers the zone when missing.
cerulean_api_zone_id() { # <zone>
    local zone="$1" domains id
    domains="$(cerulean_api GET /api/domains)"
    id="$(printf '%s' "$domains" | jq -r --arg z "$zone" \
        '.[] | select(.name == $z) | .id' 2>/dev/null | head -1)"
    if [ -z "$id" ]; then
        # Progress goes to stderr: this function runs inside a command
        # substitution, so any stdout here would corrupt the captured id.
        printf '\033[1mregistering zone %s in Cerulean\033[0m\n' "$zone" >&2
        id="$(cerulean_api POST /api/domains "{\"name\":\"${zone}\"}" \
            | jq -r '.id // empty' 2>/dev/null)"
        [ -n "$id" ] || cerulean_die "could not register zone ${zone} in Cerulean"
    fi
    printf '%s' "$id"
}

# Upsert the A record via the API (Cerulean nsupdates your BIND).
cerulean_api_dns_upsert() { # <fqdn> <ip>
    local fqdn="$1" ip="$2" zone label domain_id existing
    zone="$(cerulean_zone_for "$fqdn")"
    label="${fqdn%.}"
    [[ "$fqdn" == *."${zone}" && "$fqdn" != "$zone" ]] && label="${fqdn%."${zone}"}"
    if $DRY_RUN; then
        cerulean_say "[DRY-RUN] Cerulean API: upsert A ${label}.${zone} → ${ip} (register zone ${zone} if missing)"
        return 0
    fi
    domain_id="$(cerulean_api_zone_id "$zone")"
    # Idempotent upsert: drop any stale A records for the label, then add.
    existing="$(cerulean_api GET "/api/domains/${domain_id}/records" \
        | jq -r --arg n "$label" '.[]? | select(.type == "A" and (.name == $n or .name == "${n}." )) | [.name, .value] | @tsv' 2>/dev/null || true)"
    if [ -n "$existing" ]; then
        while IFS=$'\t' read -r _rec_name rec_value; do
            [ -n "$rec_value" ] || continue
            cerulean_api DELETE "/api/domains/${domain_id}/records" \
                "{\"type\":\"A\",\"name\":\"${label}\",\"value\":\"${rec_value}\"}" >/dev/null || true
        done <<< "$existing"
    fi
    cerulean_api POST "/api/domains/${domain_id}/records" \
        "{\"type\":\"A\",\"name\":\"${label}\",\"value\":\"${ip}\",\"ttl\":300}" >/dev/null
    cerulean_say "DNS: ${label}.${zone} → ${ip} (via Cerulean → BIND ${zone})"
}

# Issue-or-renew through Cerulean, poll, download, install, verify.
cerulean_api_cert_ensure() { # <fqdn>
    local fqdn="$1" certs cert_id status material i
    local live_dir="/etc/letsencrypt/live/${fqdn}"
    local asterisk_dir="/etc/asterisk/ssl"

    if $DRY_RUN; then
        cerulean_say "[DRY-RUN] Cerulean API: issue/renew ${fqdn} (DNS-01, RSA), poll status, install material into ${live_dir} + ${asterisk_dir}"
        return 0
    fi

    certs="$(cerulean_api GET /api/certificates)"
    cert_id="$(printf '%s' "$certs" | jq -r --arg d "$fqdn" \
        '.[] | select(.domain == $d) | .id' 2>/dev/null | head -1)"
    if [ -n "$cert_id" ]; then
        if $FORCE_RENEW; then
            cerulean_say "renewing Cerulean certificate ${cert_id} for ${fqdn}"
            cerulean_api POST "/api/certificates/${cert_id}/renew" >/dev/null
        else
            cerulean_say "Cerulean certificate ${cert_id} for ${fqdn} exists — renewing only when due"
        fi
    else
        if ! $FORCE_RENEW; then
            # Creating issues immediately; Cerulean auto-renews 30 days early.
            FORCE_RENEW=true
        fi
        cerulean_say "requesting Cerulean certificate for ${fqdn} (DNS-01)"
        cert_id="$(cerulean_api POST /api/certificates "{\"domain\":\"${fqdn}\"}" \
            | jq -r '.id // empty' 2>/dev/null)"
        [ -n "$cert_id" ] || cerulean_die "Cerulean did not accept the certificate request for ${fqdn} — register the zone first"
    fi

    # Poll the async issue job: status issuing → issued | error.
    for ((i = 1; i <= API_POLL_MAX; i++)); do
        sleep "$API_POLL_INTERVAL"
        status="$(cerulean_api GET "/api/certificates/${cert_id}" | jq -r '.status // empty' 2>/dev/null || true)"
        case "$status" in
            issued) break ;;
            error|failed)
                local err
                err="$(cerulean_api GET "/api/certificates/${cert_id}" | jq -r '.error // "unknown error"' 2>/dev/null)"
                cerulean_die "Cerulean issuance failed for ${fqdn}: ${err}"
                ;;
        esac
        printf '.' >&2
    done
    echo "" >&2
    status="$(cerulean_api GET "/api/certificates/${cert_id}" | jq -r '.status // empty' 2>/dev/null || true)"
    [ "$status" = "issued" ] || cerulean_die "Cerulean certificate for ${fqdn} did not become issued (status: ${status:-unknown})"

    material="$(cerulean_api GET "/api/certificates/${cert_id}/material")"
    mkdir -p "$live_dir" "$asterisk_dir"
    printf '%s' "$material" | jq -r '.certificate' > "${live_dir}/fullchain.pem"
    printf '%s' "$material" | jq -r '.key' > "${live_dir}/privkey.pem"
    # The wizard reads /etc/asterisk/ssl/cert.crt too; ca.crt = fullchain.
    cp "${live_dir}/fullchain.pem" "${asterisk_dir}/cert.crt"
    cp "${live_dir}/privkey.pem" "${asterisk_dir}/privkey.crt"
    cp "${live_dir}/fullchain.pem" "${asterisk_dir}/ca.crt"
    chmod 600 "${live_dir}/privkey.pem" "${asterisk_dir}/privkey.crt"
    cerulean_say "certificate installed: ${live_dir}/fullchain.pem + ${asterisk_dir}/cert.crt"
    cerulean_verify_cert_material "${live_dir}/fullchain.pem" "$fqdn" || return 1
}

# Material sanity: RSA key type (MS Teams mandate) + SAN covers the FQDN.
cerulean_verify_cert_material() { # <cert-pem> <fqdn>
    local cert_file="$1" fqdn="$2" key_alg ok=true
    command -v openssl >/dev/null 2>&1 || { cerulean_warn "openssl missing — skipping material verification"; return 0; }
    key_alg="$(openssl x509 -in "$cert_file" -noout -text 2>/dev/null \
        | grep 'Public Key Algorithm' | awk '{print $NF}')"
    if [[ "$key_alg" == *"rsaEncryption"* ]]; then
        cerulean_say "  key type: RSA [OK]"
    else
        cerulean_warn "  key type '${key_alg}' is not RSA — MS Teams Direct Routing requires RSA-2048"
        ok=false
    fi
    if openssl x509 -in "$cert_file" -noout -text 2>/dev/null | grep -q "DNS:${fqdn}"; then
        cerulean_say "  SAN covers ${fqdn} [OK]"
    else
        cerulean_warn "  SAN does not cover ${fqdn}"
        ok=false
    fi
    [ "$ok" = true ]
}

# ── Direct mode (no API reachable): local nsupdate + certbot ─────────
cerulean_dns_upsert() { # <fqdn> <ip>
    local fqdn="$1" ip="$2" zone work keyfile host port
    zone="$(cerulean_zone_for "$fqdn")"
    if $DRY_RUN; then
        cerulean_say "[DRY-RUN] nsupdate -k <tsig-key> → zone ${zone}: ${fqdn}. 300 IN A ${ip}"
        return 0
    fi
    work="$(mktemp -d)"
    keyfile="$(cerulean_write_key_file "${work}/cerulean.tsig.key")"
    # shellcheck disable=SC2064  # expands now on purpose: fixed trap payload
    trap "rm -rf '${work}'" RETURN
    read -r host port <<< "$(cerulean_split_hostport "${CERULEAN_TSIG_NAMESERVER}")"
    if ! nsupdate -k "$keyfile" <<NSU 2>&1
server ${host} ${port}
zone ${zone}
update delete ${fqdn}. A
update add ${fqdn}. 300 A ${ip}
send
NSU
    then
        trap - RETURN
        rm -rf "$work"
        cerulean_warn "nsupdate failed for ${fqdn} (zone ${zone}, server ${CERULEAN_TSIG_NAMESERVER})"
        return 1
    fi
    trap - RETURN
    rm -rf "$work"
    cerulean_say "DNS: ${fqdn} → ${ip} (zone ${zone} @ ${CERULEAN_TSIG_NAMESERVER})"
}

cerulean_certbot_plugin_ok() {
    certbot plugins 2>/dev/null | grep -q 'dns-rfc2136'
}

cerulean_ensure_certbot() {
    if command -v certbot >/dev/null 2>&1 && cerulean_certbot_plugin_ok; then
        cerulean_say "certbot + dns-rfc2136 plugin [OK]"
        return 0
    fi
    if $DRY_RUN; then
        cerulean_say "[DRY-RUN] Would install: apt-get install -y certbot python3-certbot-dns-rfc2136"
        return 0
    fi
    cerulean_warn "certbot or the dns-rfc2136 plugin is missing — installing..."
    apt-get update -q
    apt-get install -y certbot python3-certbot-dns-rfc2136
}

# RSA-2048 is mandatory: MS Teams rejects ECDSA and Asterisk core-dumps
# on ECDSA handshakes.
cerulean_cert_issue() { # <fqdn> [email]
    local fqdn="$1"
    local email="${2:-${CERULEAN_LE_EMAIL:-}}"
    local live_dir="/etc/letsencrypt/live/${fqdn}"
    local secrets_dir ini

    if [ -z "$email" ]; then
        cerulean_die "no ACME email — set CERULEAN_LE_EMAIL (or NPM_LETSENCRYPT_EMAIL) in pbx.env"
    fi

    cerulean_ensure_certbot

    if $DRY_RUN; then
        if [ -f "${live_dir}/fullchain.pem" ]; then
            cerulean_say "[DRY-RUN] Would renew (when due): certbot renew --cert-name ${fqdn}"
        else
            cerulean_say "[DRY-RUN] Would issue via DNS-01: certbot certonly --dns-rfc2136 --key-type rsa --rsa-key-size 2048 -d ${fqdn}"
        fi
        return 0
    fi

    secrets_dir="/etc/letsencrypt/.secrets"
    mkdir -p "$secrets_dir"
    ini="${secrets_dir}/cerulean-rfc2136-${fqdn}.ini"
    cerulean_build_rfc2136_ini "$CERULEAN_TSIG_NAMESERVER" \
        "$CERULEAN_TSIG_KEY_NAME" "$CERULEAN_TSIG_KEY_SECRET" \
        "$CERULEAN_TSIG_ALGORITHM" > "$ini"
    chmod 600 "$ini"

    if [ -f "${live_dir}/fullchain.pem" ]; then
        if $FORCE_RENEW; then
            certbot renew --cert-name "$fqdn" --non-interactive --force-renewal
        else
            cerulean_say "certificate for ${fqdn} already exists (${live_dir}) — renewing only when due"
            certbot renew --cert-name "$fqdn" --non-interactive
        fi
    else
        certbot certonly \
            --dns-rfc2136 \
            --dns-rfc2136-credentials "$ini" \
            --dns-rfc2136-propagation-seconds 30 \
            --key-type rsa --rsa-key-size 2048 \
            --email "$email" --agree-tos --non-interactive \
            --cert-name "$fqdn" \
            -d "$fqdn"
    fi

    if [ ! -f "${live_dir}/fullchain.pem" ]; then
        cerulean_warn "certificate issuance did not produce ${live_dir}/fullchain.pem"
        return 1
    fi
    cerulean_say "certificate ready: ${live_dir}/fullchain.pem (RSA-2048, DNS-01 via Cerulean BIND)"
    cerulean_verify_cert_material "${live_dir}/fullchain.pem" "$fqdn" || return 1
}

# ── read-only audit ──────────────────────────────────────────────────
cerulean_check() { # <fqdn>
    local fqdn="$1" fails=0 ip cert_file key_alg
    local certbot_dir="/etc/letsencrypt/live/${fqdn}"

    cerulean_step "Cerulean trust audit — ${fqdn}"

    # 1. Trust-plane credentials
    if cerulean_api_mode; then
        if [ -n "${CERULEAN_API_TOKEN:-}" ] || [ -n "${CERULEAN_API_PASSWORD:-}" ]; then
            cerulean_say "  Cerulean API: ${CERULEAN_API_URL%/} (credentials present) [OK]"
        else
            cerulean_warn "  CERULEAN_API_URL is set but no CERULEAN_API_TOKEN/_API_PASSWORD"
            fails=$((fails + 1))
        fi
    elif cerulean_tsig_complete; then
        cerulean_say "  TSIG: ${CERULEAN_TSIG_KEY_NAME} @ ${CERULEAN_TSIG_NAMESERVER} [OK]"
    else
        cerulean_warn "  TSIG config incomplete — set CERULEAN_TSIG_* (or the NPM_TSIG_* twins) in pbx.env"
        fails=$((fails + 1))
    fi

    # 2. A record resolves (through the platform BIND when configured)
    if ip="$(cerulean_detect_public_ip)"; then
        cerulean_dns_verify "$fqdn" "$ip" || fails=$((fails + 1))
    else
        cerulean_warn "  could not detect a public IPv4 — set MS_TEAMS_SBC_IP"
        fails=$((fails + 1))
    fi

    # 3. Certificate: present, RSA, covers the FQDN
    if [ -f "${certbot_dir}/fullchain.pem" ]; then
        cert_file="${certbot_dir}/fullchain.pem"
    elif [ -f "/etc/asterisk/ssl/cert.crt" ]; then
        cert_file="/etc/asterisk/ssl/cert.crt"
    else
        cert_file=""
    fi
    if [ -n "$cert_file" ]; then
        key_alg="$(openssl x509 -in "$cert_file" -noout -text 2>/dev/null \
            | grep 'Public Key Algorithm' | awk '{print $NF}')"
        if [[ "$key_alg" == *"rsaEncryption"* ]]; then
            cerulean_say "  cert: ${cert_file} (${key_alg}) [OK]"
        else
            cerulean_warn "  cert key algorithm is '${key_alg}' — MS Teams requires RSA (re-issue with --force-renew)"
            fails=$((fails + 1))
        fi
        if openssl x509 -in "$cert_file" -noout -text 2>/dev/null \
            | grep -q "DNS:${fqdn}"; then
            cerulean_say "  cert SAN covers ${fqdn} [OK]"
        else
            cerulean_warn "  cert SAN does not cover ${fqdn}"
            fails=$((fails + 1))
        fi
    else
        cerulean_warn "  no certificate for ${fqdn} — run without --check to issue"
        fails=$((fails + 1))
    fi

    # 4. Wizard-side audit hint (PJSIP transport, port 5061, version)
    if [ -f "$WIZARD" ]; then
        cerulean_say "  wizard-side audit: bash pbx/MSTeams-DR-Wizard.sh --check --fqdn=${fqdn}"
    else
        cerulean_warn "  vendored wizard not found at ${WIZARD}"
        fails=$((fails + 1))
    fi

    if [ "$fails" -eq 0 ]; then
        cerulean_say "Cerulean trust audit: ALL CHECKS PASSED [OK]"
    else
        cerulean_warn "Cerulean trust audit: ${fails} check(s) FAILED"
    fi
    return "$fails"
}

cerulean_show_help() {
    sed -n '2,71p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

cerulean_main() {
    local fqdn ip zone
    # When sourced (unit-test harness) the arg parser never runs, so the
    # wizard-extra-args array may be unset — default it under set -u.
    if [ -z "${WIZARD_EXTRA_ARGS+x}" ]; then
        WIZARD_EXTRA_ARGS=()
    fi
    cerulean_load_env
    cerulean_resolve_tsig
    fqdn="$(cerulean_resolve_fqdn)"
    zone="$(cerulean_zone_for "$fqdn")"

    if [[ "$MODE_CHECK" == true ]]; then
        cerulean_check "$fqdn"
        return $?
    fi

    # DNS step
    if [[ "$NO_DNS" == false && "$MODE_CERT_ONLY" == false ]]; then
        cerulean_step "Cerulean DNS (TrustOps)"
        if ! ip="$(cerulean_detect_public_ip)"; then
            cerulean_die "cannot determine the public IPv4 — set MS_TEAMS_SBC_IP in pbx.env"
        fi
        cerulean_say "SBC FQDN: ${fqdn}  public IP: ${ip}  zone: ${zone}"
        if cerulean_api_mode; then
            cerulean_require_jq
            if ! $DRY_RUN; then
                cerulean_api_login
            fi
            cerulean_api_dns_upsert "$fqdn" "$ip"
        else
            cerulean_tsig_complete \
                || cerulean_die "direct DNS mode needs CERULEAN_TSIG_NAMESERVER/_KEY_NAME/_KEY_SECRET (or the NPM_TSIG_* twins) — or set CERULEAN_API_URL to use the Cerulean API"
            cerulean_dns_upsert "$fqdn" "$ip"
        fi
        cerulean_dns_verify "$fqdn" "$ip" \
            || cerulean_warn "record did not verify yet — propagation or an update-policy deny; check the BIND log"
    fi

    # Certificate step
    if [[ "$MODE_DNS_ONLY" == false ]]; then
        if [ "$(id -u)" -ne 0 ] && ! $DRY_RUN; then
            cerulean_die "certificate management needs root (/etc/letsencrypt, /etc/asterisk/ssl) — run with sudo"
        fi
        cerulean_step "Cerulean ACME (DNS-01, RSA-2048)"
        if cerulean_api_mode; then
            cerulean_require_jq
            if ! $DRY_RUN; then
                cerulean_api_login
            fi
            cerulean_api_cert_ensure "$fqdn"
        else
            cerulean_cert_issue "$fqdn"
        fi
    fi

    # Wizard chain
    if [[ "$MODE_FULL" == true ]]; then
        if [ ! -f "$WIZARD" ]; then
            cerulean_die "vendored wizard missing: ${WIZARD}"
        fi
        local wizard_args=(--fqdn="${fqdn}" --use-existing-cert)
        if [ "${#WIZARD_EXTRA_ARGS[@]}" -gt 0 ]; then
            wizard_args+=("${WIZARD_EXTRA_ARGS[@]}")
        fi
        if $DRY_RUN; then
            cerulean_say "[DRY-RUN] Would run: bash ${WIZARD} ${wizard_args[*]}"
            return 0
        fi
        cerulean_step "MS Teams Direct Routing wizard (Asterisk-side)"
        bash "$WIZARD" "${wizard_args[@]}"
    fi
}

# ── argument parsing (skipped when sourced for unit testing) ─────────
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    WIZARD_EXTRA_ARGS=()
    PARSING_WIZARD_ARGS=false
    while [[ $# -gt 0 ]]; do
        if [[ "$PARSING_WIZARD_ARGS" == true ]]; then
            WIZARD_EXTRA_ARGS+=("$1")
            shift
            continue
        fi
        case "$1" in
            --)              PARSING_WIZARD_ARGS=true; shift ;;
            --full)          MODE_FULL=true; shift ;;
            --dns-only)      MODE_DNS_ONLY=true; shift ;;
            --cert-only)     MODE_CERT_ONLY=true; shift ;;
            --check)         MODE_CHECK=true; shift ;;
            --no-dns)        NO_DNS=true; shift ;;
            --force-renew)   FORCE_RENEW=true; shift ;;
            --dry-run)       DRY_RUN=true; shift ;;
            --fqdn=*)        CLI_FQDN="${1#*=}"; shift ;;
            --fqdn)
                if [[ -n "${2:-}" && "${2:-}" != -* ]]; then
                    CLI_FQDN="$2"; shift 2
                else
                    cerulean_die "--fqdn requires a value"
                fi ;;
            -h|--help)       cerulean_show_help; exit 0 ;;
            --version)       printf '%s %s\n' "$SCRIPT_NAME" "$CERULEAN_VERSION"; exit 0 ;;
            *)               cerulean_die "unknown option: $1 (run with --help)" ;;
        esac
    done
    cerulean_main
fi
