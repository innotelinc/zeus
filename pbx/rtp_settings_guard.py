#!/usr/bin/env python3
"""pbx/rtp_settings_guard.py — the RTP `[general]` rows FreePBX rewrites.

Why this exists
---------------
`fwconsole reload` regenerates `/etc/asterisk/rtp_additional.conf` from
`kvstore_Sipsettings`. Two rows do not survive that trip, and both fail
silently — the only symptom is that ICE/TURN never works and the log fills up.

1. FreePBX lower-cases the TURN credential.

   `Sipsettings.class.php::genConfig()` runs *every* RTP value through
   `strtolower()` before writing the file:

       $ssvars = ["rtpstart", ..., "turnusername", "turnpassword"];
       foreach ($ssvars as $v) {
           $retvar['rtp_additional.conf']['general'][$v] = strtolower((string) $res);
       }

   A TURN password is case-sensitive. The estate's credential is mixed-case and
   `coturn --user=` is given the true value, so Asterisk authenticated with the
   lower-cased copy and coturn answered

       ERROR user turnuser-... credentials are incorrect (check_stun_auth)

   once per call. Relay candidates for WebRTC peers were dead. Verified live on
   zeus (FreePBX 17.0.33): the generated file held `turnpassword=uiaf...` while
   `kvstore_Sipsettings` held `turnpassword=UIAf...`.

2. `stunaddr` pointed at this estate's coturn, which cannot answer it.

   Asterisk's STUN client (`main/stun.c`) speaks **RFC 3489** — its request has
   a 16-byte transaction id and *no* RFC 5389 magic cookie. coturn is RFC 5389
   and, as that RFC requires, silently drops a datagram that is not a STUN
   message. Nothing is logged server-side and no reply comes back, so the RTP
   engine retried 3x3s on *every call*:

       stun.c: Attempt 3 to send STUN request to '172.19.0.2' timed out.
       Check that the server address is correct and reachable.

   Verified live: a cookie-carrying probe to coturn was answered, a cookie-less
   one was ignored; `stun.l.google.com` answers *both* and returns
   MAPPED-ADDRESS (0x0001), which is the attribute the legacy client parses.
   coturn 4.18 does carry a deprecated `--rfc3489-compatibility`, but this
   estate runs it with `--no-stun` (an unauthenticated STUN endpoint on the WAN
   is a public reflector), so the STUN row has to point somewhere else — coturn
   stays the TURN server.

Contract
--------
The expected values are what the boot owner already knows: the environment
`docker-entrypoint-full.sh` exports. This tool is a converger, not a detector:
it reports drift (`--check`, exit 1) and rewrites the rows (`--apply`).

    --stun-addr      PJSIP_STUN_ADDR / STUN_ADDR, default stun.l.google.com:19302
    --turn-username  TURN_USERNAME
    --turn-password  TURN_CREDENTIAL

A key whose expected value is empty is left alone: an estate that wants no STUN
discovery (or no TURN) is a legitimate configuration, and this tool must not
invent one. Rows are matched inside `[general]` only, and a value may carry a
trailing `; comment`.

Usage:
  python3 pbx/rtp_settings_guard.py --check
  python3 pbx/rtp_settings_guard.py --apply
  python3 pbx/rtp_settings_guard.py --rtp-conf <file> --stun-addr <host:port> \\
      --turn-username U --turn-password P --apply

Exit codes follow `pbx/media_address.py`: 0 in sync, 1 drift (an apply converges
it), 2 cannot tell (no expectation, or the target file is missing).
"""
from __future__ import annotations

import argparse
import os
import re
import sys

SECTION_RE = re.compile(r"^\s*\[([^\]]+)\]\s*(?:[;#].*)?$")
LINE_RE = re.compile(r"^(\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*)=(\s*)(.*)$")

DEFAULT_STUN_ADDR = "stun.l.google.com:19302"

#: key -> the flag/env it is expected to come from (order is stable for output).
GUARDED = ("stunaddr", "turnusername", "turnpassword")


def _bare(value: str) -> str:
    """The value with any trailing `; comment` removed."""
    return value.split(";", 1)[0].strip()


def read_lines(path: str) -> list[str]:
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        return fh.read().splitlines(True)


def general_rows(lines: list[str], key: str) -> list[int]:
    """Indices of `key = value` rows declared inside `[general]`."""
    in_general = False
    rows: list[int] = []
    for i, line in enumerate(lines):
        section = SECTION_RE.match(line)
        if section:
            in_general = section.group(1).strip().lower() == "general"
            continue
        if not in_general:
            continue
        match = LINE_RE.match(line.rstrip("\n"))
        if match and match.group(2).lower() == key:
            rows.append(i)
    return rows


def general_start(lines: list[str]) -> int | None:
    """Index of the `[general]` header, or None."""
    for i, line in enumerate(lines):
        section = SECTION_RE.match(line)
        if section and section.group(1).strip().lower() == "general":
            return i
    return None


