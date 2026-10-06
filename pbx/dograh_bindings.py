#!/usr/bin/env python3
"""pbx/dograh_bindings.py — the route a portal binding asks for, made real.

`voice_bindings` is the portal's record of which workflow a number reaches, and
FreePBX's `incoming` table is where that decision is actually executed. They are
two stores with no writer between them: `PUT /api/voice/agent-mapping` sets the
binding, and the dialplan goes on answering with whatever row it already had — so
an operator changes a binding, the portal agrees, and the calls do not. That is
the same silent-wrong-agent shape `pbx/dograh_routes.py` reports; this is the
writer for the other half, so the two cannot drift.

Resolving a binding to a destination is the whole reason this is a tool rather
than a template, and it is why nothing here is guessed:

  * The binding is a **workflow** — the Dograh id or name the Voice screen stores
    (`value: String(agent.id)`) — measured on this estate, `4` and
    `Business Receptionist` are the same workflow. `src/lib/voice-bindings.ts`
    is the authority on the stored spelling.
  * The dialplan entry is that workflow's **number**, and the number belongs to
    the engine: `telephony_phone_numbers` binds each SIP extension (`8000`…
    `8008`) to an `inbound_workflow_id`. It is not arithmetic — `8008` is
    workflow **10** — so it is read, never derived (`--numbers-tsv` is a dumped
    mapping for rehearsal, exactly as `pbx/dograh_routes.py --incoming-tsv` is).
  * A binding that resolves to nothing, and a DID with no row to repoint, are
    refused **by name** and never invented: a wrong guess re-points a customer's
    number at somebody else's agent (docs/voice-convergence.md §7).

Read-only by default; `--apply` writes the rows it can and reports the rest.

    python3 pbx/dograh_bindings.py --db <portal.pbx.db> --check
    python3 pbx/dograh_bindings.py --db <portal.pbx.db> --apply

    # the off-host rehearsal: the engine's mapping and the route table as dumps
    python3 pbx/dograh_bindings.py --db <portal.pbx.db> \
        --numbers-tsv numbers.tsv --incoming-tsv incoming.tsv --check

Exit status, three-valued like its siblings:

    0 — every bound DID already reaches the workflow its binding names
    1 — one does not, or cannot be resolved (an apply converges what it can)
    2 — nothing could be evaluated (no portal db, no mapping, no PBX): not
        evidence of health
"""
from __future__ import annotations

import argparse
import os
import sqlite3
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pbx_db  # noqa: E402
from dograh_routes import normalise_did, parse_incoming  # noqa: E402

# Every Dograh workflow entry point is spelled `<context>,<workflow>,1`.
CONTEXT = "dograh-inbound"

# The bound DIDs, and only the ones the portal still sells: a binding left behind
# for a number this account no longer holds is not a route to write.
BINDINGS_QUERY = (
    "SELECT vb.did, vb.capstone_binding "
    "FROM voice_bindings vb "
    "JOIN phone_numbers pn ON pn.did = vb.did AND pn.status = 'active' "
    "WHERE vb.capstone_binding IS NOT NULL AND vb.capstone_binding != '' "
    "ORDER BY vb.did"
)

INCOMING_QUERY = "SELECT extension, destination FROM incoming"

# The engine's own join: the workflow it holds, and the dialplan number it
# assigned it. Read from Dograh's database because no HTTP route publishes it,
# and never inferred from the id — the numbers are the engine's to choose.
NUMBERS_QUERY = (
    "SELECT p.inbound_workflow_id, w.name, p.address "
    "FROM telephony_phone_numbers p "
    "LEFT JOIN workflows w ON w.id = p.inbound_workflow_id "
    "WHERE p.is_active "
    "ORDER BY p.inbound_workflow_id"
)

# Where Dograh's database lives on this estate. A Zeus tool reads it read-only and
# only for this mapping; the name is overridable for a split deployment.
DOGRAH_DB_CONTAINER = os.environ.get("ZEUS_DOGRAH_DB_CONTAINER", "capstone-postgres-1")


class MappingError(RuntimeError):
    """A mapping that cannot be read or cannot resolve a binding."""


# ── the two halves (pure) ───────────────────────────────────────────────────
def parse_numbers(text: str) -> tuple[dict[str, str], dict[str, str]]:
    """(by workflow id, by workflow name) -> dialplan number, from the dump.

    Three columns per line — `id<TAB>name<TAB>address` — because a binding may be
    stored as either spelling. A row with no id (a number bound to nothing) or no
    name still contributes the half it has; a row with neither is skipped rather
    than allowed to shadow a real one under an empty key.
    """
    by_id: dict[str, str] = {}
    by_name: dict[str, str] = {}
    for raw in text.splitlines():
        parts = raw.rstrip("\n").split("\t")
        if len(parts) < 3:
            continue
        workflow_id, name, address = (part.strip() for part in parts[:3])
        if not address:
            continue
        if workflow_id:
            by_id[workflow_id] = address
        if name:
            by_name[name] = address
    return by_id, by_name


