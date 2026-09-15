#!/usr/bin/env python3
"""Move a stack's secrets into Cerulean Vault (HashiCorp Vault, KV v2).

Cerulean is the platform's SecretOps layer: a durable, file-backed Vault with KV
v2 mounted at ``VAULT_PREFIX`` and a periodic token scoped to the product's own
path under it (the ``<product>`` policy — Cerulean mints it and renews it). This
script moves secrets *into* that store from wherever they live today — an
Infisical workspace (the legacy SecretOps platform) or a plaintext ``.env`` —
and writes them as one KV v2 secret at ``<prefix>/<path>``.

After it runs, ``.env`` may carry a reference instead of the value:

    OPENAI_LIKE_API_KEY=vault://cerulean/distro#OPENAI_LIKE_API_KEY

which is the ``vault://<mount>/<path>#<key>`` convention Cerulean resolves at
startup, so the stack and the platform agree on one format.

Nothing here is destructive. The target secret is read first and the write is a
union, so keys already in Vault are preserved; a re-run with nothing new reports
"already in sync" and writes nothing. Values are never printed — only key names,
and the script refuses to run if the target path is a KV **v1** mount (v1 has no
versioning and cannot hold secrets the way these stacks expect).

Every address and credential comes from the environment — nothing is hardcoded
here, because this file is tracked in a public repository.

Required (Vault side):
    VAULT_ADDR          e.g. http://vault:8200
    VAULT_TOKEN         a token with write access to VAULT_PATH — the
                        path-scoped ``<product>`` policy, NOT the platform's
                        mount-wide ``cerulean`` one (or VAULT_TOKEN_FILE)
    VAULT_PREFIX        KV v2 mount point (Cerulean default: cerulean)

Optional (Vault side):
    VAULT_PATH          path under the mount — the product's own name
    VAULT_NAMESPACE     Enterprise namespaces; unused on OSS Vault
    VAULT_SKIP_VERIFY   "1" to accept a self-signed certificate
    VAULT_CACERT        CA bundle for TLS

Source — one of:
    Infisical   INFISICAL_ADDR / INFISICAL_TOKEN / INFISICAL_WORKSPACE_ID
                [+ INFISICAL_ENVIRONMENT (default "prod"), INFISICAL_SECRET_PATH]
    a dotenv    ``--from-env-file .env``
    a subset    ``--keys A,B,C`` narrows either source to those keys

Usage:
    vault-migrate.py --dry-run                  # what would move; nothing written
    vault-migrate.py                            # Infisical → Vault
    vault-migrate.py --from-env-file .env \\
        --keys OPENAI_LIKE_API_KEY,OIDC_CLIENT_SECRET
    vault-migrate.py --keys S3_ACCESS_KEY,S3_SECRET_KEY   # seed from .env keys

Exit codes: 0 migrated (or already in sync), 1 error.
"""
from __future__ import annotations

import argparse
import json
import os
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

DEFAULT_PREFIX = "cerulean"


def fail(message: str) -> "None":
    sys.exit(f"{message}\n")


