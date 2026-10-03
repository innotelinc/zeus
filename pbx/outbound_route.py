#!/usr/bin/env python3
"""pbx/outbound_route.py — what a dialled number does: out by the trunk, or in.

The route half normalises what a phone actually dials. The internal-number half
keeps a number this estate already answers inwards off that route, so an
internal call is answered at once instead of being held for the inter-digit
timeout and, if the route wins, leaving by the carrier.

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

## The internal numbers, on the same principle

A number this estate already answers inwards — `4132951200` — is *also* matched
by the outbound route's ten-digit pattern. FreePBX's generated `[from-internal]`
includes `[from-internal-custom]` first and the routes after it, so a number that
is only a route pattern is held for the inter-digit timeout before the route is
reached; and when the route does win, the call leaves by the carrier and (for a
DID) may come straight back in. Which of the two a caller gets should not depend
on a timeout. A route cannot be told to *not* match a number, so the fix is not a
pattern: it is an exact `exten =>` in `[from-internal-custom]`, which Asterisk
matches immediately, ahead of every route.

The numbers are not invented here. They are the rows in FreePBX's own `incoming`
table — a number that already has an inbound route is one this estate owns. A
number that is also a user/device goes to FreePBX's own `[ext-local]`, so dialling
it rings the extension the operator provisioned; every other number goes to the
destination its inbound route already names. The entries are written as an
append-shared segment of the one shared `extensions_custom.conf` through
`pbx/asterisk_converge.py` under owner `internal`, so Zeus's and Capstone's
segments in that file are never disturbed, and a re-run is byte-identical.

## Reading and writing

    # judge, write nothing (0 in sync, 1 an apply converges it, 2 cannot tell)
    python3 pbx/outbound_route.py --check

    # the live PBX from the host (talks to the container's MySQL)
    python3 pbx/outbound_route.py --apply

    # inside the container, or on bare metal: the local MySQL and Asterisk
    python3 pbx/outbound_route.py --apply --local

    # an operator consolidating the estate: also remove these duplicate routes
    python3 pbx/outbound_route.py --apply --drop-route voipms

Exit codes follow `pbx/media_address.py`: 1 means an apply converges the estate,
2 means the question could not be answered (no PBX, no trunk, no route table) —
never a pass.

What this tool deliberately does NOT do: it does not touch any other route
unless an operator names one with `--drop-route`. A catch-all route that is not
the one named here is left where it is, reported, and simply moved below —
deleting or rewriting somebody else's route is not a normalisation, and a fax
route with its own caller ID (see `docs/legacy-voice-migration.md`) is an
operator's decision this file has no business making. `--drop-route NAME` is
that decision made explicit: it removes only the route named, only when asked,
never on a timer tick, and reports it like any other finding.

And it does not invent an internal number: only a row already in `incoming`
becomes an internal destination. A number with no inbound route is somebody
else's to add, and a pattern (`_X.`, `_2XX`) is never written as an exact
destination — putting a wildcard ahead of the routes is the failure this tool
exists to prevent, not repeat.
"""
from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
from dataclasses import dataclass

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import asterisk_converge as ac  # noqa: E402
import pbx_db  # noqa: E402

# The route this tool owns, and the trunk an outbound call must leave by.
DEFAULT_ROUTE = "PSTN"
DEFAULT_TRUNK = "voipms_pjsip"

