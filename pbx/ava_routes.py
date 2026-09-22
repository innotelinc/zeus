#!/usr/bin/env python3
"""pbx/ava_routes.py — converge the DIDs' inbound routes onto the AVA router.

P1 of docs/ava-capstone-convergence.md is *one ingress*: every DID the platform
sells is answered by AVA, which means every one of their FreePBX inbound routes
must point at the Custom Destination

    zeus-ai-router,s,1

That was a GUI step ("Connectivity → Inbound Routes → DID → Custom
Destination"), and a GUI step is a setting with no owner: the estate had every
DID unwired while both products believed the numbers were routed, and nothing
noticed, because a route that points somewhere else still answers calls —
just as the wrong thing.

This tool is that owner. It reads the platform's accounts (the same plan
``pbx/ava_routing.py`` renders the dialplan from, so the route and the account
block can never disagree), compares each account's inbound route against the
router destination, and reports or applies the difference.

**By default it converges rows that exist; it never invents them.** A DID with
no inbound route at all is reported and refused — a hand-written ``incoming``
row means guessing its other fifteen columns, and that guess on a live phone
system is worse than a named gap a human fills in two clicks. The same refusal
covers a DID with two rows: which one wins would be row order, not intent.

A default apply — and therefore the timer — never creates a row. There is one
explicit exception, because the same GUI step is what leaves a *new* DID
unrouted in the first place:

    # create the plan's DIDs that have no route at all, through FreePBX's own
    # API rather than an INSERT of ours. This is the GUI's own create path
    # (`FreePBX::Core()->addDID`), so the columns are the framework's to fill.
    python3 pbx/ava_routes.py --accounts-json /tmp/plan.json \
        --apply --create-missing --revert-out /root/zeus-route-revert.sql

The opt-in matters: `--create-missing` writes a row this tool had no evidence
for, so it belongs in a deliberate one-off run, never in a periodic one.

**It only ever touches DIDs the plan names.** Everything else in the table —
the operator's ring group number, a partner's, a pattern route like ``_2XX`` —
is reported as *left alone*. That is a rule, not a courtesy: this file's whole
difficulty is that the wrong rows on it are someone else's phone service.

Reading and writing:

    # the live PBX, read-only. Exit 0 in sync, 1 drift, 2 cannot tell.
    python3 pbx/ava_routes.py --accounts-json /tmp/plan.json --check

    # Exit codes, and why 1 and 3 are different: 1 means an apply converges it,
    # 3 means only a person can (a DID with no inbound route at all, or two).
    # A caller that treats them alike — "not 0, so apply" — reloads a live PBX
    # on every timer tick to change nothing, because a 3 never clears by itself.

    # apply, after taking the phase's pre-state (pbx/p0-snapshot.sh)
    python3 pbx/ava_routes.py --accounts-json /tmp/plan.json --apply \
        --revert-out /root/zeus-route-revert.sql
    docker exec -i zeus-freepbx mysql -u root asterisk \
        < /root/zeus-route-revert.sql        # the way back, written first

A created row's way back is a DELETE, written by `--create-missing` into the
same script, so one file undoes both halves of a mixed run.

    # off-host: a route table dumped by p0-snapshot (routes/incoming.tsv is
    # `SELECT *`; re-dump with the query below for this tool)
    docker exec zeus-freepbx mysql -N -B -u root asterisk \
        -e 'SELECT extension, destination, description FROM incoming;' > routes.tsv
    python3 pbx/ava_routes.py --db <portal.db> --routes-tsv routes.tsv --check

The table's ``extension`` is the DID FreePBX matches against ``${FROM_DID}``,
and it matches the *dialed* form, so a row stored as ``17745057135`` never
matches a call to ``7745057135``. A row that is only mis-prefixed is therefore
drift like any other, and applying rewrites the extension to the canonical
national form at the same time as the destination — the same normalization the
accounts context uses, so the route and its ``[zeus-ai-accounts]`` entry agree.

Reloading: FreePBX builds its dialplan from these rows, so a change is live only
after ``fwconsole reload`` (the bootstrap's apply path runs it). This tool does
not reload — it changes the database and says so, keeping the reload where the
rest of the convergence already does it.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ava_routing as routing  # noqa: E402

# The Custom Destination every platform DID must carry. FreePBX stores a
# custom dialplan target in `incoming.destination` in this form (context,exten,
# priority) — the same string the GUI's Custom Destination page shows, and the
# same shape capstone's pbx/bootstrap_dograh_route.py writes for [dograh-inbound].
ROUTER = "zeus-ai-router,s,1"

# FreePBX keeps inbound routes for every product and every trunk on one table.
# `incoming` is the table; these are the columns this tool needs. A row is
# keyed by `extension` (the DID as dialed).
ROUTES_QUERY = "SELECT extension, destination, description FROM incoming;"

# A row whose extension is a dial pattern (`_2XX`, `_1774505XXXX`) rather than a
# number. Never rewritten: a pattern is a deliberate range, and turning it into
# one literal DID would silently stop matching the rest.
PATTERN_RE = re.compile(r"[^0-9 +().\-]")


class RouteError(RuntimeError):
    """A route table that cannot be judged."""


@dataclass(frozen=True)
class RouteRow:
    extension: str
    destination: str
    description: str
    line: int


@dataclass(frozen=True)
class Change:
    """One row that must change, and what it looked like first."""

    did: str
    before_extension: str
    before_destination: str
    after_extension: str
    after_destination: str

    @property
    def destination_moved(self) -> bool:
        return self.before_destination != self.after_destination

    @property
    def extension_recased(self) -> bool:
        return self.before_extension != self.after_extension

    def sql(self) -> str:
        """The UPDATE, keyed on the *current* extension so it can run as-is."""
        sets = []
        if self.extension_recased:
            sets.append(f"`extension`='{_sql(self.after_extension)}'")
        sets.append(f"`destination`='{_sql(self.after_destination)}'")
        return (
            f"UPDATE `incoming` SET {', '.join(sets)} "
            f"WHERE `extension`='{_sql(self.before_extension)}';"
        )

    def revert_sql(self) -> str:
        """The inverse UPDATE, keyed on the extension the apply leaves behind."""
        return (
            f"UPDATE `incoming` SET `extension`='{_sql(self.before_extension)}',"
            f"`destination`='{_sql(self.before_destination)}' "
            f"WHERE `extension`='{_sql(self.after_extension)}';"
        )


def _sql(value: str) -> str:
    """Escape a value for a single-quoted SQL literal."""
    return str(value).replace("\\", "\\\\").replace("'", "''")


@dataclass(frozen=True)
class Creation:
    """An inbound route this tool created, for a DID that had none at all.

    Only ``--create-missing`` produces one. Its way back is a delete rather than
    a restore: there was no row to restore.
    """

    did: str

    def revert_sql(self) -> str:
        # Keyed the way FreePBX's own create writes it (cidnum ''), so the undo
        # matches the row addDID inserted and nothing else.
        return (
            f"DELETE FROM `incoming` WHERE `extension`='{_sql(self.did)}' "
            "AND `cidnum`='';"
        )


# The create runs FreePBX's own create path inside the PBX container rather than
# an INSERT from here: `addDID` validates the pair, calls its own
# `addDIDDefaults`, and fires the module hooks the GUI would — the fifteen
# columns this tool does not model are the framework's to fill, and a guess at
# them is what the refusal exists to avoid. `__ROUTER__` is substituted from
# ROUTER below so the created destination and the converged one cannot drift.
CREATE_SCRIPT = """<?php
require '/etc/freepbx.conf';
$dids = json_decode(getenv('ZEUS_AVA_DIDS') ?: '[]', true);
$core = FreePBX::Core();
$out = array();
foreach ($dids as $did) {
    if (!empty($core->getDID($did, ''))) {
        $out[] = array('did' => $did, 'result' => 'exists');
        continue;
    }
    $ok = $core->addDID(array(
        'extension'   => $did,
        'cidnum'      => '',
        'destination' => '__ROUTER__',
        'description' => 'Zeus AI router (ava_routes)',
    ));
    $out[] = array('did' => $did, 'result' => $ok ? 'created' : 'failed');
}
echo json_encode($out), PHP_EOL;
"""


@dataclass
class Report:
    ok: list[str]
    changes: list[Change]
    missing: list[str]  # DID with no inbound route at all
    duplicates: list[str]  # DID with more than one inbound route
    left_alone: list[RouteRow]

    @property
    def refused(self) -> list[str]:
        return self.missing + self.duplicates


def parse_routes(text: str) -> list[RouteRow]:
    """Parse `ROUTES_QUERY`'s output: extension<TAB>destination[<TAB>description].

    A ``SELECT *`` dump is NOT accepted, and says so: the columns are positional
    here, so a dump from a different query would have its DID read out of
    whatever column came first. Refusing is the only safe reading of an
    ambiguous file — the re-dump is one line (this module's docstring).
    """
    rows: list[RouteRow] = []
    for line, raw in enumerate(text.splitlines(), 1):
        if not raw.strip():
            continue
        parts = raw.split("\t")
        if len(parts) > 3:
            raise RouteError(
                f"line {line}: {len(parts)} columns — this expects "
                "extension<TAB>destination[<TAB>description], i.e. the output "
                "of that SELECT (a `SELECT *` dump cannot be read positionally)"
            )
        rows.append(
            RouteRow(
                extension=parts[0].strip(),
                destination=(parts[1] if len(parts) > 1 else "").strip(),
                description=(parts[2] if len(parts) > 2 else "").strip(),
                line=line,
            )
        )
    return rows


def plan_dids(plan: dict) -> list[str]:
    """The DIDs the platform sells, canonicalized, in a stable order.

    Uses the renderer's own normalization on purpose: the inbound route must
    match the `[zeus-ai-accounts]` entry it dispatches to, and two tools with
    two ideas of "the same number" is the defect this whole phase is about.
    """
    accounts = routing.validate(plan)
    return [a["did"] for a in accounts]


def build_report(dids: list[str], rows: list[RouteRow]) -> Report:
    """Compare the plan's DIDs against the live route table."""
    # Index the numeric rows by their normalized DID. Patterns are excluded
    # before normalization, not after: `_2XX` reduces to "2" and would collide
    # with a real DID's route.
    by_did: dict[str, list[RouteRow]] = {}
    left_alone: list[RouteRow] = []
    judged: set[int] = set()
    normalized_of: dict[int, str] = {}
    for row in rows:
        if not row.extension or PATTERN_RE.search(row.extension):
            left_alone.append(row)
            continue
        try:
            normalized = routing.normalize_did(row.extension)
        except routing.PlanError:
            left_alone.append(row)
            continue
        normalized_of[row.line] = normalized
        judged.add(row.line)
        by_did.setdefault(normalized, []).append(row)

    ok: list[str] = []
    changes: list[Change] = []
    missing: list[str] = []
    duplicates: list[str] = []

    wanted = set(dids)
    for did in dids:
        found = by_did.get(did, [])
        if not found:
            missing.append(did)
            continue
        if len(found) > 1:
            duplicates.append(did)
            continue
        row = found[0]
        if row.destination == ROUTER and row.extension == did:
            ok.append(did)
            continue
        changes.append(
            Change(
                did=did,
                before_extension=row.extension,
                before_destination=row.destination,
                after_extension=did,
                after_destination=ROUTER,
            )
        )

    # Anything else in the table that is a number is still someone's phone
    # service. Report it by name so "left alone" is evidence, not an assumption.
    for row in rows:
        if row.line not in judged:
            continue
        if normalized_of[row.line] not in wanted:
            left_alone.append(row)

    return Report(
        ok=ok, changes=changes, missing=missing, duplicates=duplicates,
        left_alone=sorted(left_alone, key=lambda r: r.line),
    )


def render_revert(
    changes: list[Change], container: str, creations: tuple[Creation, ...] | list[Creation] = ()
) -> str:
    """The way back, written before anything changes.

    Covers both halves of a `--create-missing` run: the rows this tool rewrites
    are restored to what it found, and the rows it created are deleted.
    """
    import datetime

    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    what = f"{len(changes)} change(s)"
    if creations:
        what += f" and {len(creations)} creation(s)"
    lines = [
        f"-- zeus ava_routes revert — written {stamp}, before {what}.",
        "-- Restores the inbound routes exactly as ava_routes.py found them.",
        f"--   docker exec -i {container} mysql -u root asterisk < <this file>",
        "--   docker exec " + container + " fwconsole reload",
        "",
        "START TRANSACTION;",
    ]
    lines += [c.revert_sql() for c in changes]
    lines += [c.revert_sql() for c in creations]
    lines += ["COMMIT;", ""]
    return "\n".join(lines)


def render_sql(changes: list[Change]) -> str:
    """The apply, as one transaction."""
    lines = ["START TRANSACTION;"]
    lines += [c.sql() for c in changes]
    lines += ["COMMIT;", ""]
    return "\n".join(lines)


# ── the live PBX ─────────────────────────────────────────────────────────────


def _run(args: list[str], stdin: str | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(
        args, capture_output=True, text=True, input=stdin, timeout=120
    )


def running_container(name: str) -> bool:
    proc = _run(["docker", "inspect", "-f", "{{.State.Running}}", name])
    return proc.returncode == 0 and proc.stdout.strip() == "true"


def resolve_container(explicit: str, candidates: tuple[str, ...]) -> str:
    """The PBX container to read/write, or "".

    An explicit `--container`/`PBX_CONTAINER` WINS and is not a candidate among
    the defaults: naming a container that is not running must surface as "no
    PBX", never as the other product's PBX. Both products can be present at
    once (the hand-off leaves the old container stopped, not deleted), and
    editing the wrong one's routes sends live calls to the wrong place.
    """
    if explicit:
        return explicit if running_container(explicit) else ""
    for name in candidates:
        if running_container(name):
            return name
    return ""


def read_live_routes(container: str) -> str:
    proc = _run(
        ["docker", "exec", container, "mysql", "-N", "-B", "-u", "root",
         "asterisk", "-e", ROUTES_QUERY]
    )
    if proc.returncode != 0:
        raise RouteError(
            f"the PBX database did not answer `{ROUTES_QUERY}` in {container}: "
            f"{proc.stderr.strip().splitlines()[-1] if proc.stderr.strip() else proc.returncode}"
        )
    return proc.stdout


def create_missing(container: str, dids: list[str]) -> list[str]:
    """Create an inbound route for each DID in `dids`, via FreePBX's own API.

    Returns the DIDs actually created. A DID that turns out to have a row after
    all is reported as ``exists`` and not counted — the tool re-reads before it
    writes, so a concurrent GUI edit becomes a no-op rather than a duplicate.
    Raises `RouteError` if the API did not answer or refused a row.
    """
    proc = _run(
        [
            "docker", "exec", "-i",
            "-e", f"ZEUS_AVA_DIDS={json.dumps(dids)}",
            container, "php",
        ],
        # `.replace`, not `.format`: the script is PHP, so its braces are
        # control flow and a format spec would try to read them.
        stdin=CREATE_SCRIPT.replace('__ROUTER__', ROUTER),
    )
    if proc.returncode != 0:
        detail = proc.stderr.strip().splitlines()
        raise RouteError(
            f"FreePBX's API did not answer in {container}: "
            f"{detail[-1] if detail else proc.returncode}"
        )
    lines = [ln for ln in proc.stdout.strip().splitlines() if ln.strip()]
    try:
        results = json.loads(lines[-1])
    except (ValueError, IndexError) as exc:
        raise RouteError(f"could not read the create result from {container}: {exc}")
    failed = [row.get("did", "?") for row in results if row.get("result") == "failed"]
    if failed:
        raise RouteError(
            "FreePBX did not create a route for: " + ", ".join(failed)
        )
    return [row["did"] for row in results if row.get("result") == "created"]


def apply_sql(container: str, sql: str) -> None:
    proc = _run(
        ["docker", "exec", "-i", container, "mysql", "-u", "root", "asterisk"],
        stdin=sql,
    )
    if proc.returncode != 0:
        raise RouteError(
            f"mysql rejected the apply in {container}: {proc.stderr.strip()}"
        )


# ── CLI ──────────────────────────────────────────────────────────────────────


def _describe(report: Report, stream) -> None:
    for did in report.ok:
        print(f"  ok         {did} -> {ROUTER}", file=stream)
    for change in report.changes:
        why = []
        if change.destination_moved:
            why.append(
                "destination "
                f"{change.before_destination or '(none)'} -> {change.after_destination}"
            )
        if change.extension_recased:
            why.append(f"DID stored as {change.before_extension!r}")
        print(f"  drift      {change.did}: {'; '.join(why)}", file=stream)
    for did in report.missing:
        print(
            f"  refuse     {did}: no inbound route in FreePBX — add the route for "
            "this DID by hand, or pass --create-missing to have FreePBX's own "
            "API create it",
            file=stream,
        )
    for did in report.duplicates:
        print(
            f"  refuse     {did}: more than one inbound route — which one wins "
            "would be row order; leave exactly one",
            file=stream,
        )
    for row in report.left_alone:
        where = row.destination or "(no destination)"
        print(f"  left alone {row.extension} -> {where} (not a portal account)", file=stream)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Converge the platform DIDs' inbound routes onto the AVA router.",
        epilog=(
            "Exit: 0 in sync (or applied) — 1 routes this tool can converge — "
            "2 cannot tell (no PBX reachable / table unreadable) — 3 nothing to "
            "converge, but a row that needs a human (--check only)."
        ),
    )
    src = parser.add_mutually_exclusive_group(required=True)
    src.add_argument("--accounts-json", help="routing plan JSON (portal export)")
    src.add_argument("--db", help="portal SQLite database to read accounts from")
    routes_src = parser.add_mutually_exclusive_group()
    routes_src.add_argument("--routes-tsv", help="route table dump (offline, read-only)")
    routes_src.add_argument("--container", help="FreePBX container (default: discover)")
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--check", action="store_true", help="report drift, write nothing")
    action.add_argument("--apply", action="store_true", help="write the changes")
    parser.add_argument(
        "--revert-out",
        default="/root/zeus-route-revert.sql",
        help="where to write the undo script before applying (live apply only)",
    )
    parser.add_argument(
        "--sql-out",
        help="write the apply as SQL here instead of executing it (offline apply)",
    )
    parser.add_argument(
        "--create-missing",
        action="store_true",
        help="create a route for each plan DID that has none, through FreePBX's "
             "own API (live PBX only, needs --apply; the timer never passes it)",
    )
    parser.add_argument("--quiet", action="store_true", help="only the summary line")
    args = parser.parse_args(argv)

    # `--create-missing` is a deliberate, interactive act: it writes rows the
    # route table had no evidence for. Two guards keep it that way — an apply,
    # because a check must write nothing, and a live PBX, because a created row
    # is not expressible as the `--routes-tsv`/`--sql-out` SQL an offline run
    # emits (the row's other columns are FreePBX's to fill).
    if args.create_missing and not args.apply:
        parser.error("--create-missing needs --apply (it writes to the PBX)")
    if args.create_missing and (args.routes_tsv or args.sql_out):
        parser.error(
            "--create-missing needs a live PBX: creating a route means calling "
            "FreePBX's API, which an offline --routes-tsv/--sql-out run cannot do"
        )

    try:
        plan = (
            routing.load_plan(args.accounts_json)
            if args.accounts_json
            else routing.plan_from_db(args.db)
        )
        dids = plan_dids(plan)
    except (routing.PlanError, OSError) as exc:
        print(f"ava_routes: {exc}", file=sys.stderr)
        return 1

    if not dids:
        # No accounts is not "nothing to converge": it is a plan that would
        # un-wire every DID it does not list, which is exactly what a broken
        # export looks like.
        print(
            "ava_routes: the plan lists no DIDs — refusing to judge routes on an "
            "empty account list",
            file=sys.stderr,
        )
        return 1

    # Offline route source, or the live PBX.
    if args.routes_tsv:
        if args.apply and not args.sql_out:
            parser.error("--apply with --routes-tsv needs --sql-out (no PBX to write to)")
        try:
            with open(args.routes_tsv, "r", encoding="utf-8") as fh:
                route_text = fh.read()
        except OSError as exc:
            print(f"ava_routes: {exc}", file=sys.stderr)
            return 2
        container = ""
    else:
        container = resolve_container(
            args.container or os.environ.get("PBX_CONTAINER", ""),
            ("zeus-freepbx", "freepbx"),
        )
        if not container:
            print(
                "ava_routes: no FreePBX container running — cannot judge the "
                "routes (pass --container, or --routes-tsv for an offline dump)",
                file=sys.stderr,
            )
            return 2
        try:
            route_text = read_live_routes(container)
        except RouteError as exc:
            print(f"ava_routes: {exc}", file=sys.stderr)
            return 2

    try:
        rows = parse_routes(route_text)
    except RouteError as exc:
        print(f"ava_routes: {args.routes_tsv or container}: {exc}", file=sys.stderr)
        return 2

    report = build_report(dids, rows)
    out = sys.stderr if args.quiet else sys.stdout
    _describe(report, out)

    if args.check:
        summary = (
            f"ava_routes: {len(report.changes)} route(s) off {ROUTER}, "
            f"{len(report.refused)} row(s) this tool will not touch"
        )
        if report.changes:
            print(summary, file=sys.stderr)
            return 1
        if report.refused:
            # A refusal is not the same finding as a drift, and the caller has
            # to act differently: a drift is converged by an apply, a refusal is
            # converged by a person adding the route in FreePBX — no number of
            # re-runs will change it. Reporting it as plain drift is how an
            # always-failing check becomes an apply-and-reload every 15 minutes
            # on a live phone system that changes no row.
            print(summary, file=sys.stderr)
            return 3
        print(f"ava_routes: in sync ({len(report.ok)} DID(s) on {ROUTER})")
        return 0

    # --apply
    creations = [Creation(did) for did in report.missing] if args.create_missing else []
    created_dids: list[str] = []
    if not report.changes and not creations and not report.refused:
        print(f"ava_routes: already in sync ({len(report.ok)} DID(s))")
        return 0

    if report.changes or creations:
        if args.sql_out:
            with open(args.sql_out, "w", encoding="utf-8") as fh:
                fh.write(render_sql(report.changes))
            print(f"ava_routes: wrote {args.sql_out} ({len(report.changes)} change(s))")
        else:
            # The undo is written FIRST and its failure is fatal: an apply with
            # no way back is the thing P0's snapshot discipline exists to
            # prevent, and a half-created revert file is not a way back. It
            # covers the creations as well as the rewrites, so a run that fails
            # between the two halves is still undoable as one thing.
            revert = render_revert(report.changes, container, creations)
            try:
                with open(args.revert_out, "w", encoding="utf-8") as fh:
                    fh.write(revert)
            except OSError as exc:
                print(
                    f"ava_routes: refusing to apply — could not write the revert "
                    f"script {args.revert_out}: {exc}",
                    file=sys.stderr,
                )
                return 1
            print(f"ava_routes: revert script -> {args.revert_out}")
            if report.changes:
                try:
                    apply_sql(container, render_sql(report.changes))
                except RouteError as exc:
                    print(f"ava_routes: {exc}", file=sys.stderr)
                    print(f"ava_routes: undo with {args.revert_out}", file=sys.stderr)
                    return 1
                print(
                    f"ava_routes: applied {len(report.changes)} route(s); "
                    f"run `docker exec {container} fwconsole reload`"
                )
            if creations:
                try:
                    created_dids = create_missing(
                        container, [c.did for c in creations]
                    )
                except RouteError as exc:
                    print(f"ava_routes: {exc}", file=sys.stderr)
                    print(f"ava_routes: undo with {args.revert_out}", file=sys.stderr)
                    return 1
                for did in created_dids:
                    print(f"ava_routes: created route {did} -> {ROUTER}")
                appeared = sorted(
                    c.did for c in creations if c.did not in created_dids
                )
                if appeared:
                    # addDID refuses an extension/cidnum pair that already
                    # exists, so a route that appeared mid-run lands here. It is
                    # not a failure — the route exists — but it is not this
                    # tool's creation either.
                    print(
                        "ava_routes: no route created for "
                        + ", ".join(appeared)
                        + " (a row already existed for it)",
                        file=sys.stderr,
                    )
                print(
                    f"ava_routes: created {len(created_dids)} route(s); "
                    f"run `docker exec {container} fwconsole reload`"
                )

    refused = [d for d in report.missing if d not in created_dids] + report.duplicates
    if refused:
        print(
            "ava_routes: the routes above need a human (by default this tool "
            "converges existing rows only; --create-missing has FreePBX's own "
            "API add the ones that are absent) — re-run --check after fixing them",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
