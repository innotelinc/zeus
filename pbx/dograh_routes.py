#!/usr/bin/env python3
"""pbx/dograh_routes.py — does every DID the platform sells reach a Dograh workflow?

The DID -> agent decision lives in FreePBX's own `incoming` table now: each DID
is one row whose destination is `dograh-inbound,<workflow>,1`. There is no router
context any more, so the failure mode is a DID whose destination points somewhere
else — or nowhere — while the portal still believes the number is answered. A
route that points elsewhere still answers calls, just as the wrong thing, which
is why this has to be a judgement about destinations and not about uptime.

One destination that points elsewhere is *correct*: a line the portal marks
`fax_enabled` may answer as the fax service rather than as an agent, and without
that, the fax DID is a drift line on every run — a permanent false positive is
how an operator learns to ignore the report.

The flag is honoured narrowly, because it does not mean "this is not a voice
line": measured on this estate, the Denovo interview line is fax-enabled *and*
reaches `dograh-inbound,8005,1`. So it never skips a line and never excuses a
missing row — a fax number answered by the catch-all is as wrong as an agent
answered by fax. It excuses one shape, `FAX_DEST_RE` below, and the line it
excuses is printed rather than dropped: an unreported "left alone" and a clean
route look identical.

**This tool is read-only, on purpose.** Which agent a DID should reach is a
portal decision (`voice_bindings`) and writing the row belongs to FreePBX's own
API; neither is this file's to guess. What nothing else did after
`pbx/ava_routes.py` was retired with the AVA engine — it both judged *and* wrote —
is *notice* the disagreement, and noticing is what this closes. The gap it
reports is a named one a human fills in two clicks, never a silent one.

    # the live PBX, read-only. Exit 0 in sync, 1 drift, 2 cannot tell.
    python3 pbx/dograh_routes.py --db /var/lib/docker/volumes/zeus-portal-data/_data/pbx.db --check

    # the off-host rehearsal input: the route table pbx/p0-snapshot.sh dumps,
    # judged with no PBX reachable.
    python3 pbx/dograh_routes.py --db <portal.pbx.db> --incoming-tsv <dump.tsv>

Exit codes are deliberately the same shape the retired tool used, so a caller's
habits stay valid: 1 means "an apply could converge this", 2 means "no evidence",
and neither is a pass.
"""
from __future__ import annotations

import argparse
import os
import re
import sqlite3
import sys
from typing import Collection

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pbx_db  # noqa: E402

# Every Dograh workflow entry point is spelled `<context>,<workflow>,1`.
CONTEXT = "dograh-inbound"
DEST_RE = re.compile(rf"^{re.escape(CONTEXT)},(\d+),\d+$")

# What the fax service looks like as a destination, measured on this estate: the
# fax DID answers as a ring group (`ext-group,329,1`), not as an extension. This
# is deliberately the *only* shape a `fax_enabled` line is excused for — a
# fax-marked line pointed at `from-did-direct,<ext>` is exactly the silent
# "the customer's own phone rang instead" failure this tool exists to name, and
# the flag is set on lines that carry voice too. An estate whose fax service has
# another shape gets one more alternative here rather than a switch.
FAX_DEST_RE = re.compile(r"^ext-group,\d+,\d+$")

# The rows that are somebody else's phone service and that a DID-shaped report
# must not claim. Kept as a name rather than a bare literal so the wording below
# and the parser cannot drift apart.
INCOMING_QUERY = "SELECT extension, destination FROM incoming"


def normalise_did(value: str) -> str:
    """A DID as the trunk delivers it: ten digits.

    The portal stores some numbers with a country code (`13025551002`) and
    FreePBX stores the ones it accepted without (`3025551002`). Both name the
    same line, and comparing them raw reports a healthy route as missing.
    """
    digits = re.sub(r"\D", "", value or "")
    return digits[1:] if len(digits) == 11 and digits.startswith("1") else digits


def parse_incoming(text: str) -> dict[str, str]:
    """`incoming` as {normalised DID: destination}.

    A blank extension is FreePBX's own catch-all and is returned under `""`, so a
    caller can say "unrouted DIDs land here" without confusing it for a DID.
    """
    routes: dict[str, str] = {}
    for line in text.splitlines():
        if not line.strip():
            continue
        parts = line.rstrip("\n").split("\t")
        if len(parts) < 2:
            continue
        ext, destination = parts[0].strip(), parts[1].strip()
        routes[normalise_did(ext) if ext else ""] = destination
    return routes


def workflow_of(destination: str) -> str:
    """The Dograh workflow a destination names, or "" when it names something else."""
    match = DEST_RE.match(destination or "")
    return match.group(1) if match else ""


def read_live_incoming(container: str) -> str:
    return pbx_db.mysql_exec(container, INCOMING_QUERY)