def resolve(binding: str, by_id: dict[str, str], by_name: dict[str, str]) -> str:
    """The dialplan number a binding names, or \"\" when it names none.

    The id is tried first: a workflow whose *name* is another's *id* would
    otherwise be resolved to the wrong number, and the stored form the Voice
    screen writes is the id.
    """
    value = (binding or "").strip()
    if not value:
        return ""
    return by_id.get(value) or by_name.get(value) or ""


def destination_of(address: str) -> str:
    """`<number>` -> `dograh-inbound,<number>,1`."""
    return f"{CONTEXT},{address},1"


def judge(
    bindings: dict[str, str],
    routes: dict[str, str],
    by_id: dict[str, str],
    by_name: dict[str, str],
) -> tuple[list[str], list[str], list[str]]:
    """(in_sync, drift, unresolved) as printable lines. Pure.

    `routes` is the live `incoming` table, keyed by normalised DID; the *stored*
    spelling is looked up again at write time, because that is the row a person
    sees and a `1`-prefixed `extension` is a different key to Asterisk.
    """
    in_sync, drift, unresolved = [], [], []
    for did, binding in sorted(bindings.items()):
        address = resolve(binding, by_id, by_name)
        if not address:
            unresolved.append(f"{did} -> binding {binding!r} names no workflow the engine has a number for")
            continue
        wanted = destination_of(address)
        current = routes.get(normalise_did(did))
        if current is None:
            unresolved.append(
                f"{did} -> no inbound route to repoint (a person adds the row in FreePBX; see pbx/dograh_routes.py)"
            )
        elif normalise_did_of_destination(current) != wanted:
            drift.append(f"{did} -> {current} (binding {binding!r} wants {wanted})")
        else:
            in_sync.append(f"{did} -> {wanted}")
    return in_sync, drift, unresolved


def normalise_did_of_destination(destination: str) -> str:
    """The destination as written, with whitespace trimmed — `incoming` rows are
    compared verbatim, so only trailing noise is ignored."""
    return (destination or "").strip()


# ── the live halves ─────────────────────────────────────────────────────────
def _run(args: list[str], timeout: float = 30.0) -> subprocess.CompletedProcess:
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout)


def read_dograh_numbers(container: str) -> str:
    """The engine's workflow -> number mapping, read out of its database."""
    proc = _run(
        ["docker", "exec", container, "psql", "-U", "postgres", "-tA", "-F",
         "\t", "-c", NUMBERS_QUERY]
    )
    if proc.returncode != 0:
        detail = proc.stderr.strip().splitlines()
        raise MappingError(
            f"the engine's database did not answer in {container}: "
            f"{detail[-1] if detail else proc.returncode}"
        )
    return proc.stdout


def portal_bindings(db_path: str) -> dict[str, str]:
    """{did: binding} from the portal's own record. Read-only.

    A missing table raises rather than returning an empty mapping: an unread
    portal reads as an estate with nothing bound, and the one answer worse than
    "cannot tell" is a clean report over a table never read.
    """
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        return {
            str(did).strip(): str(binding).strip()
            for did, binding in con.execute(BINDINGS_QUERY)
            if did and str(did).strip()
        }
    finally:
        con.close()


