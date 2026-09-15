#!/usr/bin/env python3
"""npm_proxy_hosts.py — keep Nginx Proxy Manager proxy hosts in sync with the Zeus stack.

Idempotent; talks to the NPM REST API only (no UI clicks). Safe to re-run:
every step GETs first and only writes when state differs.

What it does:
1. auth — login with NPM_ADMIN_EMAIL/NPM_ADMIN_PASSWORD (POST /api/tokens),
   or use a persistent NPM_API_TOKEN (NPM → Access → API Tokens)
2. sync — for every service in the README "NPM proxy hosts" table,
   create-or-update its proxy host under NPM_BASE_DOMAIN
   (forward host/port from the compose port map)
3. ssl — when NPM_LETSENCRYPT_EMAIL is set, create-or-reuse a Let's Encrypt
   certificate per host and force HTTPS. With --wildcard (default on:
   NPM_WILDCARD_CERT=1) + DNS provider credentials, ONE wildcard certificate
   covering "*.base + base" is issued via DNS-01 and auto-attached to every
   proxy host instead — one cert for every zeus.innotel.us subdomain.

The `ws` host forwards to Asterisk's HTTP-TLS listener (https://<host>:8089)
with WebSocket support ON — that is what the in-browser softphone connects
to (wss://ws.zeus.innotel.us/ws). If NPM validates upstream certificates and
balks at the PBX's self-signed integration cert, use --ws-scheme http
--ws-port 8088 (plain-ws upstream, same /ws signaling handler).

Environment variables (real env wins, then the zeus .env, then defaults):
  NPM_API_URL NPM base URL (http://127.0.0.1:81)
  NPM_ADMIN_EMAIL NPM admin login email (required unless NPM_API_TOKEN)
  NPM_ADMIN_PASSWORD NPM admin login password (required unless NPM_API_TOKEN)
  NPM_API_TOKEN persistent NPM API token (optional; skips login)
  NPM_BASE_DOMAIN base domain, e.g. zeus.innotel.us (required)
  NPM_UPSTREAM_HOST Docker host IP NPM forwards to
  NPM_LETSENCRYPT_EMAIL email for Let's Encrypt certs (empty → hosts without SSL)
  NPM_WILDCARD_CERT 1/true → issue ONE wildcard cert (*.base + base) via
  DNS-01 and attach it to every host (or --wildcard)
  NPM_DNS_PROVIDER DNS provider slug for the wildcard cert (default rfc2136 —
  dynamic DNS updates signed with a TSIG key, matching innotelinc/capstone).
  NPM_DNS_PROVIDER_CREDENTIALS raw credentials file content for the DNS
  provider (what NPM writes to the certbot credentials file). For rfc2136
  you normally DON'T set this — the TSIG vars below build it automatically:
  NPM_TSIG_NAMESERVER TSIG-enabled DNS server (host:port or just host)
  NPM_TSIG_KEY_NAME TSIG key name
  NPM_TSIG_KEY_SECRET TSIG key secret (base64)
  NPM_TSIG_ALGORITHM TSIG algorithm (default HMAC-SHA256)
  With the TSIG vars set, the sync provisions the credential AND the
  wildcard certificate with zero manual NPM clicks.

Usage (from the repo root):
  python3 scripts/npm-proxy-hosts.py            # create/update + prune
  python3 scripts/npm-proxy-hosts.py --check    # verify only, exit 1 if out of sync
  python3 scripts/npm-proxy-hosts.py --no-prune # never delete hosts
  python3 scripts/npm-proxy-hosts.py --no-ssl   # skip certificates/HTTPS
  python3 scripts/npm-proxy-hosts.py --ws-scheme http --ws-port 8088
  python3 scripts/npm-proxy-hosts.py --wildcard \
      --tsig-nameserver 192.0.2.1 --tsig-key-name zeus. \
      --tsig-key-secret 'base64...'  # one wildcard cert, TSIG auto-provisioned

Canonical Zeus subdomains (each service gets <sub>.<NPM_BASE_DOMAIN>):
  zeus.innotel.us   Zeus Customer Portal (apex)          :3000
  subscribe.<domain> Zeus subscription page (buyers)      :3000
  app.<domain>      Zeus Customer Portal / PWA            :3000
  api.<domain>      Zeus Customer Portal API              :3000
  portal.<domain>   Zeus Customer Portal (alias)          :3000
  auth.<domain>     Authentik (SSO / user management)     :9000
  pbx.<domain>      FreePBX                               :80
  admin.<domain>    Nginx Proxy Manager admin UI          :81
  ws.<domain>       WebRTC WSS signaling (softphone)      :8089 (WSS)
"""
from __future__ import annotations
import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parent.parent
DEFAULT_API_URL = "http://127.0.0.1:81"
DEFAULT_DNS_PROVIDER = "rfc2136"  # TSIG dynamic DNS updates (capstone convention)