def evaluate(lines: list[str], expected: dict[str, str]):
    """Return (drift, lines) describing every guarded row that disagrees."""
    drift: list[str] = []
    for key in GUARDED:
        want = expected.get(key, "")
        if not want:
            continue
        rows = general_rows(lines, key)
        if not rows:
            drift.append("%s is absent (want %s)" % (key, want))
            continue
        if len(rows) > 1:
            drift.append("%s is declared %d times in [general]; only the first wins"
                         % (key, len(rows)))
        got = _bare(LINE_RE.match(lines[rows[0]].rstrip("\n")).group(5))
        if got == want:
            continue
        if got.lower() == want.lower():
            drift.append("%s=%s was lower-cased by FreePBX (want %s)" % (key, got, want))
        else:
            drift.append("%s=%s disagrees with the configured value (want %s)" % (key, got, want))
    return drift


def apply_changes(lines: list[str], expected: dict[str, str]):
    """Rewrite drifted rows in place. Returns (lines, changes).

    Only the first declaration of a key is read by Asterisk, so a duplicated row
    is dropped rather than left to shadow the one this tool just set.
    """
    out = list(lines)
    changes: list[str] = []
    dedupe: list[str] = []
    for key in GUARDED:
        want = expected.get(key, "")
        if not want:
            continue
        rows = general_rows(out, key)
        if not rows:
            header = general_start(out)
            if header is None:
                continue
            out.insert(header + 1, "%s=%s\n" % (key, want))
            changes.append("added %s=%s" % (key, want))
            continue
        if len(rows) > 1:
            dedupe.append(key)
        first = rows[0]
        match = LINE_RE.match(out[first].rstrip("\n"))
        if _bare(match.group(5)) != want:
            out[first] = "%s%s=%s\n" % (match.group(1), match.group(2), want)
            changes.append("set %s=%s" % (key, want))
    for key in dedupe:
        rows = general_rows(out, key)
        for index in sorted(rows[1:], reverse=True):
            del out[index]
            changes.append("dropped a duplicate %s row" % key)
    return out, changes


def resolve_expected(args) -> dict[str, str]:
    """The values the rows should hold.

    An *explicitly empty* `--stun-addr ''` means "do not guard STUN" (an estate
    may legitimately run without discovery); omitting the flag falls back to the
    environment and then to the built-in legacy-compatible default.
    """
    if args.stun_addr is not None:
        stun = args.stun_addr
    else:
        stun = (os.environ.get("PJSIP_STUN_ADDR")
                or os.environ.get("STUN_ADDR")
                or DEFAULT_STUN_ADDR)
    return {
        "stunaddr": stun,
        "turnusername": args.turn_username or os.environ.get("TURN_USERNAME", ""),
        "turnpassword": args.turn_password or os.environ.get("TURN_CREDENTIAL", ""),
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--rtp-conf", default="/etc/asterisk/rtp_additional.conf",
                        help="generated RTP config to guard "
                             "(default: /etc/asterisk/rtp_additional.conf)")
    parser.add_argument("--stun-addr",
                        help="STUN discovery server, host[:port] "
                             "(default: $PJSIP_STUN_ADDR, else %s)" % DEFAULT_STUN_ADDR)
    parser.add_argument("--turn-username", help="TURN username (default: $TURN_USERNAME)")
    parser.add_argument("--turn-password", help="TURN password (default: $TURN_CREDENTIAL)")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true",
                      help="report drift and exit 1 (default)")
    mode.add_argument("--apply", action="store_true",
                      help="rewrite the drifted rows in place")
    parser.add_argument("-q", "--quiet", action="store_true",
                        help="print nothing when in sync")
    args = parser.parse_args(argv)

    expected = resolve_expected(args)
    if not any(expected.values()):
        print("rtp-settings-guard: nothing configured to guard", file=sys.stderr)
        return 2

    if not os.path.isfile(args.rtp_conf):
        print("rtp-settings-guard: no such file: %s" % args.rtp_conf, file=sys.stderr)
        return 2

    lines = read_lines(args.rtp_conf)

    if args.apply:
        lines, changes = apply_changes(lines, expected)
        if changes:
            with open(args.rtp_conf, "w", encoding="utf-8") as fh:
                fh.write("".join(lines))
        if changes and not args.quiet:
            for change in changes:
                print("rtp-settings-guard: %s" % change, file=sys.stderr)
        remaining = evaluate(lines, expected)
        return 1 if remaining else 0

    drift = evaluate(lines, expected)
    if drift and not args.quiet:
        for finding in drift:
            print("rtp-settings-guard: %s" % finding, file=sys.stderr)
    if not drift and not args.quiet:
        print("rtp-settings-guard: %s in sync" % args.rtp_conf, file=sys.stderr)
    return 1 if drift else 0


if __name__ == "__main__":
    sys.exit(main())