# ── internal numbers (a number the estate already answers inwards) ──────────
# FreePBX answers a dialled number by walking [from-internal]'s includes in
# order. [from-internal-custom] comes first; the outbound routes come after.
# A number that has an *exact* `exten =>` in the custom context is therefore
# matched immediately, while a number that only matches a route's pattern is
# held for the inter-digit timeout first — which is the delay a caller hears
# before an internal line answers, and, when the route ends up winning, the
# reason an internal call leaves by the trunk at all.
#
# So an internal number is not a route problem to solve with patterns (a route
# cannot be told to *not* match a number): it is an exact destination written
# ahead of every route. Which numbers are internal is not invented here — it is
# FreePBX's own `incoming` table, because a number that already has an inbound
# route is one this estate owns. A number that is also a user/device goes to
# FreePBX's own [ext-local] (the extension dials, exactly as it does today);
# everything else goes to the destination its inbound route already names.
#
# The entries are written as an append-shared segment of [from-internal-custom]
# through `pbx/asterisk_converge.py` (owner `internal`), so the Zeus and Capstone
# segments in the one shared extensions_custom.conf are never disturbed.
INTERNAL_OWNER = "internal"
EXTENSIONS_CONF_PATH = "/etc/asterisk/extensions_custom.conf"
INCOMING_QUERY = "SELECT extension, destination FROM incoming"
#: The device rows FreePBX generates for a user/device — what makes a number a
#: local extension rather than only an inbound route. Same shape `scripts/
#: smoke-test.sh` reads for its media-address assertion.
DEVICES_QUERY = "SELECT id FROM devices WHERE tech IN ('sip','pjsip')"
#: `N` is 2-9, `X` is 0-9, `.`/`!` are wildcards — a `incoming.extension` that
#: is not a run of digits is a pattern (or FreePBX's catch-all) and is not a
#: number a person dials, so it is never written as an internal destination.
INCOMING_NUMBER_RE = re.compile(r"\+?\d{2,15}")
#: A FreePBX destination is `<context>,<exten>,<priority>` (or a two-field
#: special). Held to plain dialplan characters so a stray newline, quote or
#: parenthesis in a row could never inject a second dialplan line.
INCOMING_DEST_RE = re.compile(r"[A-Za-z0-9_.\-,]+")

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


@dataclass(frozen=True, order=True)
class InternalNumber:
    """A number the estate answers inwards, and the destination it already has."""

    number: str
    destination: str


@dataclass(frozen=True)
class State:
    """What the PBX currently says: routes, the trunk we need, and the numbers
    it already answers inwards.

    `extensions_conf` is the live `extensions_custom.conf` (None when it could
    not be read): the internal destinations are an append-shared segment of
    that file, so judging them means knowing its current bytes.
    """

    routes: tuple[Route, ...]
    trunk_id: int | None
    trunk_name: str
    internal: tuple[InternalNumber, ...] = ()
    extensions_conf: str | None = None
    #: The concatenated contents of `extensions_conf`'s `#include`d files — a
    #: number the included file already answers must not be written again.
    included_conf: str = ""


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


# ── the internal numbers (pure) ─────────────────────────────────────────────
def internal_number(raw: str) -> str:
    """The dialled form of a FreePBX `incoming.extension`: digits, no country code.

    The portal stores some DIDs with the leading `1` (`13025551002`) and FreePBX
    stores the ones it accepted without (`3025551002`) — the same normalisation
    `pbx/dograh_routes.py` makes, so an internal number and the route that names
    it agree on which line is meant.
    """
    digits = re.sub(r"\D", "", raw)
    return digits[1:] if len(digits) == 11 and digits.startswith("1") else digits


def parse_incoming_numbers(text: str) -> dict[str, str]:
    """`incoming` as {dialled number: destination}, patterns dropped.

    A row whose `extension` is a pattern (`_X.`, `_2XX`, FreePBX's catch-all) is
    not a number a person dials, so it cannot become an exact destination and is
    left out entirely — writing it would put a wildcard in front of the routes,
    which is the failure this tool exists to prevent, not repeat.
    """
    routes: dict[str, str] = {}
    for line in text.splitlines():
        parts = line.rstrip("\n").split("\t")
        if len(parts) < 2:
            continue
        raw, destination = parts[0].strip(), parts[1].strip()
        if not INCOMING_NUMBER_RE.fullmatch(raw):
            continue
        if not INCOMING_DEST_RE.fullmatch(destination):
            continue
        number = internal_number(raw)
        if number:
            routes[number] = destination
    return routes


def parse_extensions(text: str) -> set[str]:
    """The numbers FreePBX has a user/device for, as a set of dial strings."""
    return {token.strip() for token in text.splitlines() if token.strip().isdigit()}


def build_internal(routes: dict[str, str],
                   extensions: set[str]) -> tuple[InternalNumber, ...]:
    """Which numbers must be answered locally, and where each one goes.

    A number that is also a FreePBX user/device goes to `[ext-local]`, so dialling
    it rings the extension the operator provisioned. Anything else goes to the
    destination its own inbound route already names — an agent, a ring group, a
    queue — so an internal call reaches the same place an inbound call does.
    """
    out: list[InternalNumber] = []
    for number in sorted(routes):
        destination = (f"ext-local,{number},1" if number in extensions
                       else routes[number])
        out.append(InternalNumber(number=number, destination=destination))
    return tuple(out)