def platform_dids(db_path: str) -> dict[str, bool]:
    """Every DID the platform sells, mapped to whether the portal marks it a fax
    line — from the portal's own record.

    Read-only, and a missing table raises rather than returning an empty plan: an
    empty plan would report a clean ingress for an estate that has not been read
    at all, which is the one answer worse than "cannot tell".

    Two portal rows that name the same line (`13025551002` and `3025551002`) are
    one DID here, and fax wins: the flag is a property of the number, and a "no"
    from one spelling must not erase a "yes" from the other.
    """
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        rows = con.execute(
            "SELECT did, fax_enabled FROM phone_numbers WHERE status = 'active'"
        )
        plan: dict[str, bool] = {}
        for did, fax_enabled in rows:
            if not did:
                continue
            normalised = normalise_did(did)
            plan[normalised] = plan.get(normalised, False) or bool(fax_enabled)
        return plan
    finally:
        con.close()


def judge(dids: list[str], routes: dict[str, str],
          fax: Collection[str] = ()) -> tuple[list[str], list[str], list[str]]:
    """(off_workflow, no_row, fax_line). Pure, so the contract is testable
    without a PBX.

    A DID that falls through to the catch-all is NOT in sync — the catch-all
    answers as whatever workflow it happens to name, which is the silent-wrong-
    agent failure this exists to surface. That holds for a fax line too: a fax
    number with no row of its own is answered by whatever the catch-all reaches,
    and a fax that lands on an agent is as wrong as an agent that lands on fax.

    `fax` decides one thing only: whether a line the portal marks `fax_enabled`
    is excused a destination that is the fax service (`FAX_DEST_RE`). The
    excused ones are returned rather than dropped, so the report can say why a
    line it did not judge was not judged.
    """
    off, missing, faxed = [], [], []
    for did in dids:
        destination = routes.get(did)
        if destination is None:
            missing.append(did)
        elif workflow_of(destination):
            continue
        elif did in fax and FAX_DEST_RE.match(destination):
            faxed.append(f"{did} -> {destination}")
        else:
            off.append(f"{did} -> {destination}")
    return off, missing, faxed


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--db", help="the portal's SQLite database (pbx.db)")
    ap.add_argument("--incoming-tsv", help="a route table dumped by pbx/p0-snapshot.sh")
    ap.add_argument("--container", default=os.environ.get("PBX_CONTAINER", ""),
                    help="the FreePBX container to read (default: autodetect)")
    ap.add_argument("--check", action="store_true",
                    help="judge and exit 0/1/2 (this tool never writes)")
    args = ap.parse_args(argv)

    if not args.db:
        print("dograh-routes: no --db given — there is no plan to judge against", file=sys.stderr)
        return 2
    if not os.path.exists(args.db):
        print(f"dograh-routes: {args.db} does not exist — cannot tell", file=sys.stderr)
        return 2
    try:
        plan = platform_dids(args.db)
    except sqlite3.Error as exc:
        print(f"dograh-routes: cannot read the plan from {args.db}: {exc}", file=sys.stderr)
        return 2
    if not plan:
        print(f"dograh-routes: {args.db} names no active DID — cannot judge", file=sys.stderr)
        return 2
    dids = sorted(plan)

    if args.incoming_tsv:
        try:
            with open(args.incoming_tsv, encoding="utf-8") as handle:
                routes = parse_incoming(handle.read())
        except OSError as exc:
            print(f"dograh-routes: cannot read {args.incoming_tsv}: {exc}", file=sys.stderr)
            return 2
        source = args.incoming_tsv
    else:
        container = pbx_db.resolve_container(args.container)
        if not container:
            print("dograh-routes: no FreePBX container found — cannot tell", file=sys.stderr)
            return 2
        try:
            routes = parse_incoming(read_live_incoming(container))
        except pbx_db.RouteError as exc:
            print(f"dograh-routes: {exc} — cannot tell", file=sys.stderr)
            return 2
        source = container

    off, missing, faxed = judge(dids, routes, {did for did, is_fax in plan.items() if is_fax})
    print(f"dograh-routes: judged {len(dids)} platform DID(s) against {source}")
    for line in off:
        print(f"  off the workflow: {line}", file=sys.stderr)
    for did in missing:
        print(f"  no inbound route: {did}", file=sys.stderr)
    for line in faxed:
        print(f"  fax line, left alone: {line}", file=sys.stderr)
    if off or missing:
        print(
            f"dograh-routes: {len(off)} route(s) off {CONTEXT} and {len(missing)} "
            f"unrouted — a person decides which workflow each DID should reach, then "
            f"adds or repoints the row in FreePBX",
            file=sys.stderr,
        )
        return 1
    print(
        f"dograh-routes: every platform DID reaches a {CONTEXT} workflow"
        + (f" ({len(faxed)} fax line(s) left alone)" if faxed else "")
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
