#!/usr/bin/env python3
"""pbx/extension_mirror.py — is every extension on the PBX one the portal knows?

The portal's `freepbx_extensions` is a **mirror** of FreePBX's own `users` table:
the row is how the portal knows a phone exists at all — its softphone settings,
its voicemail, and the account whose screens manage it. FreePBX, though, will
make a user for anyone with the GUI or database access, and nothing in this repo
notices when one appears: the phone rings, its number answers, and the portal can
say nothing about it because it has never heard of it. No screen is wrong, which
is why nothing reported it.

Measured on this estate, exactly that happened. `4132912045` ("Wendel") is a real
FreePBX user and device, and the only one of the box's eight extensions without a
mirror row — a line created by going around the portal, invisible to the product
that owns the account. The mirror is written by the portal's own create path
(`src/app/api/phone/extensions/route.ts`) and by `scripts/legacy_portal_merge.py`,
which writes one row per extension that predates the portal; so "every FreePBX
user is a portal extension" is the estate's own convention, not an assumption
bolted on here.

**One direction only, and that is the point.** A portal row with no FreePBX user
is *not* drift: the mirror also carries things the PBX does not own as users — the
AvantFax service lines (`3291`–`3294`), a demo softphone (`1001`) — and reporting
those would be a permanent false positive, which is how an operator learns to
ignore a report. The judgement is about a phone the portal cannot manage, never
about a row the PBX does not have.

**Read-only.** Adding the mirror row belongs to the portal (its create path writes
both sides), and removing the PBX user is FreePBX's `delUser`/`delDevice`. This
tool names which extension needs one of those and never which: a row invented here
would be a guess at an account id, and a mirror row pointing at somebody else's
account is worse than a named gap.

    # the live PBX, read-only. Exit 0 in sync, 1 drift, 2 cannot tell.
    python3 pbx/extension_mirror.py --db /var/lib/docker/volumes/zeus-portal-data/_data/pbx.db --check

    # off-host: judge a user table dumped from the PBX
    python3 pbx/extension_mirror.py --db <portal.pbx.db> --users-tsv users.tsv

Exit codes are deliberately the shape `pbx/dograh_routes.py` uses, so a caller's
habits stay valid: 1 means "a person converges this", 2 means "no evidence", and
neither is a pass.
"""
from __future__ import annotations

import argparse
import os
import sqlite3
import sys
from typing import Collection, Mapping

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pbx_db  # noqa: E402

# FreePBX's own extension list, and the portal's mirror of it. Kept as names
# rather than inline literals so the wording below and the parsers cannot drift.
USERS_QUERY = "SELECT extension, name FROM users"
MIRROR_QUERY = "SELECT extension_id FROM freepbx_extensions"


def parse_users(text: str) -> dict[str, str]:
    """`SELECT extension, name FROM users` (mysql -N -B) as {extension: name}.

    An extension with no name is kept with `""` rather than dropped: it is still
    an extension, and a check that skipped it would report an estate as mirrored
    because the lines it could not name were the ones missing.
    """
    users: dict[str, str] = {}
    for line in text.splitlines():
        if not line.strip():
            continue
        parts = line.rstrip("\n").split("\t")
        extension = parts[0].strip()
        if not extension:
            continue
        users[extension] = parts[1].strip() if len(parts) > 1 else ""
    return users


def _ext_key(extension: str) -> tuple[int, int, str]:
    """Digits sort numerically — `1001` before `12000`, not after — and anything
    else sorts after them, by name."""
    return (0, int(extension), "") if extension.isdigit() else (1, 0, extension)


def judge(users: Mapping[str, str], mirror: Collection[str]) -> list[str]:
    """The extensions the PBX has that the mirror does not name, as
    `"<ext> (<name>)"` — pure, so the contract is testable without a PBX."""
    return [f"{ext} ({users[ext]})" if users[ext] else ext
            for ext in sorted(users, key=_ext_key) if ext not in mirror]


def read_live_users(container: str) -> str:
    return pbx_db.mysql_exec(container, USERS_QUERY)


def mirror_extensions(db_path: str) -> set[str]:
    """The extension ids the portal's mirror names, from the portal's own record.

    Read-only, and a missing table raises rather than returning an empty set: an
    unread mirror reads as an estate where every line is unmanaged, and the one
    answer worse than "cannot tell" is a report that name every extension on a
    box as drift because the mirror was never read.
    """
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        return {row[0].strip() for row in con.execute(MIRROR_QUERY)
                if row[0] and row[0].strip()}
    finally:
        con.close()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--db", help="the portal's SQLite database (pbx.db)")
    ap.add_argument("--users-tsv", help="a `SELECT extension, name FROM users` dump")
    ap.add_argument("--container", default=os.environ.get("PBX_CONTAINER", ""),
                    help="the FreePBX container to read (default: autodetect)")
    ap.add_argument("--check", action="store_true",
                    help="judge and exit 0/1/2 (this tool never writes)")
    args = ap.parse_args(argv)

    if not args.db:
        print("extension-mirror: no --db given — there is no mirror to judge against",
              file=sys.stderr)
        return 2
    if not os.path.exists(args.db):
        print(f"extension-mirror: {args.db} does not exist — cannot tell", file=sys.stderr)
        return 2
    try:
        mirror = mirror_extensions(args.db)
    except sqlite3.Error as exc:
        print(f"extension-mirror: cannot read the mirror from {args.db}: {exc}",
              file=sys.stderr)
        return 2
    if not mirror:
        print(f"extension-mirror: {args.db} names no extension in the mirror — cannot judge",
              file=sys.stderr)
        return 2

    if args.users_tsv:
        try:
            with open(args.users_tsv, encoding="utf-8") as handle:
                users = parse_users(handle.read())
        except OSError as exc:
            print(f"extension-mirror: cannot read {args.users_tsv}: {exc}", file=sys.stderr)
            return 2
        source = args.users_tsv
    else:
        container = pbx_db.resolve_container(args.container)
        if not container:
            print("extension-mirror: no FreePBX container found — cannot tell", file=sys.stderr)
            return 2
        try:
            users = parse_users(read_live_users(container))
        except pbx_db.RouteError as exc:
            print(f"extension-mirror: {exc} — cannot tell", file=sys.stderr)
            return 2
        source = container

    if not users:
        print(f"extension-mirror: {source} names no extension — cannot judge", file=sys.stderr)
        return 2

    unmirrored = judge(users, mirror)
    print(f"extension-mirror: judged {len(users)} FreePBX extension(s) against "
          f"{source} and {len(mirror)} mirror row(s)")
    for line in unmirrored:
        print(f"  not in the portal's mirror: {line}", file=sys.stderr)
    if unmirrored:
        print(
            f"extension-mirror: {len(unmirrored)} extension(s) the portal does not know "
            f"about — a phone nothing in the portal can manage; add it in the portal, or "
            f"remove it from the PBX with delUser/delDevice",
            file=sys.stderr,
        )
        return 1
    print("extension-mirror: every FreePBX extension is in the portal's mirror")
    return 0


if __name__ == "__main__":
    sys.exit(main())