def render_internal_source(internal: tuple[InternalNumber, ...]) -> str:
    """The fragment `asterisk_converge.py` appends to [from-internal-custom].

    Exact `exten =>` lines (never a wildcard): Asterisk matches them before any
    route, so the call is answered immediately and the route's pattern never sees
    it. The body is regenerated every apply, so it is marked do-not-edit.
    """
    lines = [
        "[from-internal-custom]",
        "; Internal numbers — generated by pbx/outbound_route.py; do not edit.",
        "; Each number below already has a FreePBX inbound route, so it is a line",
        "; this estate owns: dialling it from an internal phone must reach the same",
        "; place at once, as an exact match ahead of the outbound routes, instead of",
        "; being held for the inter-digit timeout or taken by a route's pattern.",
    ]
    for entry in internal:
        lines.append("")
        lines.append(f"exten => {entry.number},1,NoOp(Internal number -> {entry.destination})")
        lines.append(f" same => n,Goto({entry.destination})")
    return "\n".join(lines) + "\n"


EXACT_EXTEN_RE = re.compile(r"\s*exten\s*=>\s*(\d+)\s*,")


def _exact_numbers(text: str, skip_owner: str | None = None) -> set[str]:
    """Exact `exten => <number>,` lines in [from-internal-custom] occurrences.

    `skip_owner` drops the lines inside that owner's marked segment, so our own
    previous output is not mistaken for somebody else's answer.
    """
    numbers: set[str] = set()
    for kind, *rest in ac.split_blocks(text):
        if kind != "ctx" or rest[0] != "from-internal-custom":
            continue
        in_owned = False
        for line in rest[1]:
            stripped = line.strip()
            if skip_owner and stripped == f"; >>> begin {skip_owner}":
                in_owned = True
                continue
            if skip_owner and stripped == f"; >>> end {skip_owner}":
                in_owned = False
                continue
            if in_owned:
                continue
            match = EXACT_EXTEN_RE.match(line)
            if match:
                numbers.add(match.group(1))
    return numbers


def reserved_numbers(have: str, included: str = "") -> set[str]:
    """Numbers an exact `exten =>` in [from-internal-custom] already answers,
    outside this tool's own segment — in the file and in anything it includes.

    Asterisk keeps the first definition and ignores the rest, so a second one is
    silently half-dead. The measured case is the agent extensions 8000-8008: rows
    in the same `incoming` table as the DIDs, so they look internal, but Capstone's
    own segment already dials 8000-8007 and the `#include`d
    `extensions_custom_dograh.conf` dials 8008. Only [from-internal-custom] is
    read — that is the context an internal number must be answered in, so an entry
    in another context ([dograh-inbound] has 8000-8007 too) does not by itself
    make the number dialable internally.
    """
    return (_exact_numbers(have, skip_owner=INTERNAL_OWNER)
            | _exact_numbers(included))


#: `#include <file>` / `#tryinclude <file>` — one level is what the measured
#: case needs (`extensions_custom.conf` includes the generated dograh file).
INCLUDE_RE = re.compile(r"\s*#\s*(?:include|tryinclude)\s+(\S+)\s*$")


def read_includes(text: str, *, local: bool, container: str,
                  base: str = os.path.dirname(EXTENSIONS_CONF_PATH)) -> str:
    """The concatenated contents of a config file's `#include`d files.

    A missing include is skipped rather than refused — an include naming a file
    that is not there is exactly the condition Asterisk itself reports, and it is
    not this tool's to fail the whole judgement over.
    """
    out: list[str] = []
    for line in text.splitlines():
        match = INCLUDE_RE.match(line)
        if not match:
            continue
        name = match.group(1)
        path = name if name.startswith("/") else f"{base.rstrip('/')}/{name}"
        content = read_pbx_file(path, local=local, container=container)
        if content:
            out.append(content)
    return "\n".join(out)