def apply_routes(container: str, updates: list[tuple[str, str]]) -> int:
    """Repoint each stored `extension` row. Returns the number written.

    Only the `destination` column is touched: the other fourteen are FreePBX's
    own defaults and this tool does not model them. The rows are found by their
    stored spelling, so a `1`-prefixed `extension` is the row that is written
    rather than a second one invented beside it.
    """
    if not updates:
        return 0
    statements = "".join(
        f"UPDATE incoming SET destination='{destination}' WHERE extension='{extension}';\n"
        for extension, destination in updates
    )
    pbx_db.mysql_exec(container, statements, stdin="")
    _run(["docker", "exec", container, "fwconsole", "reload"])
    return len(updates)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--db", help="the portal's SQLite database (pbx.db)")
    ap.add_argument("--numbers-tsv", help="a dumped workflow<TAB>name<TAB>number mapping")
    ap.add_argument("--incoming-tsv", help="a route table dumped by pbx/p0-snapshot.sh")
    ap.add_argument("--container", default=os.environ.get("PBX_CONTAINER", ""),
                    help="the FreePBX container to read and write (default: autodetect)")
    ap.add_argument("--dograh-container", default=DOGRAH_DB_CONTAINER,
                    help="the container holding Dograh's database (default: %(default)s)")
    ap.add_argument("--check", action="store_true", help="judge and exit 0/1/2")
    ap.add_argument("--apply", action="store_true",
                    help="write the rows an apply converges, then judge again")
    args = ap.parse_args(argv)

    if not args.db:
        print("dograh-bindings: no --db given — there is no binding to judge", file=sys.stderr)
        return 2
    if not os.path.exists(args.db):
        print(f"dograh-bindings: {args.db} does not exist — cannot tell", file=sys.stderr)
        return 2
    try:
        bindings = portal_bindings(args.db)
    except sqlite3.Error as exc:
        print(f"dograh-bindings: cannot read the bindings from {args.db}: {exc}", file=sys.stderr)
        return 2
    if not bindings:
        print(f"dograh-bindings: {args.db} binds no active DID — nothing to judge", file=sys.stderr)
        return 2

    if args.numbers_tsv:
        try:
            with open(args.numbers_tsv, encoding="utf-8") as handle:
                by_id, by_name = parse_numbers(handle.read())
        except OSError as exc:
            print(f"dograh-bindings: cannot read {args.numbers_tsv}: {exc}", file=sys.stderr)
            return 2
        mapping_source = args.numbers_tsv
    else:
        try:
            by_id, by_name = parse_numbers(read_dograh_numbers(args.dograh_container))
        except MappingError as exc:
            print(f"dograh-bindings: {exc} — cannot tell", file=sys.stderr)
            return 2
        mapping_source = args.dograh_container
    if not by_id and not by_name:
        print(
            f"dograh-bindings: {mapping_source} names no workflow number — cannot tell",
            file=sys.stderr,
        )
        return 2

    container = pbx_db.resolve_container(args.container)
    if not container and not args.incoming_tsv:
        print("dograh-bindings: no FreePBX container found — cannot tell", file=sys.stderr)
        return 2

    def read_routes() -> tuple[dict[str, str], str, dict[str, str]]:
        """(normalised routes, stored spelling by normalised DID, source)."""
        if args.incoming_tsv:
            with open(args.incoming_tsv, encoding="utf-8") as handle:
                text = handle.read()
            source = args.incoming_tsv
        else:
            text = pbx_db.mysql_exec(container, INCOMING_QUERY)
            source = container
        stored: dict[str, str] = {}
        for line in text.splitlines():
            if not line.strip():
                continue
            parts = line.rstrip("\n").split("\t")
            if len(parts) < 2:
                continue
            extension = parts[0].strip()
            if extension:
                stored.setdefault(normalise_did(extension), extension)
        return parse_incoming(text), stored, source

    try:
        routes, stored, route_source = read_routes()
    except (OSError, pbx_db.RouteError) as exc:
        print(f"dograh-bindings: {exc} — cannot tell", file=sys.stderr)
        return 2

    def report() -> tuple[list[str], list[str], list[str]]:
        in_sync, drift, unresolved = judge(bindings, routes, by_id, by_name)
        print(
            f"dograh-bindings: judged {len(bindings)} bound DID(s) against "
            f"{mapping_source} and {route_source}"
        )
        for line in in_sync:
            print(f"  in sync: {line}")
        for line in drift:
            print(f"  drift: {line}")
        for line in unresolved:
            print(f"  refuses: {line}", file=sys.stderr)
        return in_sync, drift, unresolved

    in_sync, drift, unresolved = report()

    if args.apply and drift and not args.incoming_tsv:
        updates = [
            (stored[normalise_did(did)], destination_of(resolve(bindings[did], by_id, by_name)))
            for did in sorted(bindings)
            if normalise_did(did) in stored
            and resolve(bindings[did], by_id, by_name)
            and normalise_did_of_destination(routes.get(normalise_did(did), ""))
            != destination_of(resolve(bindings[did], by_id, by_name))
        ]
        try:
            written = apply_routes(container, updates)
        except pbx_db.RouteError as exc:
            print(f"dograh-bindings: {exc} — nothing was written", file=sys.stderr)
            return 2
        print(f"dograh-bindings: wrote {written} route(s) and reloaded the dialplan")
        routes, stored, route_source = read_routes()
        in_sync, drift, unresolved = report()

    if drift or unresolved:
        print(
            f"dograh-bindings: {len(drift)} bound DID(s) off their binding and "
            f"{len(unresolved)} that cannot be resolved — a person adds the missing "
            f"row or fixes the binding",
            file=sys.stderr,
        )
        return 1
    print(f"dograh-bindings: every bound DID reaches the workflow its binding names ({len(in_sync)})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
