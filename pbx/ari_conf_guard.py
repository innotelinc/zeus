#!/usr/bin/env python3
"""pbx/ari_conf_guard.py — Asterisk ARI `[general]` integrity guard.

Why this exists
---------------
Zeus converges its ARI user into the file Asterisk actually reads
(`/etc/asterisk/ari.conf`) while `[general]` is expected to *pass through*.
On the FreePBX builds the estate ships, `[general]` is what pulls in the
module-managed include fragments:

    #include ari_general_additional.conf
    #include ari_general_custom.conf
    #include ari_additional.conf
    #include ari_additional_custom.conf

FreePBX's own `ari_dedup`/`fwconsole ma` maintenance rewrote that file once and
dropped the whole `[general]` block. Nothing else noticed: the file still
contained the `[pbxportal]` section, so a naive "is our user present?" check
passed — yet `ari_additional_custom.conf` (where Capstone's `[dograh]` user
lives) was no longer included, `/ari/asterisk/info` started returning 404, and
the only symptom was calls that were never answered.

This guard asserts the *include plumbing* survives. It is a plain detector: it
reports drift (exit 1) and never edits the file.

Contract
--------
The guard only speaks up for a PBX that actually ships the FreePBX include
fragments. If none of the known `ari_*` siblings exist the file is either a
hand-rolled/scratch `ari.conf` or a build that does not use them, and the
guard stays silent (exit 0) so it cannot manufacture false drift.

    * if any known include fragment exists next to ari.conf, then
      - ari.conf must exist and declare a `[general]` section;
      - every existing fragment must be reachable via a `#include`;
      - `[general]` must not set `enabled = no`.

Usage:
  ari_conf_guard.py --ari-conf /etc/asterisk/ari.conf
  ari_conf_guard.py --ari-conf <file> --asterisk-dir <dir> [--require-include NAME]...
  ari_conf_guard.py --ari-conf <file> --check     # exit 1 on drift (default behaviour)

Exit codes: 0 in sync, 1 drift, 2 usage/IO error.
"""
from __future__ import annotations

import argparse
import os
import re
import sys

# The FreePBX-generated fragments ari.conf's [general] block is expected to
# consume. Order is stable so the output reads the same on every run.
KNOWN_FRAGMENTS = (
    "ari_general_additional.conf",
    "ari_general_custom.conf",
    "ari_additional.conf",
    "ari_additional_custom.conf",
)

SECTION_RE = re.compile(r"^\s*\[([^\]]+)\]\s*(?:[;#].*)?$")
INCLUDE_RE = re.compile(r"^\s*#\s*include\s+(\S+)")


def parse(text: str):
    """Return (has_general, general_enabled, includes).

    ``includes`` is the set of every ``#include`` target in the file: an
    include is processed wherever it appears, but FreePBX keeps them under
    ``[general]``, so accepting any position avoids a false positive if a
    hand-edit moves one.
    """
    section = None
    general_seen = False
    general_enabled = None
    includes: set[str] = set()
    for line in text.splitlines():
        m = SECTION_RE.match(line)
        if m:
            section = m.group(1)
            if section == "general":
                general_seen = True
            continue
        inc = INCLUDE_RE.match(line)
        if inc:
            includes.add(inc.group(1))
            continue
        if section == "general":
            key, _, value = line.partition("=")
            if key.strip().lower() == "enabled":
                general_enabled = value.split(";", 1)[0].split("#", 1)[0].strip().lower()
    return general_seen, general_enabled, includes


def evaluate(ari_conf: str, asterisk_dir: str, require_includes=None):
    """Return (ok, lines) where lines are human-readable findings."""
    lines: list[str] = []

    if require_includes:
        fragments = [f for f in require_includes]
    else:
        fragments = [f for f in KNOWN_FRAGMENTS
                     if os.path.isfile(os.path.join(asterisk_dir, f))]

    if not fragments:
        lines.append("no FreePBX ARI include fragments next to ari.conf — nothing to guard")
        return True, lines

    if not os.path.isfile(ari_conf):
        lines.append("ari.conf is missing but include fragments exist "
                     "(%s) — ARI users will not load" % ", ".join(fragments))
        return False, lines

    try:
        with open(ari_conf, "r", encoding="utf-8", errors="replace") as fh:
            text = fh.read()
    except OSError as exc:  # pragma: no cover - surfaced as a usage error
        raise SystemExit("ari-conf-guard: cannot read %s: %s" % (ari_conf, exc))

    has_general, enabled, includes = parse(text)
    ok = True

    if not has_general:
        lines.append("ari.conf has no [general] section — the include block was "
                     "clobbered (ARI users in the fragments will not load)")
        ok = False
    if enabled == "no":
        lines.append("[general] sets enabled = no — ARI is disabled")
        ok = False

    for frag in fragments:
        if frag not in includes:
            lines.append("ari.conf does not #include %s (expected in [general])" % frag)
            ok = False

    if ok:
        lines.append("ari.conf [general] include block intact (consumes %s)"
                     % ", ".join(fragments))
    return ok, lines


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--ari-conf", default="/etc/asterisk/ari.conf",
                    help="path to ari.conf (default: /etc/asterisk/ari.conf)")
    ap.add_argument("--asterisk-dir",
                    help="directory holding the ari_* fragments "
                         "(default: the directory containing --ari-conf)")
    ap.add_argument("--require-include", action="append", default=[],
                    metavar="NAME",
                    help="fragment that MUST be included, even if absent on disk "
                         "(repeatable; default: every known fragment present)")
    ap.add_argument("-q", "--quiet", action="store_true",
                    help="print nothing when in sync (findings always print)")
    args = ap.parse_args(argv)

    ari_conf = args.ari_conf
    asterisk_dir = args.asterisk_dir or os.path.dirname(os.path.abspath(ari_conf))
    if not os.path.isdir(asterisk_dir):
        print("ari-conf-guard: no such directory: %s" % asterisk_dir, file=sys.stderr)
        return 2

    ok, findings = evaluate(ari_conf, asterisk_dir,
                            require_includes=args.require_include or None)
    if not (ok and args.quiet):
        for line in findings:
            print("ari-conf-guard: %s" % line, file=sys.stderr)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