HOSTS: list[dict[str, Any]] = [
    # NOTE: NPM_UPSTREAM_HOST is the Docker HOST, so these must be the
    # host-published ports (compose maps portal 3001:3000). Pointing them at
    # the container port 3000 routed zeus.innotel.us/app/api at whatever other
    # service owns :3000 on the host (e.g. the Signara frontend).
    #
    # allow_websocket_upgrade is true on every host: the deployed estate has
    # always served them that way, FreePBX's UCP genuinely needs the upgrade,
    # and leaving it on where it is unused costs nothing — not worth churning
    # live proxy hosts (and risking a GUI regression) over a cosmetic flag.
    {"key": "apex", "sub": None, "scheme": "http", "port": 3001, "websocket": True, "name": "Zeus Portal (apex origin)", "forward_auth": False},
    # The subscription page, on its own hostname so "where do I buy this?" has a
    # stable answer that is not the portal's own origin. Same deployment as the
    # portal — app/page.tsx renders the subscribe page when the host starts with
    # "subscribe." (and /subscribe works on every host too).
    {"key": "subscribe", "sub": "subscribe", "scheme": "http", "port": 3001, "websocket": True, "name": "Zeus subscription page (plans & sign-up)", "forward_auth": False},
    {"key": "app", "sub": "app", "scheme": "http", "port": 3001, "websocket": True, "name": "Zeus Customer Portal (PWA)", "forward_auth": False},
    {"key": "api", "sub": "api", "scheme": "http", "port": 3001, "websocket": True, "name": "Zeus Portal API", "forward_auth": False},
    {"key": "portal", "sub": "portal", "scheme": "http", "port": 3001, "websocket": True, "name": "Zeus Customer Portal (alias)", "forward_auth": False},
    {"key": "auth", "sub": "auth", "scheme": "http", "port": 9000, "websocket": True, "name": "Authentik (SSO / user management)", "forward_auth": False},
    {"key": "pbx", "sub": "pbx", "scheme": "http", "port": 80, "websocket": True, "name": "FreePBX"},
    # AvantFax is served by the FreePBX container at /fax (pbx service, port 80).
    {"key": "fax", "sub": "fax", "scheme": "http", "port": 80, "websocket": True, "name": "AvantFax (fax UI, /fax on FreePBX)"},
    # TURN itself is UDP on 3478 — this host exists so the documented
    # coturn.<domain> name resolves and answers the (optional) HTTP probe; the
    # softphone is pointed at TURN_HOSTNAME, not this proxy.
    {"key": "coturn", "sub": "coturn", "scheme": "http", "port": 3478, "websocket": True, "name": "coturn (TURN relay — UDP 3478)", "forward_auth": False},
    # The NPM admin UI is published on its own host and is pinned to the UI's
    # LOOPBACK inside the NPM container, where nginx runs. It must not point at
    # NPM_HOST_IP: NPM Edge believes the Authentik identity headers only on a
    # connection that arrived over loopback — that is what stops a client
    # reaching the admin port directly from forging one — so a LAN-IP upstream
    # answers the gate and then serves a login page with no SSO
    # (see the npm repo's docs/stack.md). Gated like every other surface that
    # keeps a login of its own; the gate signs in at auth.zeus.
    {"key": "admin", "sub": "admin", "scheme": "http", "port": 81, "websocket": True,
     "forward_host": "127.0.0.1", "name": "Nginx Proxy Manager admin UI"},
    {"key": "ws", "sub": "ws", "scheme": "https", "port": 8089, "websocket": True, "name": "WebRTC WSS signaling (softphone)", "forward_auth": False},
]


class NpmError(Exception):
    pass


def load_env_file(path: Path) -> dict[str, str]:
    env: dict[str, str] = {}
    if not path.exists():
        return env
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        env[key.strip()] = val.strip().strip('"').strip("'")
    return env


def cfg(args: argparse.Namespace, key: str, default: str = "") -> str:
    """Resolve a setting: real env first, then the .env file, then default."""
    return os.environ.get(key) or args.env.get(key) or default


