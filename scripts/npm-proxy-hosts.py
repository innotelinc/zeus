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
    {"key": "apex", "sub": None, "scheme": "http", "port": 3000, "websocket": False, "name": "Zeus Portal (apex origin)"},
    {"key": "app", "sub": "app", "scheme": "http", "port": 3000, "websocket": True, "name": "Zeus Customer Portal (PWA)"},
    {"key": "api", "sub": "api", "scheme": "http", "port": 3000, "websocket": False, "name": "Zeus Portal API"},
    {"key": "portal", "sub": "portal", "scheme": "http", "port": 3000, "websocket": False, "name": "Zeus Customer Portal (alias)"},
    {"key": "auth", "sub": "auth", "scheme": "http", "port": 9000, "websocket": False, "name": "Authentik (SSO / user management)"},
    {"key": "pbx", "sub": "pbx", "scheme": "http", "port": 80, "websocket": False, "name": "FreePBX"},
    {"key": "admin", "sub": "admin", "scheme": "http", "port": 81, "websocket": True, "name": "Nginx Proxy Manager admin UI"},
    {"key": "ws", "sub": "ws", "scheme": "https", "port": 8089, "websocket": True, "name": "WebRTC WSS signaling (softphone)"},
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


def build_payload(domain: str, h: dict, forward_host: str,
                  cert_id: int | None, ssl: bool) -> dict:
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
        "advanced_config": "",
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
            cert_id: int | None, ssl: bool) -> dict:
    """The field values we own, used to diff an existing host against the map."""
    return {
        "domain_names": [domain],
        "forward_scheme": h["scheme"],
        "forward_host": forward_host,
        "forward_port": h["port"],
        "allow_websocket_upgrade": h["websocket"],
        "ssl_forced": ssl,
        "certificate_id": cert_id if cert_id else None,  # NPM wants null, not 0
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
    parser.add_argument("--no-prune", action="store_true", help="never delete NPM hosts")
    parser.add_argument("--check", action="store_true", help="verify only — no writes, exit 1 if out of sync")
    parser.add_argument("--env-file", default=str(repo / ".env"), help="zeus .env path")
    args = parser.parse_args()
    args.env = load_env_file(Path(args.env_file))

    api_url = args.api_url or cfg(args, "NPM_API_URL", DEFAULT_API_URL)
    base_domain = (args.base_domain or cfg(args, "NPM_BASE_DOMAIN", "")).strip().lstrip(".")
    upstream = args.upstream_host or cfg(args, "NPM_UPSTREAM_HOST", "")
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

    created = updated = ok = pruned = 0
    failed: list[str] = []
    managed_domains: set[str] = set()

    # Issue the single wildcard cert up front; every host then reuses it.
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
        existing = by_domain.get(domain.lower())

        cert_id = None
        if ssl:
            cert_id = ensure_cert(api, [domain], le_email, dns_provider, dns_credentials,
                                  args.check, certs_by_domain, failed)
            if cert_id is None:
                continue

        want = desired(domain, h, upstream, cert_id, ssl)
        if existing is None:
            if args.check:
                print(f"FAIL {label} — proxy host {domain} missing")
                failed.append(domain)
                continue
            try:
                api.create_proxy_host(build_payload(domain, h, upstream, cert_id, ssl))
                created += 1
                print(f"PASS {label} — created {domain} → {h['scheme']}://{upstream}:{h['port']}")
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
            payload = dict(existing)
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