def merge_internal(have: str, internal: tuple[InternalNumber, ...],
                   included: str = "") -> str:
    """The extensions_custom.conf an apply would write, or the bytes already there.

    Append-shared through the same merger every other owner uses, so this tool
    only ever rewrites its own `; >>> begin internal` segment and leaves the Zeus
    and Capstone segments untouched. A number another segment — or an included
    file — already answers is dropped rather than duplicated.
    """
    reserved = reserved_numbers(have, included)
    wanted = tuple(e for e in internal if e.number not in reserved)
    return ac.merge_into(have, render_internal_source(wanted),
                         owner=INTERNAL_OWNER, append_shared={"from-internal-custom"})


def judge_internal(state: State) -> list[Finding]:
    """Findings for the internal-number segment.

    Empty when there are no internal numbers to write (an estate that routes
    nothing inwards is not judged, so a first run on a plain PBX writes nothing),
    or when the segment already matches what the `incoming` table implies.
    """
    if not state.internal:
        return []
    if state.extensions_conf is None:
        return [Finding(
            state="internal-numbers",
            detail=f"{len(state.internal)} internal number(s) are dialled within "
                   "this estate, but extensions_custom.conf could not be read, so "
                   "there is nowhere to answer them ahead of the outbound routes",
            repair="apply: read extensions_custom.conf on the PBX and re-run",
        )]
    want = merge_internal(state.extensions_conf, state.internal, state.included_conf)
    if want == state.extensions_conf:
        return []
    return [Finding(
        state="internal-numbers",
        detail=f"{len(state.internal)} internal number(s) ("
               + ", ".join(e.number for e in state.internal[:4])
               + (" …" if len(state.internal) > 4 else "")
               + ") match an outbound route's pattern, so an internal call is "
               "held for the inter-digit timeout — or leaves by the trunk",
        repair="apply: write the exact internal destinations into "
               "[from-internal-custom], ahead of every outbound route",
    )]


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


