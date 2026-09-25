#!/usr/bin/env python3
"""pbx/pbx_db.py — the container + MySQL plumbing every PBX table tool shares.

`pbx/provision_extension.py` and `pbx/dograh_routes.py` both read and write
FreePBX's own tables through the running `zeus-freepbx` container's mysql
client. That surface is deliberately small and uninteresting — run a statement,
parse the tab-separated output, fail loudly when the container is not the PBX we
think it is — and it used to live inside `pbx/ava_routes.py`. It is here instead
so neither tool has to import the other, and so "which container" has exactly one
answer on this estate.

Nothing here knows what a DID or an extension is: the callers own their own
tables, judgement and exit codes.
"""
from __future__ import annotations

import subprocess

# The containers that can hold this estate's FreePBX, most specific first.
PBX_CANDIDATES = ("zeus-freepbx", "freepbx")

# `-N` drops the column header, `-B` makes the output tab-separated: both are
# load-bearing for the parsers, which split on tabs and skip a non-numeric row.
MYSQL_ARGS = ("mysql", "-N", "-B", "-u", "root", "asterisk")


class RouteError(RuntimeError):
    """A PBX table that cannot be read or written.

    Named for the surface it was first used on and kept for its callers: it means
    "this tool could not get a trustworthy answer from the PBX", which is a
    refusal to judge rather than a verdict about the estate.
    """


def _run(args: list[str], stdin: str | None = None,
         timeout: float = 30.0) -> subprocess.CompletedProcess:
    return subprocess.run(args, capture_output=True, text=True, input=stdin, timeout=timeout)


def running_container(name: str) -> bool:
    proc = _run(["docker", "ps", "--format", "{{.Names}}"])
    return proc.returncode == 0 and name in proc.stdout.split()


def resolve_container(explicit: str,
                      candidates: tuple[str, ...] = PBX_CANDIDATES) -> str:
    """The PBX container to read or write, or "".

    An explicit `--container`/`PBX_CONTAINER` WINS and is not a candidate among
    the defaults: naming a container that is not running must surface as "no
    PBX", never as the other product's PBX. Both products can be present at once
    (a hand-off leaves the old container stopped, not deleted), and editing the
    wrong one's rows sends live calls to the wrong place.
    """
    if explicit:
        return explicit if running_container(explicit) else ""
    for name in candidates:
        if running_container(name):
            return name
    return ""


def mysql_exec(container: str, sql: str, stdin: str | None = None) -> str:
    """Run SQL against the PBX's `asterisk` database, tab-parsed (`-N -B`).

    `stdin` feeds a script through the client instead of `-e`, for the multi-
    statement applies that write a revert file first.
    """
    args = ["docker", "exec"]
    if stdin is not None:
        args.append("-i")
    args += [container, *MYSQL_ARGS, "-e", sql]
    proc = _run(args, stdin=stdin)
    if proc.returncode != 0:
        detail = proc.stderr.strip().splitlines()
        raise RouteError(
            f"the PBX database did not answer in {container}: "
            f"{detail[-1] if detail else proc.returncode}"
        )
    return proc.stdout
