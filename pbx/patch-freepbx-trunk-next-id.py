#!/usr/bin/env python3
"""patch-freepbx-trunk-next-id.py — fix FreePBX's trunk id picker and PJSIP write.

Two independent bugs in FreePBX's Core module both surface as the same
symptom — saving a trunk dies with

    SQLSTATE[23000]: Integrity constraint violation: 1062 Duplicate entry
    '1-maxchans' for key 'PRIMARY'

raised from the INSERT loop in ``PJSip::addTrunk()``. Fixing only one leaves
the other reachable, so they are installed together.

HUNK 1 — trunk-next-id (Core.class.php, ``Core::addTrunk``)
    The id for a NEW trunk came from a sorted scan against a counter starting
    at 1::

        $trunknum = 1;
        foreach ($trunk_hash as $trunk_id) {
            if ($trunk_id != $trunknum) { break; }
            $trunknum++;
        }

    That only holds when ids start at 1. This estate has a trunk with id **0**
    (the "custom" VoIP.ms trunk), and the loop breaks on its first iteration
    because 0 != 1 — so every new trunk is given id 1 whatever already holds
    it. ``Core::addTrunk`` then writes the metadata with ``REPLACE INTO``
    (silently replacing trunk 1's row) and the technology rows with a plain
    ``INSERT``, which collides with the rows already stored under that id.

    The fix replaces the loop with a set-membership scan over the positive
    ids, so the next free id is genuinely free.

HUNK 2 — pjsip-write-idempotent (functions.inc/drivers/PJSip.class.php)
    ``PJSip::addTrunk($trunknum, $settings)`` is a complete settings write —
    one INSERT per keyword — but it never clears what is already there. The
    caller only deletes first on the edit path, and even then only for the
    technology recorded in ``trunks.tech`` (see ``Core::deleteTrunk``). So a
    trunk whose recorded technology disagrees with the rows actually present
    — the usual outcome of switching a trunk from SIP to IAX, which leaves the
    old technology's rows behind — collides on every save. Since the function
    is handed the trunk's full settings, clearing the id first restores the
    semantics it already assumes.

Applied in-image (not in the repo's PHP) because FreePBX ships inside the PBX
image; run it after any image update, or from the entrypoint to self-heal:

    docker exec zeus-freepbx python3 /tmp/patch-freepbx-trunk-next-id.py --check
    docker cp patch-freepbx-trunk-next-id.py zeus-freepbx:/tmp/ && \\
      docker exec zeus-freepbx python3 /tmp/patch-freepbx-trunk-next-id.py

Preferred on a containerised stack: have it copy itself in, run there, and pull
the backups back out — the container's own filesystem is disposable, so a
backup left inside it does not survive the image refresh that made it useful:

    pbx/patch-freepbx-trunk-next-id.py --container zeus-freepbx --check
    pbx/patch-freepbx-trunk-next-id.py --container zeus-freepbx

The pure functions are unit-tested without a PBX (pbx/tests).
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import time

MODULES = "/var/www/html/admin/modules/core"
CORE_FILE = f"{MODULES}/Core.class.php"
PJSIP_FILE = f"{MODULES}/functions.inc/drivers/PJSip.class.php"

# ── hunk 1: trunk next id ──────────────────────────────────────────────────

NEXT_ID_ORIGINAL = """\t\t\t$trunknum = 1;
\t\t\tforeach ($trunk_hash as $trunk_id) {
\t\t\t\tif ($trunk_id != $trunknum) {
\t\t\t\t\tbreak;
\t\t\t\t}
\t\t\t\t$trunknum++;
\t\t\t}
"""

NEXT_ID_PATCHED = """\t\t\t// Next free id >= 1. The shipped scan compared sorted ids against a
\t\t\t// counter starting at 1, so a trunk with id 0 broke the loop on its
\t\t\t// first iteration and every new trunk was given id 1 — colliding with
\t\t\t// whatever already held it (and silently REPLACE-ing its metadata).
\t\t\t$used = array();
\t\t\tforeach ($trunk_hash as $trunk_id) {
\t\t\t\t$trunk_id = (int) $trunk_id;
\t\t\t\tif ($trunk_id > 0) {
\t\t\t\t\t$used[$trunk_id] = true;
\t\t\t\t}
\t\t\t}
\t\t\t$trunknum = 1;
\t\t\twhile (isset($used[$trunknum])) {
\t\t\t\t$trunknum++;
\t\t\t}
"""

NEXT_ID_MARKER = "while (isset($used[$trunknum]))"

# ── hunk 2: idempotent pjsip write ─────────────────────────────────────────

PJSIP_ORIGINAL = """\t\t$ins = $this->db->prepare("INSERT INTO `pjsip` (`id`, `keyword`, `data`, `flags`) VALUES ( $trunknum, :keyword, :data, 0 )");
\t\tforeach ($settings as $k => $v) {
"""

PJSIP_PATCHED = """\t\t// Clear this trunk's rows first: the settings below are the trunk's
\t\t// complete configuration, and the caller only deletes for the technology
\t\t// recorded in `trunks` — so a trunk whose stored tech disagrees with the
\t\t// rows actually present (a tech switch leaves the old ones behind) would
\t\t// otherwise collide here with 1062 Duplicate entry for key PRIMARY.
\t\t$del = $this->db->prepare("DELETE FROM `pjsip` WHERE `id` = :trunknum");
\t\t$del->execute(array(':trunknum' => $trunknum));
\t\t$ins = $this->db->prepare("INSERT INTO `pjsip` (`id`, `keyword`, `data`, `flags`) VALUES ( $trunknum, :keyword, :data, 0 )");
\t\tforeach ($settings as $k => $v) {
"""

PJSIP_MARKER = "DELETE FROM `pjsip` WHERE `id` = :trunknum"

# ── running inside a container ─────────────────────────────────────────────
# The files being patched only exist inside the PBX container, so on a
# containerised stack the patcher has to act there. It is shipped into the
# image (Dockerfile.full copies it to /usr/local/bin and the entrypoint runs
# it on every boot), but a DEPLOYED image that predates that copy has no
# patcher at all — and its entrypoint silently skips the repair, leaving the
# bug live with nothing to re-apply it. This mode is the way back in from the
# host: no image rebuild, no hand-typed docker cp.
CONTAINER_SCRIPT = "/tmp/patch-freepbx-trunk-next-id.py"
DEFAULT_BACKUP_DIR = "/root/trunk-repair"


def container_commands(
    container: str, script_path: str, inner_args: list[str], host_backup_dir: str
) -> list[list[str]]:
    """The docker commands that apply this patch inside `container`.

    Pure, so the wiring is testable without a Docker daemon: the first two must
    succeed, the third (pulling backups out) is best-effort because a run that
    changed nothing has nothing to pull.
    """
    remote = f"{container}:{CONTAINER_SCRIPT}"
    return [
        ["docker", "cp", script_path, remote],
        ["docker", "exec", container, "python3", CONTAINER_SCRIPT, *inner_args],
        # `/.` copies the contents, so the host dir is created if absent and
        # existing backups are not nested one level deeper on every run.
        ["docker", "cp", f"{container}:{DEFAULT_BACKUP_DIR}/.", host_backup_dir],
    ]


def run_in_container(args) -> int:
    """Apply inside `args.container`; returns the inner run's exit code."""
    inner = ["--backup-dir", DEFAULT_BACKUP_DIR]
    if args.check:
        inner.append("--check")
    for name in args.hunk or []:
        inner += ["--hunk", name]

    host_backup = os.path.abspath(os.path.expanduser(args.host_backup_dir))
    steps = container_commands(
        args.container, os.path.abspath(__file__), inner, host_backup
    )

    rc = subprocess.call(steps[0])
    if rc != 0:
        print(f"patch-freepbx-trunk-next-id: cannot place the patcher in "
              f"{args.container} (rc={rc})", file=sys.stderr)
        return 2

    rc = subprocess.call(steps[1])

    os.makedirs(host_backup, exist_ok=True)
    if subprocess.call(steps[2], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) == 0:
        print(f"patch-freepbx-trunk-next-id: backups pulled to {host_backup}")
    return rc


HUNKS = (
    {
        "name": "trunk-next-id",
        "file": CORE_FILE,
        "marker": NEXT_ID_MARKER,
        "original": NEXT_ID_ORIGINAL,
        "patched": NEXT_ID_PATCHED,
        "what": "next free trunk id in Core::addTrunk",
    },
    {
        "name": "pjsip-write-idempotent",
        "file": PJSIP_FILE,
        "marker": PJSIP_MARKER,
        "original": PJSIP_ORIGINAL,
        "patched": PJSIP_PATCHED,
        "what": "clear-then-insert in PJSip::addTrunk",
    },
)


class PatchError(RuntimeError):
    """The target file is not in a state this patch understands."""


def next_trunk_id(existing_ids) -> int:
    """The semantics hunk 1 installs: lowest free id >= 1.

    Mirrors the patched PHP so the behaviour can be tested without a PBX.
    """
    used = {int(i) for i in existing_ids if int(i) > 0}
    candidate = 1
    while candidate in used:
        candidate += 1
    return candidate


def is_applied(hunk: dict, source: str) -> bool:
    return hunk["marker"] in source


def apply_hunk(hunk: dict, source: str) -> str:
    """Return the patched source, or raise if the expected block is absent."""
    if is_applied(hunk, source):
        return source
    if hunk["original"] not in source:
        raise PatchError(
            f"{hunk['name']}: expected block not found in this version of "
            f"{os.path.basename(hunk['file'])} — refusing to guess"
        )
    return source.replace(hunk["original"], hunk["patched"], 1)


def _read(path: str) -> str:
    with open(path, "r", encoding="utf-8", errors="surrogateescape") as fh:
        return fh.read()


def _write(path: str, text: str, backup_dir: str) -> None:
    os.makedirs(backup_dir, exist_ok=True)
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    base = os.path.basename(path)
    shutil.copy2(path, os.path.join(backup_dir, f"{base}.pre-next-id-{stamp}"))
    with open(path, "w", encoding="utf-8", errors="surrogateescape") as fh:
        fh.write(text)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="report, do not write")
    parser.add_argument("--hunk", choices=[h["name"] for h in HUNKS], action="append",
                        help="restrict to one hunk (repeatable; default: all)")
    parser.add_argument("--file", help="single-file mode: patch this file with --hunk")
    parser.add_argument("--backup-dir", default=DEFAULT_BACKUP_DIR)
    parser.add_argument("--container", metavar="NAME",
                        help="run the patch inside this PBX container (copies "
                             "itself in, runs, pulls backups back out)")
    parser.add_argument("--host-backup-dir", default=DEFAULT_BACKUP_DIR,
                        help="host directory to pull container backups into "
                             "(with --container)")
    args = parser.parse_args(argv)

    if args.container:
        return run_in_container(args)

    selected = [h for h in HUNKS if not args.hunk or h["name"] in args.hunk]
    if args.file:
        if len(selected) != 1:
            print("patch-freepbx-trunk-next-id: --file needs exactly one --hunk", file=sys.stderr)
            return 2
        selected = [dict(selected[0], file=args.file)]

    drift = 0
    for hunk in selected:
        try:
            source = _read(hunk["file"])
        except OSError as exc:
            print(f"patch-freepbx-trunk-next-id: cannot read {hunk['file']}: {exc}", file=sys.stderr)
            return 2

        if is_applied(hunk, source):
            print(f"patch-freepbx-trunk-next-id: {hunk['name']}: already applied")
            continue
        try:
            patched = apply_hunk(hunk, source)
        except PatchError as exc:
            print(f"patch-freepbx-trunk-next-id: {exc}", file=sys.stderr)
            return 1

        if args.check:
            print(f"patch-freepbx-trunk-next-id: {hunk['name']}: NOT applied (drift)")
            drift = 1
            continue
        try:
            _write(hunk["file"], patched, args.backup_dir)
        except OSError as exc:
            print(f"patch-freepbx-trunk-next-id: backup/write failed, not patched: {exc}",
                  file=sys.stderr)
            return 2
        print(f"patch-freepbx-trunk-next-id: {hunk['name']}: applied ({hunk['what']})")

    return drift


if __name__ == "__main__":
    raise SystemExit(main())