def read_pbx_file(path: str, *, local: bool, container: str) -> str | None:
    """A config file on the PBX, or None when it cannot be read.

    `local` is the in-container / bare-metal path; otherwise the host shells into
    the container. Absent is a real answer (the file may not exist yet) and is
    None rather than "", so a caller can tell "empty" from "could not read".
    """
    args = ["cat", path] if local else ["docker", "exec", container, "cat", path]
    try:
        proc = subprocess.run(args, capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return None
    return proc.stdout if proc.returncode == 0 else None


def write_pbx_file(path: str, text: str, *, local: bool, container: str) -> None:
    """Overwrite a config file on the PBX, or refuse loudly."""
    if local:
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(text)
        return
    # Write beside the target and rename, so a reload never sees a half-written
    # file; re-own it as Asterisk does for the other *_custom.conf fragments.
    script = (
        "set -e; "
        "tmp=$(mktemp /etc/asterisk/.outbound-route.XXXXXX); "
        "cat > \"$tmp\"; "
        "chown asterisk:asterisk \"$tmp\" 2>/dev/null || true; "
        f"mv \"$tmp\" {path}"
    )
    proc = subprocess.run(
        ["docker", "exec", "-i", container, "sh", "-c", script],
        input=text, capture_output=True, text=True, timeout=60,
    )
    if proc.returncode != 0:
        detail = proc.stderr.strip().splitlines()
        raise pbx_db.RouteError(
            f"could not write {path} in {container}: "
            f"{detail[-1] if detail else proc.returncode}"
        )


def load_state(*, local: bool, container: str, trunk_name: str) -> State:
    """Read the routes, patterns, trunks, the trunk we need, and the numbers the
    PBX already answers inwards."""
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
    internal = build_internal(
        parse_incoming_numbers(mysql(INCOMING_QUERY, local=local, container=container)),
        parse_extensions(mysql(DEVICES_QUERY, local=local, container=container)),
    )
    extensions_conf = read_pbx_file(EXTENSIONS_CONF_PATH, local=local, container=container)
    included_conf = (read_includes(extensions_conf, local=local, container=container)
                     if extensions_conf is not None else "")
    return State(
        routes=build_routes(rows, patterns, trunks),
        trunk_id=trunk_id,
        trunk_name=trunk_name,
        internal=internal,
        extensions_conf=extensions_conf,
        included_conf=included_conf,
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


def render_drop_sql(route_ids: tuple[int, ...]) -> str:
    """Remove the routes an operator named, and their own child rows.

    Only reachable through `--drop-route`, so a convergence the sync timer runs
    never deletes anything: the named route's own rows go with it, and the next
    `render_apply_sql` rewrites the sequence from the routes that remain.
    """
    ids = sorted({int(i) for i in route_ids})
    if not ids:
        return ""
    joined = ", ".join(str(i) for i in ids)
    return "\n".join([
        f"DELETE FROM outbound_route_patterns WHERE route_id IN ({joined});",
        f"DELETE FROM outbound_route_trunks WHERE route_id IN ({joined});",
        f"DELETE FROM outbound_route_sequence WHERE route_id IN ({joined});",
        f"DELETE FROM outbound_routes WHERE route_id IN ({joined});",
    ])


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
    parser.add_argument("--drop-route", action="append", default=[], metavar="NAME",
                        help="also remove a duplicate route by name (repeatable; "
                             "an operator's explicit decision, never automatic)")
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

    drop_names = {name.strip() for name in args.drop_route if name.strip()}
    doomed = [r for r in state.routes if r.name in drop_names and r.name != args.name]

    findings, plan = judge(state, args.name)
    findings += judge_internal(state)
    if doomed:
        named = ", ".join(f"{r.route_id} ({r.name})" for r in doomed)
        findings.append(Finding(
            state="duplicate-route",
            detail=f"route(s) {named} duplicate {args.name}'s dial patterns and were "
                   "named for removal — the first of them takes the call while "
                   f"{args.name} never runs",
            repair=f"apply: delete the named duplicate route(s) {named}",
        ))

    where = "the local PBX" if local else container
    print(f"outbound-route: {len(state.routes)} route(s) on {where}, "
          f"trunk {args.trunk} is {state.trunk_id}"
          + (f", {len(state.internal)} internal number(s)" if state.internal else ""))
    for finding in findings:
        print(f"  {finding.state}: {finding.detail}", file=sys.stderr)
        print(f"    repair: {finding.repair}", file=sys.stderr)
    if not findings:
        print(f"outbound-route: route {args.name!r} normalises dialled numbers and "
              "precedes anything that would take its calls"
              + ("; every internal number is answered ahead of it"
                 if state.internal else ""))
        return 0

    if not args.apply:
        print(f"outbound-route: {len(findings)} finding(s) — re-run with --apply "
              "to converge the route", file=sys.stderr)
        return 1

    try:
        if doomed:
            mysql(render_drop_sql(tuple(r.route_id for r in doomed)),
                  local=local, container=container)
            # The sequence is rewritten from what is left, so re-read the PBX
            # rather than plan against routes that are now gone.
            state = load_state(local=local, container=container, trunk_name=args.trunk)
            findings, plan = judge(state, args.name)
        plan = ensure_route(plan, local=local, container=container)
        mysql(render_apply_sql(plan), local=local, container=container)
        if state.internal:
            if state.extensions_conf is None:
                raise pbx_db.RouteError(
                    "extensions_custom.conf could not be read, so the internal "
                    "destinations were not written"
                )
            merged = merge_internal(state.extensions_conf, state.internal,
                                    state.included_conf)
            if merged != state.extensions_conf:
                write_pbx_file(EXTENSIONS_CONF_PATH, merged,
                               local=local, container=container)
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
    remaining += judge_internal(state)
    still_named = [r for r in state.routes if r.name in drop_names and r.name != args.name]
    if remaining or still_named:
        for finding in remaining:
            print(f"  still: {finding.state}: {finding.detail}", file=sys.stderr)
        for route in still_named:
            print(f"  still: route {route.route_id} ({route.name}) was named for "
                  "removal and is still here", file=sys.stderr)
        print(f"outbound-route: route {args.name!r} did not converge", file=sys.stderr)
        return 1
    dropped = (f" (removed duplicate route(s) "
               f"{', '.join(r.name for r in doomed)})") if doomed else ""
    internals = (f" and {len(state.internal)} internal number(s) answered ahead "
                 "of the routes") if state.internal else ""
    print(f"outbound-route: route {args.name!r} converged (normalises dialled "
          f"numbers, trunk {args.trunk} first, ahead of anything that would take "
          f"its calls){dropped}{internals}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