class NpmApi:
    """Minimal Nginx Proxy Manager REST API client (stdlib only)."""

    def __init__(self, base_url: str, token: str = ""):
        self.base = base_url.rstrip("/")
        self.token = token

    def _call(self, method: str, path: str, body: Any = None) -> Any:
        url = f"{self.base}{path}"
        data = json.dumps(body).encode() if body is not None else None
        headers = {"Accept": "application/json"}
        if data is not None:
            headers["Content-Type"] = "application/json"
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                raw = resp.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as e:
            detail = (e.read() or b"").decode(errors="replace")[:300]
            raise NpmError(f"{method} {path} → HTTP {e.code}: {detail}") from e

    def login(self, identity: str, secret: str) -> None:
        res = self._call("POST", "/api/tokens", {"identity": identity, "secret": secret})
        token = (res or {}).get("token") or (res or {}).get("access_token") or ""
        if not token:
            raise NpmError("login response contained no token")
        self.token = token

    def proxy_hosts(self) -> list[dict]:
        return self._call("GET", "/api/nginx/proxy-hosts") or []

    def create_proxy_host(self, payload: dict) -> dict:
        return self._call("POST", "/api/nginx/proxy-hosts", payload)

    def update_proxy_host(self, pid: int, payload: dict) -> dict:
        return self._call("PUT", f"/api/nginx/proxy-hosts/{pid}", payload)

    def delete_proxy_host(self, pid: int) -> None:
        self._call("DELETE", f"/api/nginx/proxy-hosts/{pid}")

    def certificates(self) -> list[dict]:
        return self._call("GET", "/api/nginx/certificates") or []

    def create_certificate(self, payload: dict) -> dict:
        return self._call("POST", "/api/nginx/certificates", payload)


def build_rfc2136_credentials(server: str, key_name: str, key_secret: str,
                              algorithm: str = "HMAC-SHA256", port: str = "53") -> str:
    """Build the certbot-dns-rfc2136 credentials file content (INI format)."""
    server_host = server.split(":")[0]
    server_port = server.split(":")[1] if ":" in server else port
    return "\n".join([
        "# Target DNS server",
        f"dns_rfc2136_server = {server_host}",
        "# Target DNS port",
        f"dns_rfc2136_port = {server_port}",
        "# TSIG key name",
        f"dns_rfc2136_name = {key_name}",
        "# TSIG key secret",
        f"dns_rfc2136_secret = {key_secret}",
        "# TSIG key algorithm",
        f"dns_rfc2136_algorithm = {algorithm}",
        "",
    ])


def resolve_dns_credentials(args: argparse.Namespace, dns_provider: str) -> str:
    """Resolve the raw DNS-provider credentials content for a certificate.

    Priority: explicit NPM_DNS_PROVIDER_CREDENTIALS (raw content, or a path
    to a credentials file when the value is an existing file), then the TSIG
    vars (auto-build the rfc2136 INI). Empty string = no DNS challenge
    credentials (falls back to HTTP-01 per host).
    """
    explicit = args.dns_credentials or cfg(args, "NPM_DNS_PROVIDER_CREDENTIALS", "")
    if explicit:
        if os.path.isfile(explicit):
            try:
                return Path(explicit).read_text()
            except OSError as e:
                print(f"WARN could not read DNS credentials file {explicit}: {e}", file=sys.stderr)
                return ""
        return explicit
    if dns_provider == "rfc2136":
        nameserver = args.tsig_nameserver or cfg(args, "NPM_TSIG_NAMESERVER", "")
        key_name = args.tsig_key_name or cfg(args, "NPM_TSIG_KEY_NAME", "")
        key_secret = args.tsig_key_secret or cfg(args, "NPM_TSIG_KEY_SECRET", "")
        if nameserver and key_name and key_secret:
            algorithm = args.tsig_algorithm or cfg(args, "NPM_TSIG_ALGORITHM", "HMAC-SHA256")
            port = args.tsig_port or cfg(args, "NPM_TSIG_PORT", "53")
            return build_rfc2136_credentials(nameserver, key_name, key_secret, algorithm, port)
    return ""


