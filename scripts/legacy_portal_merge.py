#!/usr/bin/env python3
"""Merge the legacy `voice` PBX accounts into the Zeus portal database.

Source: a snapshot of the legacy PBX's extension accounts (extension, name,
device secret, voicemail) captured from the box itself.

Target: zeus-portal's SQLite. Rows are written the way the portal's own routes
write them (`src/app/api/phone/*/route.ts`, `src/app/api/admin/users/route.ts`,
`src/lib/oidc.ts`), so the app reads them without special-casing:

  * users      — accounts that will authenticate through Authentik carry
                 password_hash = '!oidc' (the portal's own marker for "managed
                 by Authentik"), with auth_subject left empty so the first SSO
                 login binds to the account by email. This is the same shape
                 upsertOidcUser() creates.
  * numbers    — one phone_numbers row per DID, owned by the account.
  * extensions — one freepbx_extensions row per extension, carrying the legacy
                 device secret and voicemail PIN so the portal and the PBX agree.

Accounts are matched by name before being created, so an account that already
exists keeps the numbers and extensions it already had rather than being
duplicated. A number that exists on the wrong account is reassigned to its
legacy owner, and said out loud.

    legacy_portal_merge.py plan     # say what would change; no writes
    legacy_portal_merge.py apply    # do it

An extension that was created on the PBX *after* the snapshot was taken has no
row here to merge, and the portal's own create path refuses it (`409
extension_exists`) because FreePBX already owns the user and device. `adopt` is
that missing half: it reads the extension off the PBX and writes the one mirror
row the portal needs, in the same shape this file writes for the snapshot, so
the portal can manage a line it did not create.

    legacy_portal_merge.py adopt --extension 4132912045          # say what would change
    legacy_portal_merge.py adopt --extension 4132912045 --apply  # do it
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import uuid

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "pbx"))
import pbx_db  # noqa: E402

DB = os.environ.get("ZEUS_PORTAL_DB", "/app/data/pbx.db")
CONTAINER = os.environ.get("ZEUS_PORTAL_CONTAINER", "zeus-portal")
SNAP = os.environ.get("ZEUS_LEGACY_ACCOUNTS", "/root/pbx-merge/accounts.json")

# The account the device-only extensions belong to: their caller IDs all point
# at it, and the fax DID is theirs too.
CORPORATE = "Denovo Credit Corporation"

# Which named account holds which DID. The device extensions (cordless phone,
# fax machine, fax 1-4) hang off the corporate account.
ACCOUNT_DIDS = {
    "4132643964": "Darnel Hunter",
    "4132951200": "Grandmas Place Inc",
    "4135612020": "HD Logistics Inc",
    "7745057135": "Denovo Credit Corporation",
    "8579901777": "US Agents Inc",
}

# DIDs the source PBX routed that are not themselves extensions: owner, sms,
# fax. 7745057136 is the fax line — the ring group destination and the fax
# caller ID.
EXTRA_DIDS = {"7745057136": ("Denovo Credit Corporation", 0, 1)}

AREA_LOCATION = {"413": "Massachusetts", "774": "Massachusetts",
                 "857": "Massachusetts", "302": "Wilmington, DE"}


# ── pure planning ────────────────────────────────────────────────────────────

def quote(value) -> str:
    if value is None:
        return "NULL"
    return "'" + str(value).replace("'", "''") + "'"


def slug_email(name: str) -> str:
    """A deterministic, unique address for an account that had none.

    The portal binds an Authentik identity to an account by email, so this has
    to be stable — and it is editable in the portal once the real address is
    known.
    """
    slug = "".join(ch.lower() if ch.isalnum() else "-" for ch in name)
    return "-".join(part for part in slug.split("-") if part) + "@innotel.us"


def owner_of(extension: str) -> str:
    return ACCOUNT_DIDS.get(extension, CORPORATE)


def did_owners() -> dict[str, str]:
    owners = dict(ACCOUNT_DIDS)
    owners.update({did: who for did, (who, _, _) in EXTRA_DIDS.items()})
    return owners


def plan_users(names, existing_users):
    """Create the accounts that are missing; match the ones that exist."""
    lines, statements = [], []
    by_name = {row["name"].strip().lower(): row for row in existing_users}
    owners = {}
    for name in sorted(names):
        found = by_name.get(name.strip().lower())
        if found:
            owners[name] = found["id"]
            lines.append(f"MATCH  {name:28} -> {found['email']}  (existing, left alone)")
            continue
        user_id = str(uuid.uuid4())
        owners[name] = user_id
        email = slug_email(name)
        lines.append(f"ADD    {name:28} {email}  password_hash='!oidc' (Authentik binds on first login)")
        statements.append(
            "INSERT INTO users (id, email, name, password_hash, plan, plan_status, "
            "role, country, created_at, updated_at)\n"
            f"  VALUES ({quote(user_id)}, {quote(email)}, {quote(name)}, '!oidc', "
            "'business', 'active', NULL, 'US', datetime('now'), datetime('now'));")
    return owners, lines, statements


def plan_numbers(existing_numbers, owners, users):
    lines, statements = [], []
    for did in sorted(did_owners()):
        who = did_owners()[did]
        owner_id = owners[who]
        sms, fax = (0, 1) if did in EXTRA_DIDS else (1, 0)
        area = did[:3]
        current = existing_numbers.get(did)
        if current:
            if current["user_id"] == owner_id:
                lines.append(f"OK     {did:12} -> {who}  (already correct)")
            else:
                was = next((u["email"] for u in users if u["id"] == current["user_id"]),
                           current["user_id"])
                lines.append(f"MOVE   {did:12} -> {who}  (was on {was})")
                statements.append(f"UPDATE phone_numbers SET user_id={quote(owner_id)} "
                                  f"WHERE did={quote(did)};")
            continue
        lines.append(f"ADD    {did:12} -> {who}  area={area} sms={sms} fax={fax}")
        statements.append(
            "INSERT INTO phone_numbers (id, user_id, did, area_code, location, server, "
            "sms_enabled, fax_enabled, status, created_at)\n"
            f"  VALUES ({quote(str(uuid.uuid4()))}, {quote(owner_id)}, {quote(did)}, "
            f"{quote(area)}, {quote(AREA_LOCATION.get(area))}, NULL, {sms}, {fax}, "
            "'active', datetime('now'));")
    return lines, statements


def plan_extensions(accounts, existing_extensions, owners, owner_for=None):
    owner_for = owner_for or owner_of
    lines, statements = [], []
    for extension in sorted(accounts, key=lambda e: (len(e), e)):
        account = accounts[extension]
        who = owner_for(extension)
        if extension in existing_extensions:
            lines.append(f"OK     {extension:11} {account['name'][:24]:24} (already on the portal)")
            continue
        vm_yes = str(account.get("voicemail", "")).lower() not in ("novm", "", "none")
        pin = (account.get("vm") or {}).get("pin") if vm_yes else None
        lines.append(f"ADD    {extension:11} {account['name'][:24]:24} -> {who:26} "
                     f"vm={'yes' if vm_yes else 'no'} secret=legacy")
        statements.append(
            "INSERT INTO freepbx_extensions (id, user_id, extension_id, extension_name, "
            "extension_secret, voicemail_enabled, voicemail_pin, status, created_at, "
            "updated_at, device_state)\n"
            f"  VALUES ({quote(str(uuid.uuid4()))}, {quote(owners[who])}, {quote(extension)}, "
            f"{quote(account['name'])}, {quote(account.get('secret'))}, "
            f"{1 if vm_yes else 0}, {quote(pin)}, 'active', datetime('now'), "
            "datetime('now'), 'unknown');")
    return lines, statements


# ── adopting an extension the snapshot does not carry ──────────────────────

def read_pbx_account(extension: str, container: str) -> dict | None:
    """The extension's own row from FreePBX's `users`, shaped like a snapshot
    account, or None when the PBX does not have that extension.

    The device secret is deliberately NOT invented. FreePBX generates it and the
    portal's Repair adopts the rendered one; a secret made up here would be a
    credential that authenticates nothing, which is worse than a NULL the
    readiness row can report.
    """
    text = pbx_db.mysql_exec(
        container,
        "SELECT name, voicemail FROM users WHERE extension = " + quote(extension),
    )
    for line in text.splitlines():
        if not line.strip():
            continue
        parts = line.rstrip("\n").split("\t")
        name = parts[0].strip() or extension
        voicemail = parts[1].strip() if len(parts) > 1 else ""
        return {"extension": extension, "name": name, "voicemail": voicemail,
                "secret": None, "vm": None}
    return None


def account_from_snapshot(path: str, extension: str) -> dict | None:
    """The extension's account out of the legacy snapshot, when it is there.

    A snapshot entry is preferred to the live PBX: it carries the legacy device
    secret and voicemail PIN, so an extension the migration *did* know about is
    adopted with the credentials the PBX and the portal already agree on.
    """
    try:
        with open(path, encoding="utf-8") as handle:
            snapshot = json.load(handle)
    except (OSError, ValueError):
        return None
    for account in snapshot.get("accounts", []):
        if str(account.get("extension")) == extension:
            return account
    return None


# ── I/O ──────────────────────────────────────────────────────────────────────

def sqlite(sql: str, json_out: bool = False) -> subprocess.CompletedProcess:
    args = ["docker", "exec", "-i", CONTAINER, "sqlite3"]
    if json_out:
        args.append("-json")
    args.append(DB)
    return subprocess.run(args, input=sql, capture_output=True, text=True)


def rows(query: str) -> list[dict]:
    text = sqlite(query, json_out=True).stdout.strip()
    return json.loads(text) if text else []


def _adopt(args) -> int:
    """The writing half of `adopt`: one mirror row for a PBX extension the
    portal does not know, owned by the account the merge rule (or `--account`)
    names."""
    if not args.extension:
        print("adopt: --extension is required (the FreePBX extension to add to "
              "the portal's mirror)", file=sys.stderr)
        return 2
    extension = args.extension.strip()

    account = account_from_snapshot(args.accounts, extension)
    if account is not None:
        source = args.accounts
    else:
        container = pbx_db.resolve_container(args.pbx_container)
        if not container:
            print("adopt: no FreePBX container found — cannot read the extension",
                  file=sys.stderr)
            return 2
        try:
            account = read_pbx_account(extension, container)
        except pbx_db.RouteError as exc:
            print(f"adopt: {exc} — cannot tell", file=sys.stderr)
            return 2
        source = container
    if account is None:
        print(f"adopt: {extension} is not a FreePBX extension — nothing to adopt",
              file=sys.stderr)
        return 1

    owner = (args.account or owner_of(extension)).strip()
    users = rows("select id, email, name from users;")
    existing_extensions = {row["extension_id"] for row in
                           rows("select extension_id from freepbx_extensions;")}

    owners, user_lines, user_statements = plan_users({owner}, users)
    ext_lines, ext_statements = plan_extensions(
        {extension: account}, existing_extensions, owners,
        owner_for=lambda _extension: owner)

    print(f"adopt   FreePBX extension {extension} ({account['name']}) from {source}")
    print(f"target  Zeus portal ({CONTAINER}:{DB})   owner {owner}\n")
    print("accounts")
    for line in user_lines:
        print("  " + line)
    print("\nextensions")
    for line in ext_lines:
        print("  " + line)

    statements = user_statements + ext_statements
    if not statements:
        print("\nnothing to do — the mirror already names this extension")
        return 0
    if not args.apply:
        print(f"\nplan only — {len(statements)} statement(s) would run; "
              "re-run with --apply")
        return 0
    sqlite("BEGIN IMMEDIATE;\n" + "\n".join(statements) + "\nCOMMIT;")
    print(f"\napplied {len(statements)} statement(s)")
    return 0


def _merge(args) -> int:
    apply = args.mode == "apply"
    snapshot = json.load(open(args.accounts))
    accounts = {a["extension"]: a for a in snapshot["accounts"]}
    print(f"source  legacy PBX ({snapshot['source_host']})  {len(accounts)} extension accounts")
    print(f"target  Zeus portal ({CONTAINER}:{DB})   mode={args.mode.upper()}\n")

    users = rows("select id, email, name from users;")
    existing_numbers = {row["did"]: row for row in
                        rows("select id, user_id, did from phone_numbers;")}
    existing_extensions = {row["extension_id"] for row in
                           rows("select extension_id from freepbx_extensions;")}

    names = set(list(ACCOUNT_DIDS.values()) + [CORPORATE])
    owners, user_lines, user_statements = plan_users(names, users)
    number_lines, number_statements = plan_numbers(existing_numbers, owners, users)
    extension_lines, extension_statements = plan_extensions(accounts, existing_extensions, owners)

    print("accounts")
    for line in user_lines:
        print("  " + line)
    print("\nphone numbers")
    for line in number_lines:
        print("  " + line)
    print("\nextensions")
    for line in extension_lines:
        print("  " + line)

    statements = user_statements + number_statements + extension_statements
    if not statements:
        print("\nnothing to do")
        return 0
    if not apply:
        print(f"\nplan only — {len(statements)} statement(s) would run")
        return 0

    sqlite("BEGIN IMMEDIATE;\n" + "\n".join(statements) + "\nCOMMIT;")
    print(f"\napplied {len(statements)} statement(s)")
    print("\nresult in the portal")
    for label, query in (("users", "select count(*) as n from users;"),
                         ("numbers", "select count(*) as n from phone_numbers;"),
                         ("extensions", "select count(*) as n from freepbx_extensions;")):
        print(f"  {label:11} {rows(query)[0]['n']}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("mode", choices=("plan", "apply", "adopt"))
    parser.add_argument("--accounts", default=SNAP)
    parser.add_argument("--extension",
                        help="the FreePBX extension to adopt (adopt mode)")
    parser.add_argument("--account",
                        help="the portal account that owns it (adopt mode; default: "
                             "the same rule the merge uses for an extension with "
                             "no account of its own)")
    parser.add_argument("--pbx-container", default=os.environ.get("PBX_CONTAINER", ""),
                        help="the FreePBX container to read (adopt mode; default: autodetect)")
    parser.add_argument("--apply", action="store_true",
                        help="write the mirror row (adopt mode)")
    args = parser.parse_args(argv)
    if args.mode == "adopt":
        return _adopt(args)
    return _merge(args)


if __name__ == "__main__":
    sys.exit(main())