def require(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        fail(
            f"{name} is not set. Export it (or load your .env) before running this script.\n"
            "See the module docstring for the full list."
        )
    return value


def read_token() -> str:
    """VAULT_TOKEN, else VAULT_TOKEN_FILE — the same order the Vault CLI uses."""
    direct = os.environ.get("VAULT_TOKEN", "").strip()
    if direct:
        return direct

    token_file = os.environ.get("VAULT_TOKEN_FILE", "").strip()
    if not token_file:
        fail(
            "No Vault token. Set VAULT_TOKEN, or VAULT_TOKEN_FILE to a file containing one.\n"
            "On the Cerulean platform each stack's path-scoped token is minted there\n"
            "(VAULT_PRODUCT_TOKENS=<product>) and written to\n"
            "./data/vault/token/<product>.token."
        )

    try:
        token = Path(token_file).read_text(encoding="utf-8").strip()
    except OSError as error:
        fail(f"Could not read VAULT_TOKEN_FILE ({token_file}): {error.strerror}")

    if not token:
        fail(f"VAULT_TOKEN_FILE ({token_file}) is empty.")
    return token


def build_ssl_context() -> "ssl.SSLContext | bool":
    if os.environ.get("VAULT_SKIP_VERIFY", "").strip() in ("1", "true", "yes"):
        return ssl._create_unverified_context()
    cacert = os.environ.get("VAULT_CACERT", "").strip()
    if cacert:
        return ssl.create_default_context(cafile=cacert)
    return True


class Client:
    """Minimal Vault client. Never logs the token."""

    def __init__(self, addr: str, token: str, namespace: str) -> None:
        self.addr = addr.rstrip("/")
        self.token = token
        self.namespace = namespace
        self.context = build_ssl_context()

    def api(self, method: str, path: str, body: dict | None = None) -> tuple[int, dict]:
        url = f"{self.addr}/v1/{path.lstrip('/')}"
        data = json.dumps(body).encode() if body is not None else None

        request = urllib.request.Request(url, data=data, method=method)
        request.add_header("X-Vault-Token", self.token)
        request.add_header("Accept", "application/json")
        if data is not None:
            request.add_header("Content-Type", "application/json")
        if self.namespace:
            request.add_header("X-Vault-Namespace", self.namespace)

        try:
            with urllib.request.urlopen(request, timeout=30, context=self.context) as response:
                payload = response.read()
                return response.status, (json.loads(payload) if payload else {})
        except urllib.error.HTTPError as error:
            detail = error.read().decode(errors="replace").strip()
            try:
                detail = json.dumps(json.loads(detail).get("errors", detail))[:200]
            except Exception:
                detail = detail[:200]
            return error.code, {"errors": detail}
        except urllib.error.URLError as error:
            fail(
                f"Could not reach Vault at {self.addr}: {error.reason}\n"
                "Check VAULT_ADDR, and that the server is unsealed."
            )


def is_kv2_envelope(body: object) -> bool:
    """KV v2 nests the payload under data.data; KV v1 stops at data."""
    if not isinstance(body, dict):
        return False
    outer = body.get("data")
    return isinstance(outer, dict) and isinstance(outer.get("data"), dict)


def ensure_kv2(client: Client, prefix: str, path: str) -> None:
    """KV v2 must be mounted at prefix. Create it if absent, verify if present.

    A scoped token cannot read ``sys/mounts`` (cluster-wide) and should not be
    able to list the mount root either — that would disclose every sibling key's
    name. So when the mount table is unreadable the only honest probe is the
    path we are about to use: a 200 or a 404 both prove the KV v2 *data*
    endpoint is served, and 403 means the grant is wrong.
    """
    status, mounts = client.api("GET", "sys/mounts")

    if status == 403:
        print(f"--- sys/mounts is not readable with this token (scoped) — probing {prefix}/ ---")
        status, _ = client.api("GET", f"{prefix}/data/{path}")
        if status in (200, 404):
            return
        fail(
            f"The token cannot read {prefix}/data/{path} (HTTP {status}).\n"
            f"Grant it a policy covering {prefix}/data/{path} and "
            f"{prefix}/metadata/{path}, then re-run."
        )

    if status != 200:
        fail(f"Reading sys/mounts failed: HTTP {status} — {mounts.get('errors')}")

    existing = (mounts.get("data") or mounts).get(f"{prefix}/")
    if existing is None:
        print(f"--- enabling KV v2 at {prefix}/ ---")
        status, created = client.api(
            "POST", f"sys/mounts/{prefix}", {"type": "kv", "options": {"version": "2"}}
        )
        if status not in (200, 204):
            fail(f"Could not enable KV v2 at {prefix}/: HTTP {status} — {created.get('errors')}")
        print(f"    enabled {prefix}/ as KV v2")
        return

    version = str((existing.get("options") or {}).get("version", "1"))
    if version != "2":
        fail(
            f"{prefix}/ is mounted as KV v{version}, not v2.\n"
            "KV v1 has no versioning or metadata; enable KV v2 at a different prefix\n"
            "(VAULT_PREFIX) or migrate the mount."
        )
    print(f"--- {prefix}/ is KV v2 ---")


def read_target(client: Client, prefix: str, path: str) -> tuple[dict, bool]:
    """Return (existing secret data, mount-is-v2). A 404 reads as empty."""
    status, body = client.api("GET", f"{prefix}/data/{path}")
    if status == 404:
        return {}, True
    if status != 200:
        fail(f"Reading {prefix}/data/{path} failed: HTTP {status} — {body.get('errors')}")
    if not is_kv2_envelope(body):
        fail(
            f"{prefix}/ is not answering as KV v2 (read returned no data.data nesting).\n"
            f"Point VAULT_PREFIX at the KV v2 mount (Cerulean's default is `cerulean`)."
        )
    return (body.get("data") or {}).get("data") or {}, True


# --- sources -----------------------------------------------------------------


def fetch_infisical() -> dict[str, str]:
    """Every secret in one Infisical workspace/environment, via the v3 API."""
    addr = require("INFISICAL_ADDR").rstrip("/")
    token = require("INFISICAL_TOKEN")
    workspace = require("INFISICAL_WORKSPACE_ID")
    environment = os.environ.get("INFISICAL_ENVIRONMENT", "").strip() or "prod"
    secret_path = os.environ.get("INFISICAL_SECRET_PATH", "").strip() or "/"

    url = (
        f"{addr}/api/v3/secrets/raw"
        f"?workspaceId={urllib.parse.quote(workspace)}"
        f"&environment={urllib.parse.quote(environment)}"
        f"&secretPath={urllib.parse.quote(secret_path)}"
    )
    request = urllib.request.Request(url, method="GET")
    request.add_header("Authorization", f"Bearer {token}")
    request.add_header("Accept", "application/json")

    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as error:
        detail = error.read().decode(errors="replace").strip()[:200]
        fail(
            f"Reading from Infisical failed: HTTP {error.code} — {detail}\n"
            "Check INFISICAL_ADDR / INFISICAL_TOKEN / INFISICAL_WORKSPACE_ID, and that the\n"
            "token's machine identity can read this workspace and environment."
        )
    except urllib.error.URLError as error:
        fail(f"Could not reach Infisical at {addr}: {error.reason}")

    entries = payload.get("secrets")
    if not isinstance(entries, list):
        fail(
            "Infisical returned no `secrets` list. Nothing to migrate — check the\n"
            "workspace id and environment."
        )

    source: dict[str, str] = {}
    for entry in entries:
        key = str(entry.get("secretKey", "")).strip()
        if key:
            source[key] = str(entry.get("secretValue", ""))
    return source


def read_env_file(path: str) -> dict[str, str]:
    """Parse a dotenv file. Values here are read, never echoed."""
    file = Path(path)
    if not file.is_file():
        fail(f"--from-env-file: {path} does not exist.")

    source: dict[str, str] = {}
    for raw in file.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :].strip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip("'\"")
        if key:
            source[key] = value
    return source