# ── Cerulean Authentik forward auth ─────────────────────────────────────
# Injected as each proxy host's nginx "advanced config": an auth_request
# against the Authentik embedded outpost. The outpost runs the domain-level
# proxy provider (`zeus-npm-forward-auth`), so ONE provider covers every host
# under zeus.innotel.us — the outpost matches a request by X-Forwarded-Host.
#
# Only hosts that keep a LOCAL login of their own are gated: FreePBX,
# AvantFAX and the NPM admin UI. Everything else opts out with
# `"forward_auth": False` in HOSTS — `auth` (Authentik itself), the portal
# hosts and `api` (the portal already signs in through Authentik and its API is
# called programmatically) and `ws` (the softphone's WSS signaling can't
# present an interactive login). Same pattern as 2-voice/capstone.
#
# `admin` used to opt out on the reasoning that gating the UI locks you out of
# the thing serving the gate. It does not any more: the admin UI signs in
# through the gate (NPM Edge forward-auth sign-in), and the way back in if the
# gate ever misconfigures is the admin port on the LAN, not the public host.
#
# NOTE: braces are doubled for .format() — only {outpost_url} is a field.
FORWARD_AUTH_SNIPPET = """\
# ── Cerulean Authentik forward auth (managed by npm-proxy-hosts.py) ──
# Increase buffer size for large headers (SSO redirects are big).
proxy_buffers 8 16k;
proxy_buffer_size 32k;
auth_request /outpost.goauthentik.io/auth/nginx;
error_page 401 = @goauthentik_proxy_signin;
auth_request_set $auth_cookie $upstream_http_set_cookie;
add_header Set-Cookie $auth_cookie;
auth_request_set $authentik_username $upstream_http_x_authentik_username;
auth_request_set $authentik_groups $upstream_http_x_authentik_groups;
auth_request_set $authentik_email $upstream_http_x_authentik_email;
auth_request_set $authentik_name $upstream_http_x_authentik_name;
auth_request_set $authentik_uid $upstream_http_x_authentik_uid;
proxy_set_header X-authentik-username $authentik_username;
proxy_set_header X-authentik-groups $authentik_groups;
proxy_set_header X-authentik-email $authentik_email;
proxy_set_header X-authentik-name $authentik_name;
proxy_set_header X-authentik-uid $authentik_uid;
location /outpost.goauthentik.io {{
    proxy_pass {outpost_url}/outpost.goauthentik.io;
    proxy_set_header Host $host;
    proxy_set_header X-Original-URL $scheme://$http_host$request_uri;
    # The outpost runs the forward-auth provider in `forward_domain` mode and
    # identifies which app a request belongs to from the forwarded host. These
    # live in NPM's generated `location /`, which a custom location does NOT
    # inherit — without them the embedded outpost logs "failed to detect a
    # forward URL from nginx" and 401s/500s the auth subrequest.
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    add_header Set-Cookie $auth_cookie;
    auth_request_set $auth_cookie $upstream_http_set_cookie;
    proxy_pass_request_body off;
    proxy_set_header Content-Length "";
}}
location @goauthentik_proxy_signin {{
    internal;
    add_header Set-Cookie $auth_cookie;
    return 302 {signin_url}/outpost.goauthentik.io/start?rd=$scheme://$http_host$request_uri;
}}
"""


def forward_auth_snippet(outpost_url: str, signin_url: str) -> str:
    """Render the auth_request nginx snippet for one proxy host.

    outpost_url is server-side only (NPM → Authentik over the LAN, direct —
    never through NPM's own vhosts); signin_url is what the BROWSER is
    redirected to on 401, so it must be the public auth domain.
    """
    return FORWARD_AUTH_SNIPPET.format(outpost_url=outpost_url.rstrip("/"),
                                       signin_url=signin_url.rstrip("/"))


def build_outpost_url(upstream_host: str) -> str:
    """URL of the Authentik embedded outpost as NPM reaches it.

    NPM must hit the outpost DIRECTLY (http://<upstream>:9000) — routing it
    through https://auth.<domain> would re-enter NPM's own vhost selection
    with the app's Host header and loop the request back to the app vhost.
    """
    return f"http://{upstream_host}:9000"


def resolve_forward_auth(args: argparse.Namespace, env: dict[str, str],
                         upstream: str, base_domain: str) -> tuple[bool, str, str, set[str]]:
    """Resolve forward-auth settings: (enabled, outpost_url, signin_url, excluded)."""
    enabled = True  # default ON — that's the point of the Cerulean SSO gate
    if cfg(args, "NPM_FORWARD_AUTH", "").strip().lower() in {"0", "false", "no", "off"}:
        enabled = False
    if args.no_forward_auth:
        enabled = False
    excluded = {s.strip() for s in cfg(args, "NPM_FORWARD_AUTH_EXCLUDE", "").split(",") if s.strip()}
    if "all" in excluded:
        enabled = False
    outpost = build_outpost_url(upstream)
    signin_url = (cfg(args, "NPM_AUTHENTIK_URL", "") or "").strip().rstrip("/")
    if not signin_url and base_domain:
        signin_url = f"https://auth.{base_domain}"
    if not signin_url:
        signin_url = outpost
    return enabled, outpost, signin_url, excluded


def snippet_for_host(h: dict, enabled: bool, outpost_url: str, signin_url: str,
                     excluded: set[str]) -> str:
    """The auth snippet this host should carry ('' = no forward auth)."""
    if not enabled:
        return ""
    if h.get("forward_auth") is False:  # explicit per-host opt-out in HOSTS
        return ""
    if h["key"] in excluded:
        return ""
    return forward_auth_snippet(outpost_url, signin_url)


