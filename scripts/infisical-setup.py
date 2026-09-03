#!/usr/bin/env python3
"""Bootstrap Infisical (SecretOps) for this stack — Innotel Platform Stack.

Creates (idempotently) the instance admin, an organization, a workspace for
this platform, and imports the stack's .env values as secrets, then writes a
scoped service token back into .env so credentials live in Infisical and the
.env is derived from it.

Usage:
    python3 scripts/infisical-setup.py [--force]

Reads from .env (or the environment):
    INFISICAL_ADDR            base URL, default http://localhost:<INFISICAL_PORT|8383>
    INFISICAL_ADMIN_EMAIL     bootstrap admin email (required on first run)
    INFISICAL_ADMIN_PASSWORD  bootstrap admin password (required on first run)
    INFISICAL_ORG             organization name, default "Innotel"
    INFISICAL_WORKSPACE_NAME  workspace name, default "<platform>-secrets"

Writes into .env:
    INFISICAL_ADDR, INFISICAL_ORG, INFISICAL_WORKSPACE_ID,
    INFISICAL_ENVIRONMENT, INFISICAL_TOKEN

Python 3 stdlib only — no external dependencies.
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ENV_FILE = Path(".env")
ENV_EXAMPLE = Path(".env.example")


def parse_env(text: str):
    out = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip()
        if (value.startswith('"') and value.endswith('"')) or (
            value.startswith("'") and value.endswith("'")
        ):
            value = value[1:-1]
        out[key] = value
    return out


def load_env_file() -> dict:
    if ENV_FILE.exists():
        return parse_env(ENV_FILE.read_text())
    if ENV_EXAMPLE.exists():
        print("note: .env not found — reading default values from .env.example", file=sys.stderr)
        return parse_env(ENV_EXAMPLE.read_text())
    return {}


def write_env(key: str, value: str, env: dict) -> None:
    """Set key=value in .env (create it if missing), preserving other lines."""
    path = ENV_FILE if ENV_FILE.exists() else ENV_EXAMPLE
    lines = path.read_text().splitlines() if path.exists() else []
    if not ENV_FILE.exists():
        lines = []
    pattern = re.compile(rf"^{re.escape(key)}=.*$")
    found = False
    for i, line in enumerate(lines):
        if pattern.match(line):
            lines[i] = f"{key}={value}"
            found = True
            break
    if not found:
        lines.append(f"{key}={value}")
    ENV_FILE.write_text("\n".join(lines) + "\n")
    env[key] = value


class Api:
    def __init__(self, base: str):
        self.base = base.rstrip("/")
        self.token: str | None = None

    def _headers(self) -> dict:
        h = {"Content-Type": "application/json", "Accept": "application/json"}
        if self.token:
            h["Authorization"] = f"Bearer {self.token}"
        return h

    def request(self, method: str, path: str, body=None, timeout: int = 20):
        url = f"{self.base}{path}"
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, headers=self._headers(), method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read().decode()
                return resp.status, (json.loads(raw) if raw else None)
        except urllib.error.HTTPError as e:
            raw = e.read().decode() if e.fp else ""
            try:
                payload = json.loads(raw) if raw else None
            except ValueError:
                payload = raw
            return e.code, payload

    def get(self, path: str):
        return self.request("GET", path)

    def post(self, path: str, body: dict):
        return self.request("POST", path, body)

    def wait_ready(self, tries: int = 30, delay: float = 2.0) -> bool:
        for _ in range(tries):
            try:
                status, data = self.request("GET", "/api/status", timeout=5)
                if status == 200 and isinstance(data, dict) and data.get("status") == "ok":
                    return True
            except Exception:
                pass
            time.sleep(delay)
        return False


def main() -> int:
    env = load_env_file()
    force = "--force" in sys.argv

    base = (
        os.environ.get("INFISICAL_ADDR")
        or env.get("INFISICAL_ADDR")
        or f"http://localhost:{env.get('INFISICAL_PORT', '8383')}"
    )
    admin_email = os.environ.get("INFISICAL_ADMIN_EMAIL") or env.get("INFISICAL_ADMIN_EMAIL", "")
    admin_password = os.environ.get("INFISICAL_ADMIN_PASSWORD") or env.get("INFISICAL_ADMIN_PASSWORD", "")
    org_name = env.get("INFISICAL_ORG", "Innotel")
    ws_name = env.get("INFISICAL_WORKSPACE_NAME") or "platform-secrets"

    api = Api(base)

    # Already provisioned? Verify the stored token still works.
    existing_token = env.get("INFISICAL_TOKEN", "")
    existing_ws = env.get("INFISICAL_WORKSPACE_ID", "")
    if existing_token and existing_ws and not force:
        api.token = existing_token
        status, data = api.get(
            f"/api/v3/secrets/raw/__probe__?workspaceId={existing_ws}&environment={env.get('INFISICAL_ENVIRONMENT', 'prod')}"
        )
        if status in (200, 404):
            print(f"infisical: already provisioned ({base}, workspace {existing_ws})")
            return 0
        print("infisical: stored token invalid — re-provisioning", file=sys.stderr)

    print(f"infisical: waiting for {base}/api/status ...")
    if not api.wait_ready():
        print(
            f"error: Infisical is not responding at {base}. Start the profile first:\n"
            "  docker compose -f docker-compose.yml -f compose.infisical.yml --profile infisical up -d",
            file=sys.stderr,
        )
        return 1

    # ── 1. Admin bootstrap + login ────────────────────────────────────
    if not admin_email or not admin_password:
        print(
            "error: INFISICAL_ADMIN_EMAIL / INFISICAL_ADMIN_PASSWORD are required "
            "(add them to .env and re-run)",
            file=sys.stderr,
        )
        return 1

    status, data = api.post("/api/v1/auth/login", {"email": admin_email, "password": admin_password})
    if status != 200:
        # First boot: try to register this admin via the self-host bootstrap
        # endpoint. If the endpoint doesn't exist on this version, instruct
        # the operator to create the admin in the UI once.
        status, data = api.post(
            "/api/v1/auth/register-admin-signup",
            {"email": admin_email, "password": admin_password, "firstName": "Innotel", "lastName": "Admin"},
        )
        if status in (200, 201):
            print("infisical: bootstrap admin created")
        else:
            print(
                "error: could not log in as the admin and the automated bootstrap endpoint is "
                "unavailable (HTTP %s). Create the admin once at %s with INFISICAL_ADMIN_EMAIL, "
                "then re-run this script."
                % (status, base),
                file=sys.stderr,
            )
            return 1
        status, data = api.post("/api/v1/auth/login", {"email": admin_email, "password": admin_password})
        if status != 200:
            print(f"error: admin login failed (HTTP {status}): {data}", file=sys.stderr)
            return 1

    api.token = data["accessToken"]

    # ── 2. Organization (reuse by name) ───────────────────────────────
    ws_id = None
    org_id = None
    status, data = api.get("/api/v1/organization")
    if status == 200 and isinstance(data, list):
        for org in data:
            if org.get("name") == org_name:
                org_id = org["id"]
                break
    if not org_id:
        status, data = api.post("/api/v2/organizations", {"name": org_name})
        if status not in (200, 201):
            print(f"error: create organization failed (HTTP {status}): {data}", file=sys.stderr)
            return 1
        org_id = data["organization"]["id"]
        print(f"infisical: organization '{org_name}' created")
    else:
        print(f"infisical: organization '{org_name}' exists")

    # ── 3. Workspace (reuse by name) ──────────────────────────────────
    status, data = api.get(f"/api/v1/workspace?organizationId={org_id}")
    if status == 200 and isinstance(data, list):
        for ws in data:
            if ws.get("name") == ws_name:
                ws_id = ws["id"]
                break
    if not ws_id:
        status, data = api.post("/api/v1/workspace", {"organizationId": org_id, "name": ws_name})
        if status not in (200, 201):
            print(f"error: create workspace failed (HTTP {status}): {data}", file=sys.stderr)
            return 1
        ws_id = data["workspace"]["id"]
        print(f"infisical: workspace '{ws_name}' created")
    else:
        print(f"infisical: workspace '{ws_name}' exists")

    # ── 4. Environment (default 'prod') ───────────────────────────────
    environment = "prod"
    status, data = api.get(f"/api/v1/workspace/{ws_id}/environments")
    if status == 200 and isinstance(data, list) and data:
        slugs = [e.get("slug") for e in data]
        environment = "prod" if "prod" in slugs else slugs[0]

    # ── 5. Import .env values as secrets (skip Infisical's own keys) ──
    skip_prefixes = ("INFISICAL_",)
    secrets = [
        {"type": "shared", "secretKey": k, "secretValue": v}
        for k, v in env.items()
        if not k.startswith(skip_prefixes) and k not in ("PATH", "HOME")
    ]
    if secrets:
        status, data = api.post(
            "/api/v3/secrets/batch/raw",
            {"workspaceId": ws_id, "environment": environment, "secrets": secrets},
        )
        if status not in (200, 201):
            print(f"error: secret import failed (HTTP {status}): {str(data)[:300]}", file=sys.stderr)
            return 1
        print(f"infisical: imported {len(secrets)} secrets into '{environment}'")

    # ── 6. Scoped service token → write back into .env ────────────────
    status, data = api.post(
        "/api/v1/service-token",
        {
            "name": f"{ws_name}-bootstrap",
            "workspaceId": ws_id,
            "scopes": [{"environment": environment, "path": "/"}],
            "expiresIn": 31536000,  # 1 year
        },
    )
    if status not in (200, 201):
        print(f"error: service-token creation failed (HTTP {status}): {str(data)[:300]}", file=sys.stderr)
        return 1
    service_token = data["serviceToken"]

    write_env("INFISICAL_ADDR", base, env)
    write_env("INFISICAL_ORG", org_name, env)
    write_env("INFISICAL_WORKSPACE_ID", ws_id, env)
    write_env("INFISICAL_ENVIRONMENT", environment, env)
    write_env("INFISICAL_TOKEN", service_token, env)

    print("infisical: provisioned ✔")
    print(f"  addr:       {base}")
    print(f"  workspace:  {ws_name} ({ws_id})")
    print(f"  environment:{environment}")
    print("  token:      written to .env as INFISICAL_TOKEN")
    print("Secrets now live in Infisical; .env is derived from it. Re-run this script to re-sync.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)