def is_reference(value: str) -> bool:
    """A value that already points at a store is not a secret to copy."""
    return value.startswith(("vault://", "infisical://"))


# --- put it together ---------------------------------------------------------


def plan(source: dict[str, str], keys: list[str] | None) -> dict[str, str]:
    selected = {k: v for k, v in source.items() if keys is None or k in keys}
    if keys is not None:
        missing = [k for k in keys if k not in selected]
        if missing:
            fail(f"These requested keys were not found in the source: {', '.join(missing)}")
    # An empty value is a placeholder, not a secret.
    return {k: v for k, v in selected.items() if v and not is_reference(v)}


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Move secrets into Cerulean Vault (KV v2).",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--from-env-file",
        metavar="PATH",
        help="read the source from a dotenv file instead of Infisical",
    )
    parser.add_argument(
        "--keys",
        metavar="A,B,C",
        help="only move these keys (comma-separated)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="report what would be written; write nothing",
    )
    parser.add_argument(
        "--prefix",
        metavar="MOUNT",
        help="KV v2 mount point (overrides VAULT_PREFIX)",
    )
    parser.add_argument(
        "--path",
        metavar="PATH",
        help="path under the mount (overrides VAULT_PATH)",
    )
    args = parser.parse_args()

    keys = [k.strip() for k in args.keys.split(",") if k.strip()] if args.keys else None

    if args.from_env_file:
        print(f"--- source: dotenv file {args.from_env_file} ---")
        source = read_env_file(args.from_env_file)
    else:
        print("--- source: Infisical workspace ---")
        source = fetch_infisical()

    payload = plan(source, keys)
    if not payload:
        print("--- nothing to move (no non-empty, non-reference values) ---")
        return 0

    print(f"--- {len(payload)} key(s) to move: {', '.join(sorted(payload))} ---")

    if args.dry_run:
        for key in sorted(payload):
            print(f"    would write {key}")
        print("--- dry run: nothing written ---")
        return 0

    addr = require("VAULT_ADDR")
    token = read_token()
    prefix = (args.prefix or os.environ.get("VAULT_PREFIX", "").strip() or DEFAULT_PREFIX)
    prefix = prefix.strip("/")
    path = (args.path or os.environ.get("VAULT_PATH", "").strip()).strip("/")
    if not path:
        fail(
            "No VAULT_PATH. Set it to this product's own name (the path its scoped\n"
            "policy covers), or pass --path."
        )

    client = Client(addr, token, os.environ.get("VAULT_NAMESPACE", "").strip())
    ensure_kv2(client, prefix, path)

    existing, _ = read_target(client, prefix, path)
    merged = {**existing, **payload}
    changed = {k: v for k, v in payload.items() if existing.get(k) != v}
    if not changed:
        print(f"--- {prefix}/{path} already in sync ({len(existing)} key(s)) — nothing written ---")
        return 0

    print(
        f"--- writing {len(changed)} key(s) to {prefix}/{path} "
        f"({len(existing)} existing preserved) ---"
    )
    status, written = client.api("POST", f"{prefix}/data/{path}", {"data": merged})
    if status not in (200, 204):
        fail(f"Writing {prefix}/data/{path} failed: HTTP {status} — {written.get('errors')}")

    # Read it back: a write that did not land is worse than one that errored.
    after, _ = read_target(client, prefix, path)
    missing = [k for k in merged if after.get(k) != merged[k]]
    if missing:
        fail(f"These keys did not read back identically: {', '.join(sorted(missing))}")

    print(f"--- {prefix}/{path} now holds {len(after)} key(s) ---")
    print()
    print("Set the migrated values in .env as references:")
    for key in sorted(changed):
        print(f"    {key}=vault://{prefix}/{path}#{key}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