def build_payload(domain: str, h: dict, forward_host: str,
                  cert_id: int | None, ssl: bool, auth_snippet: str = "") -> dict:
    return {
        "domain_names": [domain],
        "forward_scheme": h["scheme"],
        "forward_host": forward_host,
        "forward_port": h["port"],
        "certificate_id": cert_id if ssl else None,
        "ssl_forced": ssl,
        "block_exploits": True,
        "caching_enabled": False,
        "allow_websocket_upgrade": h["websocket"],
        "access_list_id": "0",
        "advanced_config": auth_snippet,
        "meta": {"letsencrypt_agree": False, "dns_challenge": False},
        "locations": [],
        "hsts_enabled": False,
        "hsts_subdomains": False,
        "http2_support": True,
        "enabled": True,
    }


def ensure_cert(api: NpmApi, domains: list[str], le_email: str,
                dns_provider: str, dns_credentials: str,
                check: bool, certs_by_domain: dict[str, int],
                failed: list[str]) -> int | None:
    """Return the cert id covering `domains`, creating it when missing.

    With DNS provider credentials set, issues the cert via DNS-01 (required
    for wildcard names). `dns_credentials` is the RAW credentials file
    content NPM writes to disk for certbot (for rfc2136 this is the TSIG
    INI, auto-built from the NPM_TSIG_* vars). Without it, uses the default
    HTTP-01 challenge. In --check mode never writes.
    """
    for d in domains:
        cid = certs_by_domain.get(d.lower())
        if cid is not None:
            return cid
    label = ", ".join(domains)
    if check:
        print(f"FAIL no Let's Encrypt certificate for {label}")
        failed.append(domains[0])
        return None
    meta = {"letsencrypt_email": le_email, "letsencrypt_agree": True, "dns_challenge": False}
    if dns_provider and dns_credentials:
        meta.update({
            "dns_challenge": True,
            "dns_provider": dns_provider,
            "dns_provider_credentials": dns_credentials,
        })
    try:
        cert = api.create_certificate({
            "provider": "letsencrypt",
            "domain_names": domains,
            "meta": meta,
        })
        cid = cert.get("id")
        for d in domains:
            certs_by_domain[d.lower()] = cid
        print(f"PASS requested Let's Encrypt certificate for {label} (id {cid})")
        return cid
    except (NpmError, urllib.error.URLError, OSError) as e:
        print(f"FAIL could not create certificate for {label}: {e}", file=sys.stderr)
        failed.append(domains[0])
        return None


def desired(domain: str, h: dict, forward_host: str,
            cert_id: int | None, ssl: bool, auth_snippet: str = "") -> dict:
    """The field values we own, used to diff an existing host against the map."""
    return {
        "domain_names": [domain],
        "forward_scheme": h["scheme"],
        "forward_host": forward_host,
        "forward_port": h["port"],
        "allow_websocket_upgrade": h["websocket"],
        "ssl_forced": ssl,
        "certificate_id": cert_id if cert_id else None,  # NPM wants null, not 0
        "advanced_config": auth_snippet,
        "enabled": True,
    }


