#!/usr/bin/env python3
"""pbx/outbound_route.py — the route that normalises what a phone actually dials.

A phone on this estate dials a number the way a person does: ten digits,
`4134210134`. The trunk does not want ten digits. VoIP.ms terminates a North
American call on eleven — `1` + area code + number — and a ten-digit string
leaves as ten digits and does not complete. The route is where that `1` is
supposed to be added, and on this estate the route it reached had `X.` as its
first pattern: *one or more digits, any of them, passed through unchanged*. So
every call left with the digits the caller dialled and nothing normalised them,
which is exactly the reported symptom — "dialling 4134210134 it doesn't go
through", with the trunk registered and every other check green.

Zeus did not write outbound routes at all. `pbx/legacy_voice_migrate.py`
*reports* them and `docs/legacy-voice-migration.md` lists the decision as open,
because the legacy `PSTN` route's normalisation sat behind a catch-all and
adopting it meant changing the priority of a live dial plan. This tool is that
change, made explicit and idempotent rather than left to a GUI edit:

  * the route (`name`, default `PSTN`) is created if it is missing;
  * it normalises what a phone dials, which is the whole point of the route:
    ten-digit -> `1` (the country code VoIP.ms terminates on) and seven-digit ->
    `1413` (the area code). Those two rules are *required*; a route that already
    has them keeps its own extra patterns, because rewriting a working dial plan
    to a byte-exact list is churn. A route created from scratch gets the legacy
    set as well — eleven-digit and `011.` international passed through;
  * the VoIP.ms PJSIP trunk is attached, first, so the call leaves by it;
  * and the route is lifted above anything ahead of it that would take the same
    calls — a bare catch-all (`X.`, or the `_Z.` the portal dialplan shipped),
    or a second route with the same dial patterns pointed at another trunk.
    FreePBX evaluates routes in sequence order, and this estate had both: a
    `_Z.` extension in the context `from-internal` includes *before* the routes,
    which hung up every dialled number, and a duplicate `voipms` route ahead of
    `PSTN` that took the calls PSTN was meant to handle.

## Reading and writing

    # judge, write nothing (0 in sync, 1 an apply converges it, 2 cannot tell)
    python3 pbx/outbound_route.py --check

    # the live PBX from the host (talks to the container's MySQL)
    python3 pbx/outbound_route.py --apply

    # inside the container, or on bare metal: the local MySQL and Asterisk
    python3 pbx/outbound_route.py --apply --local

Exit codes follow `pbx/media_address.py`: 1 means an apply converges the estate,
2 means the question could not be answered (no PBX, no trunk, no route table) —
never a pass.

What this tool deliberately does NOT do: it does not touch any other route. A
catch-all route that is not the one named here is left where it is, reported,
and simply moved below — deleting or rewriting somebody else's route is not a
normalisation, and a fax route with its own caller ID (see
`docs/legacy-voice-migration.md`) is an operator's decision this file has no
business making.
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
from dataclasses import dataclass

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pbx_db  # noqa: E402

# The route this tool owns, and the trunk an outbound call must leave by.
DEFAULT_ROUTE = "PSTN"
DEFAULT_TRUNK = "voipms_pjsip"

# FreePBX `N` is 2-9, `X` is 0-9, `.` is one-or-more of the preceding set —
# the DSL the legacy PSTN route was written in, restored verbatim: a seven-digit
# local call gets the 413 area code, a ten-digit call gets the country code, and
# an eleven-digit or 011-prefixed international call is dialled through as-is.
LEGACY_PATTERNS: tuple[tuple[str, str, str], ...] = (
    ("", "NXXXXXX", "1413"),
    ("", "NXXNXXXXXX", "1"),
    ("", "1NXXNXXXXXX", ""),
    ("", "011.", ""),
)

# The two rules that ARE the fix, and the only ones an existing route must carry.
# A route is compared against these rather than against the full set above: the
# box this was written for passes eleven digits through with `ZNXXNXXXXXX`
# (`Z` is 1-9, so it also covers `1NXXNXXXXXX`), and rewriting a *working*
# dial plan to a byte-exact list is churn, not a repair. Extras are preserved;
# what is required is that ten-digit dialling gets the country code and
# seven-digit gets the area code, and that no catch-all is present to swallow
# a number before these are reached.
REQUIRED_PATTERNS: tuple[tuple[str, str, str], ...] = (
    ("", "NXXNXXXXXX", "1"),
    ("", "NXXXXXX", "1413"),
)

# A pattern that matches every number a phone dials, however long. One of these
# in a route ahead of ours swallows the call before the normalisation is
# reached. `X` is 0-9 and `Z` is 1-9; `.` is one-or-more and `!` zero-or-more —
# so `X.` is every number and `Z.` every number that starts 1-9, which is every
# number a person dials. `Z.` is the shape that shipped in the portal dialplan
# (`exten => _Z.`) and hung up outbound calls before any route ran.
CATCH_ALL = frozenset({"X.", "X", ".", "Z.", "Z!", "X!"})


@dataclass(frozen=True, order=True)
class Pattern:
    prefix: str
    match: str
    prepend: str = ""


@dataclass(frozen=True)
class Route:
    route_id: int
    name: str
    seq: int
    patterns: tuple[Pattern, ...]
    trunks: tuple[tuple[int, str], ...] = ()  # (trunk_id, trunk name) in seq order


@dataclass(frozen=True)
class State:
    """What the PBX currently says: its routes and the trunk we need by name."""

    routes: tuple[Route, ...]
    trunk_id: int | None
    trunk_name: str


@dataclass(frozen=True)
class Finding:
    state: str
    detail: str
    repair: str


@dataclass(frozen=True)
class Plan:
    """The writes an apply would make, or already made."""

    route_id: int
    name: str
    patterns: tuple[Pattern, ...]
    trunk_ids: tuple[int, ...]
    order: tuple[int, ...]
    created: bool


# ── the PBX's answers (pure) ────────────────────────────────────────────────
def parse_routes(text: str) -> list[tuple[int, str, int]]:
    """`outbound_routes` JOINed to its sequence as [(route_id, name, seq)].

    A route with no sequence row is invisible to FreePBX's own listing and to
    the dialplan, so it is given a seq past every real one rather than dropped:
    "present but unreachable" is a state this tool must be able to name. The
    query COALESCEs the missing row to 999999 for the same reason.
    """
    out: list[tuple[int, str, int]] = []
    for raw in text.splitlines():
        parts = raw.rstrip("\n").split("\t")
        if len(parts) < 3:
            continue
        try:
            route_id = int(parts[0])
        except ValueError:
            continue
        seq_raw = parts[2].strip()
        seq = int(seq_raw) if seq_raw.lstrip("-").isdigit() else 10**9
        out.append((route_id, parts[1].strip(), seq))
    return out


def parse_patterns(text: str) -> dict[int, tuple[Pattern, ...]]:
    """`outbound_route_patterns` as {route_id: (Pattern, ...)}."""
    found: dict[int, list[Pattern]] = {}
    for raw in text.splitlines():
        parts = raw.rstrip("\n").split("\t")
        if len(parts) < 4:
            continue
        try:
            route_id = int(parts[0])
        except ValueError:
            continue
        found.setdefault(route_id, []).append(
            Pattern(prefix=parts[1].strip(), match=parts[2].strip(),
                    prepend=parts[3].strip())
        )
    return {route_id: tuple(p) for route_id, p in found.items()}


def parse_trunks(text: str) -> dict[int, tuple[tuple[int, str], ...]]:
    """`outbound_route_trunks` as {route_id: ((trunk_id, name), ...) in seq order}."""
    found: dict[int, list[tuple[int, str]]] = {}
    for raw in text.splitlines():
        parts = raw.rstrip("\n").split("\t")
        if len(parts) < 2:
            continue
        try:
            route_id = int(parts[0])
            trunk_id = int(parts[1])
        except ValueError:
            continue
        name = parts[3].strip() if len(parts) > 3 else ""
        found.setdefault(route_id, []).append((trunk_id, name))
    return {route_id: tuple(t) for route_id, t in found.items()}


def build_routes(route_rows: list[tuple[int, str, int]],
                 patterns: dict[int, tuple[Pattern, ...]],
                 trunks: dict[int, tuple[tuple[int, str], ...]]) -> tuple[Route, ...]:
    return tuple(
        Route(route_id=rid, name=name, seq=seq,
              patterns=patterns.get(rid, ()), trunks=trunks.get(rid, ()))
        for rid, name, seq in route_rows
    )


# ── the judgement (pure) ────────────────────────────────────────────────────
def normalised_match(pattern: Pattern) -> str:
    """A pattern's match with the dialplan's leading `_` and case removed."""
    return pattern.match.lstrip("_").strip().upper()


def is_catch_all(pattern: Pattern) -> bool:
    """Whether this pattern matches every number, so anything behind it is dead."""
    return not pattern.prefix.strip() and normalised_match(pattern) in CATCH_ALL


def captures(other: Route, target: Route) -> bool:
    """Whether a route placed ahead of `target` would take the calls `target` should.

    Two shapes count. A catch-all takes everything. So does a route whose
    pattern *shapes* are a superset of the target's: an operator can add a
    second route with the same dial patterns pointed at a different trunk (the
    live box has three such routes), and the first one then answers every call
    while the named route never runs. Prefix and match are compared, not the
    prepend — the shapes decide which dialled numbers the route is consulted
    for, and a differing prepend means it also sends them out wrong.
    """
    if not target.patterns:
        return False
    if any(is_catch_all(p) for p in other.patterns):
        return True
    other_shapes = {(p.prefix, normalised_match(p)) for p in other.patterns}
    target_shapes = {(p.prefix, normalised_match(p)) for p in target.patterns}
    return target_shapes <= other_shapes


def shadowers(routes: tuple[Route, ...], target: Route) -> list[Route]:
    """The routes ahead of `target` that would take its calls instead."""
    return [r for r in routes
            if r.route_id != target.route_id and r.seq < target.seq
            and captures(r, target)]


def desired_patterns() -> tuple[Pattern, ...]:
    """The full set a route created from scratch gets."""
    return tuple(Pattern(prefix=p, match=m, prepend=v) for p, m, v in LEGACY_PATTERNS)


def required_patterns() -> tuple[Pattern, ...]:
    """The normalisation rules an existing route must carry (superset, not equal)."""
    return tuple(Pattern(prefix=p, match=m, prepend=v) for p, m, v in REQUIRED_PATTERNS)


def _order(routes: tuple[Route, ...], target: Route | None,
           created: bool) -> tuple[int, ...]:
    """The route sequence an apply writes.

    A newly created route goes to the front; so does one that is currently
    behind a route that would take its calls, but only far enough to clear the
    first such route — everything else keeps its relative order, because
    reordering a live dial plan is the whole reason this decision sat open, and
    the smallest move that makes the route reachable is the only one this tool
    is entitled to make.
    """
    ids = [r.route_id for r in routes]
    if created or target is None:
        return tuple([target.route_id] if target else []) + tuple(
            i for i in ids if target is None or i != target.route_id)
    shadowing = shadowers(routes, target)
    if not shadowing:
        return tuple(ids)
    first = min(shadowing, key=lambda r: r.seq)
    rest = [i for i in ids if i != target.route_id]
    rest.insert(rest.index(first.route_id), target.route_id)
    return tuple(rest)


def judge(state: State, name: str) -> tuple[list[Finding], Plan | None]:
    """(findings, plan). An empty finding list means the route is in sync.

    This tool judges tables, not dialplan files, so the `_Z.`-in-`from-zeus-portal`
    shape is reported by `pbx/tests/test_parity_checklist.py` against the shipped
    fragment and by `scripts/smoke-test.sh` against the live dialplan — a route
    tool cannot see it. What this tool does see, and fixes, is a duplicate route
    ahead of the named one.

    The plan is produced even when there are no findings, so an apply has one
    shape and `--check` and `--apply` cannot disagree about what the target is.
    """
    desired = desired_patterns()
    target = next((r for r in state.routes if r.name == name), None)

    findings: list[Finding] = []
    created = target is None
    if created:
        findings.append(Finding(
            state="no-route",
            detail=f"no outbound route is named {name!r} — a phone dialling out "
                   "reaches whatever route happens to be first, with none of the "
                   "digit normalisation the trunk needs",
            repair=f"apply: create route {name!r} with the legacy PSTN patterns",
        ))

    patterns_ok = True
    if target is not None:
        have = {(p.prefix, p.match, p.prepend) for p in target.patterns}
        missing = sorted({(p.prefix, p.match, p.prepend) for p in required_patterns()} - have)
        catching = [p for p in target.patterns if is_catch_all(p)]
        patterns_ok = not missing and not catching
        if missing:
            findings.append(Finding(
                state="patterns",
                detail=f"route {target.route_id} ({target.name}) does not normalise "
                       + ", ".join(f"{m} + {v}" if v else m for _, m, v in missing)
                       + " — a dialled number leaves without the digits the trunk needs",
                repair="apply: add the missing legacy PSTN pattern(s)",
            ))
        if catching:
            findings.append(Finding(
                state="catch-all",
                detail=f"route {target.route_id} ({target.name}) holds "
                       + ", ".join(sorted({normalised_match(p) for p in catching}))
                       + " — a pattern that matches every dialled number, so whatever "
                       "it is ordered before never runs",
                repair="apply: replace the catch-all with the legacy PSTN patterns",
            ))
        attached = [tid for tid, _ in target.trunks]
        if state.trunk_id not in attached:
            findings.append(Finding(
                state="no-trunk",
                detail=f"route {target.route_id} ({target.name}) does not use the "
                       f"{state.trunk_name} trunk, so an outbound call has nothing "
                       "to leave by",
                repair=f"apply: attach trunk {state.trunk_id} ({state.trunk_name}) first",
            ))
        elif attached[0] != state.trunk_id:
            findings.append(Finding(
                state="trunk-order",
                detail=f"route {target.route_id} ({target.name}) tries "
                       f"{target.trunks[0][1] or target.trunks[0][0]} before "
                       f"{state.trunk_name}",
                repair=f"apply: move {state.trunk_name} to the front of the trunk list",
            ))

    # Priority: a route ahead that would take the same calls swallows them
    # before the normalisation is reached — a catch-all, or a second route with
    # the same dial patterns pointed at another trunk. This is the measured
    # failure on this estate.
    if target is not None:
        shadowing = shadowers(state.routes, target)
        if shadowing:
            names = ", ".join(f"{r.route_id} ({r.name})" for r in shadowing)
            findings.append(Finding(
                state="shadowed",
                detail=f"route(s) {names} sit ahead of {target.name} and would "
                       "take the same dialled numbers, so the call never "
                       f"reaches {target.name}",
                repair=f"apply: move {target.name} above {names}",
            ))

    if state.trunk_id is not None:
        existing_extra = [tid for tid, _ in (target.trunks if target else ())]
        trunk_ids = tuple([state.trunk_id] + [t for t in existing_extra if t != state.trunk_id])
    else:
        trunk_ids = ()

    # An existing route keeps its own patterns when they already normalise —
    # only a missing rule or a catch-all is rewritten.
    if target is not None and patterns_ok:
        patterns = target.patterns
    else:
        patterns = desired

    plan = Plan(
        route_id=target.route_id if target else -1,
        name=name,
        patterns=patterns,
        trunk_ids=trunk_ids,
        order=_order(state.routes, target, created),
        created=created,
    )
    return findings, plan


# ── the live PBX ────────────────────────────────────────────────────────────
ROUTES_QUERY = (
    "SELECT r.route_id, r.name, COALESCE(s.seq, 999999) FROM outbound_routes r "
    "LEFT JOIN outbound_route_sequence s ON s.route_id = r.route_id "
    "ORDER BY COALESCE(s.seq, 999999), r.route_id"
)
PATTERNS_QUERY = (
    "SELECT route_id, match_pattern_prefix, match_pattern_pass, prepend_digits "
    "FROM outbound_route_patterns ORDER BY route_id, match_pattern_prefix, match_pattern_pass"
)
# `outbound_route_trunks.trunk_id` is the child column; the trunk table's own
# key is `trunkid` (FreePBX's schema, and this estate's live box — a `t.trunk_id`
# join is a hard SQL error there, so it is named once here and nowhere else).
TRUNKS_QUERY = (
    "SELECT a.route_id, a.trunk_id, a.seq, t.name FROM outbound_route_trunks a "
    "LEFT JOIN trunks t ON t.trunkid = a.trunk_id ORDER BY a.route_id, a.seq"
)


def quote(value: str) -> str:
    """A single-quoted MySQL string. Doubling the quote is the whole escape."""
    return "'" + value.replace("\\", "\\\\").replace("'", "''") + "'"


def mysql(sql: str, *, local: bool, container: str) -> str:
    """Run SQL against the PBX's `asterisk` database.

    `local` is the inside-the-container / bare-metal path (the entrypoint and
    `scripts/setup.sh`); otherwise the host shells into the `zeus-freepbx`
    container, which is what the timer does.
    """
    if local:
        proc = subprocess.run(
            ["mysql", "-N", "-B", "-u", "root", "asterisk", "-e", sql],
            capture_output=True, text=True, timeout=60,
        )
        if proc.returncode != 0:
            detail = proc.stderr.strip().splitlines()
            raise pbx_db.RouteError(
                "the PBX database did not answer: "
                f"{detail[-1] if detail else proc.returncode}"
            )
        return proc.stdout
    return pbx_db.mysql_exec(container, sql)


def load_state(*, local: bool, container: str, trunk_name: str) -> State:
    """Read the routes, patterns, trunks — and the trunk we need, by name."""
    rows = parse_routes(mysql(ROUTES_QUERY, local=local, container=container))
    patterns = parse_patterns(mysql(PATTERNS_QUERY, local=local, container=container))
    trunks = parse_trunks(mysql(TRUNKS_QUERY, local=local, container=container))
    trunk_text = mysql(
        f"SELECT trunkid FROM trunks WHERE name = {quote(trunk_name)} "
        "ORDER BY trunkid LIMIT 1",
        local=local, container=container,
    )
    trunk_id = None
    for line in trunk_text.splitlines():
        token = line.strip()
        if token.isdigit():
            trunk_id = int(token)
            break
    return State(
        routes=build_routes(rows, patterns, trunks),
        trunk_id=trunk_id,
        trunk_name=trunk_name,
    )


def render_apply_sql(plan: Plan) -> str:
    """The multi-statement apply, in one transaction-shaped script.

    Ordered so a failure leaves the route row and its children consistent:
    patterns and trunks are replaced wholesale (they are this route's own), then
    the sequence is rewritten from the plan — the same thing FreePBX's own
    `setOrder` does, and the reason a re-run changes nothing.
    """
    lines = [f"DELETE FROM outbound_route_patterns WHERE route_id = {plan.route_id};"]
    for pattern in plan.patterns:
        lines.append(
            "INSERT INTO outbound_route_patterns "
            "(route_id, match_pattern_prefix, match_pattern_pass, match_cid, prepend_digits) "
            f"VALUES ({plan.route_id}, {quote(pattern.prefix)}, {quote(pattern.match)}, "
            f"'', {quote(pattern.prepend)});"
        )
    lines.append(f"DELETE FROM outbound_route_trunks WHERE route_id = {plan.route_id};")
    for seq, trunk_id in enumerate(plan.trunk_ids):
        lines.append(
            "INSERT INTO outbound_route_trunks (route_id, trunk_id, seq) "
            f"VALUES ({plan.route_id}, {trunk_id}, {seq});"
        )
    lines.append("DELETE FROM outbound_route_sequence;")
    for seq, route_id in enumerate(plan.order):
        lines.append(
            f"INSERT INTO outbound_route_sequence (route_id, seq) VALUES ({route_id}, {seq});"
        )
    return "\n".join(lines)


def ensure_route(plan: Plan, *, local: bool, container: str) -> Plan:
    """Create the route when it is missing, returning the plan with its real id."""
    if not plan.created:
        return plan
    out = mysql(
        f"INSERT INTO outbound_routes (name) VALUES ({quote(plan.name)}); "
        "SELECT LAST_INSERT_ID();",
        local=local, container=container,
    )
    route_id = None
    for line in out.splitlines():
        token = line.strip()
        if token.isdigit():
            route_id = int(token)
    if route_id is None:
        raise pbx_db.RouteError(f"could not read back the new route id for {plan.name!r}")
    order = tuple([route_id] + [r for r in plan.order if r != route_id])
    return Plan(
        route_id=route_id, name=plan.name, patterns=plan.patterns,
        trunk_ids=plan.trunk_ids, order=order, created=True,
    )


def reload_pbx(*, local: bool, container: str) -> None:
    """Regenerate the dialplan from the DB — a route change is not live until it runs."""
    if local:
        args = ["fwconsole", "reload"]
    else:
        args = ["docker", "exec", container, "fwconsole", "reload"]
    try:
        subprocess.run(args, capture_output=True, text=True, timeout=300)
    except (OSError, subprocess.SubprocessError):
        pass


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--name", default=os.environ.get("PBX_OUTBOUND_ROUTE", DEFAULT_ROUTE),
                        help=f"the outbound route to converge (default: {DEFAULT_ROUTE})")
    parser.add_argument("--trunk",
                        default=os.environ.get("VOIPMS_TRUNK_NAME", "").strip() or DEFAULT_TRUNK,
                        help=f"the trunk outbound calls must use (default: {DEFAULT_TRUNK})")
    parser.add_argument("--container", default=os.environ.get("PBX_CONTAINER", ""),
                        help="the FreePBX container to read (default: autodetect)")
    parser.add_argument("--local", action="store_true",
                        help="talk to the local MySQL/Asterisk (inside the container or bare metal)")
    parser.add_argument("--apply", action="store_true",
                        help="write the route (default: judge only)")
    parser.add_argument("--check", action="store_true",
                        help="judge and exit 0/1/2 (the default; writes nothing)")
    args = parser.parse_args(argv)

    local = args.local
    container = ""
    if not local:
        container = pbx_db.resolve_container(args.container)
        if not container:
            print("outbound-route: no FreePBX container found — cannot tell", file=sys.stderr)
            return 2

    try:
        state = load_state(local=local, container=container, trunk_name=args.trunk)
    except pbx_db.RouteError as exc:
        print(f"outbound-route: {exc} — cannot tell", file=sys.stderr)
        return 2

    if state.trunk_id is None:
        print(
            f"outbound-route: no trunk named {args.trunk!r} on the PBX — the route "
            "would have nothing to dial out through, so nothing is written",
            file=sys.stderr,
        )
        return 2

    findings, plan = judge(state, args.name)
    where = "the local PBX" if local else container
    print(f"outbound-route: {len(state.routes)} route(s) on {where}, "
          f"trunk {args.trunk} is {state.trunk_id}")
    for finding in findings:
        print(f"  {finding.state}: {finding.detail}", file=sys.stderr)
        print(f"    repair: {finding.repair}", file=sys.stderr)
    if not findings:
        print(f"outbound-route: route {args.name!r} normalises dialled numbers and "
              "precedes anything that would take its calls")
        return 0

    if not args.apply:
        print(f"outbound-route: {len(findings)} finding(s) — re-run with --apply "
              "to converge the route", file=sys.stderr)
        return 1

    try:
        plan = ensure_route(plan, local=local, container=container)
        mysql(render_apply_sql(plan), local=local, container=container)
    except pbx_db.RouteError as exc:
        print(f"outbound-route: {exc} — the route was not converged", file=sys.stderr)
        return 2
    reload_pbx(local=local, container=container)

    # The read-back is the PBX's answer after the reload, not the write we just
    # made — a convergence that cannot be observed is not a convergence.
    try:
        state = load_state(local=local, container=container, trunk_name=args.trunk)
    except pbx_db.RouteError as exc:
        print(f"outbound-route: {exc} — written but not verified", file=sys.stderr)
        return 2
    remaining, _ = judge(state, args.name)
    if remaining:
        for finding in remaining:
            print(f"  still: {finding.state}: {finding.detail}", file=sys.stderr)
        print(f"outbound-route: route {args.name!r} did not converge", file=sys.stderr)
        return 1
    print(f"outbound-route: route {args.name!r} converged (normalises dialled "
          f"numbers, trunk {args.trunk} first, ahead of anything that would take "
          "its calls)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