def main() -> int:
    repo = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api-url", default=None, help="NPM base URL (env NPM_API_URL)")
    parser.add_argument("--email", default=None, help="NPM admin email (env NPM_ADMIN_EMAIL)")
    parser.add_argument("--password", default=None, help="NPM admin password (env NPM_ADMIN_PASSWORD)")
    parser.add_argument("--api-token", default=None, help="persistent NPM API token (env NPM_API_TOKEN)")
    parser.add_argument("--base-domain", default=None, help="base domain, e.g. zeus.innotel.us (env NPM_BASE_DOMAIN)")
    parser.add_argument("--upstream-host", default=None, help="Docker host IP NPM forwards to (env NPM_UPSTREAM_HOST)")
    parser.add_argument("--npm-host-ip", default=None,
                        help="IP of the NPM host itself — upstream for the admin.<domain> host "
                             "(env NPM_HOST_IP); falls back to --upstream-host")
    parser.add_argument("--letsencrypt-email", default=None, help="email for Let's Encrypt certs (env NPM_LETSENCRYPT_EMAIL)")
    parser.add_argument("--wildcard", action="store_true",
                        help="issue ONE wildcard cert (*.base + base) via DNS-01 and attach it to every host (env NPM_WILDCARD_CERT)")
    parser.add_argument("--dns-provider", default=None,
                        help="DNS provider slug for the wildcard cert (default rfc2136 — TSIG); env NPM_DNS_PROVIDER")
    parser.add_argument("--dns-credentials", default=None,
                        help="raw DNS-provider credentials content (or path to a credentials file); env NPM_DNS_PROVIDER_CREDENTIALS")
    parser.add_argument("--tsig-nameserver", default=None,
                        help="TSIG-enabled DNS server (host or host:port); env NPM_TSIG_NAMESERVER")
    parser.add_argument("--tsig-key-name", default=None,
                        help="TSIG key name; env NPM_TSIG_KEY_NAME")
    parser.add_argument("--tsig-key-secret", default=None,
                        help="TSIG key secret (base64); env NPM_TSIG_KEY_SECRET")
    parser.add_argument("--tsig-algorithm", default=None,
                        help="TSIG algorithm (default HMAC-SHA256); env NPM_TSIG_ALGORITHM")
    parser.add_argument("--tsig-port", default=None,
                        help="TSIG DNS server port (default 53); env NPM_TSIG_PORT")
    parser.add_argument("--ws-scheme", choices=["http", "https"], default=None,
                        help="upstream scheme for the ws.<domain> host (default https)")
    parser.add_argument("--ws-port", type=int, default=None,
                        help="upstream port for the ws.<domain> host (default 8089; use 8088 with --ws-scheme http)")
    parser.add_argument("--no-ssl", action="store_true", help="skip certificates and HTTPS forcing")
    parser.add_argument("--no-forward-auth", action="store_true",
                        help="do not put Authentik forward auth in front of the PBX/AvantFAX hosts "
                             "(NPM_FORWARD_AUTH=0 does the same for every host)")
    parser.add_argument("--no-prune", action="store_true", help="never delete NPM hosts")
    parser.add_argument("--check", action="store_true", help="verify only — no writes, exit 1 if out of sync")
    parser.add_argument("--env-file", default=str(repo / ".env"), help="zeus .env path")
    args = parser.parse_args()
    args.env = load_env_file(Path(args.env_file))

    api_url = args.api_url or cfg(args, "NPM_API_URL", DEFAULT_API_URL)

    # Guard against a stale ambient NPM_* environment: cfg() lets the real
    # environment win over this repo's .env, so a leftover NPM_BASE_DOMAIN
    # exported by another stack makes this script manage and PRUNE that other
    # service's proxy hosts. Refuse rather than write to a domain this repo
    # does not own.
    ambient_domain = (os.environ.get("NPM_BASE_DOMAIN") or "").strip().lstrip(".").lower()
    env_domain = (args.env.get("NPM_BASE_DOMAIN") or "").strip().lstrip(".").lower()
    if ambient_domain and env_domain and ambient_domain != env_domain and not args.base_domain:
        print(f"FAIL NPM_BASE_DOMAIN={ambient_domain} is exported in the environment but this "
              f"repo's .env says {env_domain} — refusing to touch {ambient_domain} hosts "
              f"(unset the variable, or pass --base-domain explicitly).", file=sys.stderr)
        return 1

    base_domain = (args.base_domain or cfg(args, "NPM_BASE_DOMAIN", "")).strip().lstrip(".")
    upstream = args.upstream_host or cfg(args, "NPM_UPSTREAM_HOST", "")
    npm_host_ip = args.npm_host_ip or cfg(args, "NPM_HOST_IP", "")
    le_email = args.letsencrypt_email or cfg(args, "NPM_LETSENCRYPT_EMAIL", "")

    if not base_domain:
        print("FAIL NPM_BASE_DOMAIN is empty — set it in .env (e.g. zeus.innotel.us)", file=sys.stderr)
        return 1
    if not upstream:
        print("FAIL NPM_UPSTREAM_HOST is empty — set the Docker host IP NPM forwards to in .env",
              file=sys.stderr)
        return 1

    # DNS provider + credentials for the wildcard/per-host Let's Encrypt certs.
    # For rfc2136 (TSIG) the NPM_TSIG_* vars build the credentials file content
    # automatically — no credential needs to be saved in NPM by hand.
    dns_provider = args.dns_provider or cfg(args, "NPM_DNS_PROVIDER", "") or DEFAULT_DNS_PROVIDER
    dns_credentials = resolve_dns_credentials(args, dns_provider)
    if dns_credentials:
        print(f"PASS DNS provider credentials ready ({dns_provider} — {len(dns_credentials)} bytes)")

    # Cerulean Authentik forward auth. One domain-level proxy provider covers
    # the whole zeus.innotel.us zone, so a gated host only needs the
    # auth_request snippet in its nginx "advanced config" — see
    # FORWARD_AUTH_SNIPPET for which hosts opt out and why.
    fa_enabled, fa_outpost, fa_signin, fa_excluded = resolve_forward_auth(
        args, args.env, upstream, base_domain)
    if fa_enabled:
        gated = [h["key"] for h in HOSTS
                 if snippet_for_host(h, True, fa_outpost, fa_signin, fa_excluded)]
        print(f"PASS Authentik forward auth on for {len(gated)} host(s): "
              f"{', '.join(gated) or '(none)'} (outpost {fa_outpost}, sign-in {fa_signin})")
    else:
        print("WARN Authentik forward auth is OFF — the PBX and AvantFAX hosts would not "
              "require a Cerulean session", file=sys.stderr)

    hosts = [dict(h) for h in HOSTS]
    if args.ws_scheme is not None or args.ws_port is not None:
        for h in hosts:
            if h["key"] == "ws":
                if args.ws_scheme is not None:
                    h["scheme"] = args.ws_scheme
                if args.ws_port is not None:
                    h["port"] = args.ws_port

    # Auth
    api = NpmApi(api_url)
    token = args.api_token or cfg(args, "NPM_API_TOKEN", "")
    if token:
        api.token = token
    else:
        identity = args.email or cfg(args, "NPM_ADMIN_EMAIL", "")
        secret = args.password or cfg(args, "NPM_ADMIN_PASSWORD", "")
        if not identity or not secret:
            print("FAIL NPM_ADMIN_EMAIL/NPM_ADMIN_PASSWORD (or NPM_API_TOKEN) required", file=sys.stderr)
            return 1
        try:
            api.login(identity, secret)
        except (NpmError, urllib.error.URLError, OSError) as e:
            print(f"FAIL NPM login failed ({api_url}): {e}", file=sys.stderr)
            return 1
    print("PASS authenticated with Nginx Proxy Manager")

    try:
        existing_hosts = api.proxy_hosts()
    except (NpmError, urllib.error.URLError, OSError) as e:
        print(f"FAIL could not list NPM proxy hosts: {e}", file=sys.stderr)
        return 1

    # Domain → existing host
    by_domain: dict[str, dict] = {}
    for eh in existing_hosts:
        for d in eh.get("domain_names") or []:
            by_domain.setdefault(d.lower(), eh)

    # Certificates: reuse a cert that already covers our domain.
    certs_by_domain: dict[str, int] = {}
    try:
        for c in api.certificates():
            for d in c.get("domain_names") or []:
                certs_by_domain.setdefault(d.lower(), c["id"])
    except (NpmError, urllib.error.URLError, OSError) as e:
        print(f"WARN could not list NPM certificates ({e}) — continuing without SSL")

    ssl = not args.no_ssl and bool(le_email)
    if not ssl and not args.no_ssl:
        print("WARN NPM_LETSENCRYPT_EMAIL not set — creating hosts without SSL (pass --no-ssl to silence)")

    # Wildcard mode: ONE cert covering "*.base + base" issued via DNS-01 and
    # auto-attached to every host. Requires DNS-provider credentials: either
    # explicit NPM_DNS_PROVIDER_CREDENTIALS (raw content) or the TSIG vars
    # (NPM_TSIG_*), which build the rfc2136 credentials automatically. Without
    # them we fall back to per-host HTTP-01 certs.
    wildcard = args.wildcard or cfg(args, "NPM_WILDCARD_CERT", "").lower() in {"1", "true", "yes", "on"}
    if wildcard and ssl and not dns_credentials:
        print("WARN wildcard requested but no DNS credentials found (NPM_DNS_PROVIDER_CREDENTIALS "
              "or NPM_TSIG_NAMESERVER/KEY_NAME/KEY_SECRET) — falling back to per-host HTTP-01 "
              "certificates", file=sys.stderr)
        wildcard = False
    if wildcard and not ssl:
        wildcard = False

    # Hosts (like admin.<domain>) that forward somewhere other than the Docker
    # host — resolved here so the fallback warns exactly once.
    def forward_host(h: dict) -> str:
        # A row may pin its own upstream outright (admin.<domain> pins the NPM
        # admin UI's loopback: nginx runs beside it, and the app only trusts the
        # edge's identity headers there).
        pinned = h.get("forward_host")
        if pinned:
            return pinned
        key = h.get("host_key")
        if not key:
            return upstream
        value = npm_host_ip if key == "NPM_HOST_IP" else cfg(args, key, "")
        if not value:
            print(f"WARN {key} not set — {h['name']} falls back to NPM_UPSTREAM_HOST ({upstream})",
                  file=sys.stderr)
            return upstream
        return value

    created = updated = ok = pruned = 0
    failed: list[str] = []
    managed_domains: set[str] = set()

    # Issue the single wildcard cert up front; every host then reuses it.
    wc_id = None
    if wildcard:
        wc_id = ensure_cert(api, [f"*.{base_domain}", base_domain], le_email,
                            dns_provider, dns_credentials, args.check,
                            certs_by_domain, failed)
        if wc_id is None:
            if args.check:
                print("FAIL wildcard certificate missing — proxy hosts out of sync", file=sys.stderr)
                return 1
            print("WARN wildcard certificate could not be issued — continuing per host", file=sys.stderr)

    for h in hosts:
        domain = base_domain if h["sub"] is None else f"{h['sub']}.{base_domain}"
        managed_domains.add(domain)
        label = h["name"]
        auth_snippet = snippet_for_host(h, fa_enabled, fa_outpost, fa_signin, fa_excluded)
        existing = by_domain.get(domain.lower())

        # In wildcard mode every host attaches the one *.base cert: looking up
        # the exact hostname would never match it (NPM stores the wildcard name
        # literally), so each host would otherwise mint its own cert.
        cert_id = None
        if ssl:
            cert_id = wc_id or ensure_cert(api, [domain], le_email, dns_provider, dns_credentials,
                                          args.check, certs_by_domain, failed)
            if cert_id is None:
                continue

        fwd = forward_host(h)
        want = desired(domain, h, fwd, cert_id, ssl, auth_snippet)
        if existing is None:
            if args.check:
                print(f"FAIL {label} — proxy host {domain} missing")
                failed.append(domain)
                continue
            try:
                api.create_proxy_host(build_payload(domain, h, fwd, cert_id, ssl, auth_snippet))
                created += 1
                print(f"PASS {label} — created {domain} → {h['scheme']}://{fwd}:{h['port']}")
            except (NpmError, urllib.error.URLError, OSError) as e:
                print(f"FAIL {label} — could not create {domain}: {e}", file=sys.stderr)
                failed.append(domain)
            continue

        # Compare only the fields we manage (certificate_id normalised None/0).
        diffs: list[str] = []
        for k, v in want.items():
            cur = existing.get(k)
            if k == "certificate_id":
                cur, v = int(cur or 0), int(v or 0)
            elif k == "domain_names":
                cur, v = sorted(cur or []), sorted(v)
            if cur != v:
                diffs.append(k)
        if not diffs:
            ok += 1
            print(f"PASS {label} — {domain} already correct")
            continue
        if args.check:
            print(f"FAIL {label} — {domain} out of date ({', '.join(diffs)})")
            failed.append(domain)
            continue
        try:
            # Send the managed fields in the SAME shape the create path uses.
            # Echoing the fetched object back (the obvious `dict(existing) +
            # want`) breaks on hosts created by an older NPM: those rows carry
            # read-only properties (id, created_on, modified_on,
            # owner_user_id) and `locations: null`, which the update schema
            # rejects with "must NOT have additional properties".
            payload = build_payload(domain, h, fwd, cert_id, ssl, auth_snippet)
            payload.update(want)
            api.update_proxy_host(existing["id"], payload)
            updated += 1
            print(f"PASS {label} — updated {domain} ({', '.join(diffs)})")
        except (NpmError, urllib.error.URLError, OSError) as e:
            print(f"FAIL {label} — could not update {domain}: {e}", file=sys.stderr)
            failed.append(domain)

    # Prune: hosts under our base domain that are no longer in the map.
    if not args.no_prune:
        scope_suffix = f".{base_domain}"
        for eh in existing_hosts:
            doms = eh.get("domain_names") or []
            in_scope = any(d.lower() == base_domain or d.lower().endswith(scope_suffix) for d in doms)
            if not in_scope:
                continue
            if any(d.lower() in managed_domains for d in doms):
                continue
            if args.check:
                print(f"FAIL stale NPM host would be pruned: {', '.join(doms)}")
                failed.append(doms[0])
                continue
            try:
                api.delete_proxy_host(eh["id"])
                pruned += 1
                print(f"PASS pruned stale NPM host {', '.join(doms)}")
            except (NpmError, urllib.error.URLError, OSError) as e:
                print(f"FAIL could not prune {', '.join(doms)}: {e}", file=sys.stderr)
                failed.append(doms[0])

    if args.check:
        if failed:
            print(f"FAIL {len(failed)} host(s) out of sync", file=sys.stderr)
            return 1
        print(f"PASS all {len(hosts)} proxy hosts in sync")
        return 0

    print(f"PASS sync complete — created {created}, updated {updated}, unchanged {ok}, pruned {pruned}, failed {len(failed)}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())