#!/usr/bin/env python3
"""pbx/sms_message_context.py — where an inbound SIP MESSAGE is routed.

`[sms-in]` and `[sms-out]` are the dialplan (pbx/asterisk/extensions_sms_custom.conf
converged into the shared extensions_custom.conf). A context is only reachable if
Asterisk is told to put the MESSAGE in it, and on this Asterisk (22.11.0) the way
to say so is **`message_context` on the trunk endpoint** — not the legacy
`[general]` block `scripts/setup.sh` wrote on bare metal:

    [general]
    accept_outofcall_message=yes
    outofcall_message_context=sms-in
    auth_message_requests=no

Measured on the live box, that block is inert. Neither `res_pjsip.so` nor
`res_pjsip_messaging.so` carries the strings `accept_outofcall_message`,
`outofcall_message_context` or `auth_message_requests`; the only MESSAGE option
either module defines is `message_context`, and `config show help res_pjsip`
lists no `general` section to put them in. FreePBX agrees: its PJSIP trunk editor
offers a single "Message Context" field, and `Pjsip.class.php` writes it as
`message_context=` on the endpoint. So an estate with the `[general]` block set
and no `message_context` accepts the text and drops it — the same silence as no
dialplan, one layer up.

This tool converges that field. It reads the trunk's `trunkid` from FreePBX's
`trunks` table and sets the matching `pjsip.message_context` row, which is what
`fwconsole reload` renders into `pjsip.endpoint.conf` and what `pjsip show
endpoint <trunk>` then reports. It does not touch the endpoint file: FreePBX owns
that, and a hand edit would be regenerated away on the next reload.

    # judge, write nothing (0 in sync, 1 an apply converges it, 2 cannot tell)
    python3 pbx/sms_message_context.py --check

    # the live PBX from the host (talks to the container's MySQL)
    python3 pbx/sms_message_context.py --apply

    # inside the container, or on bare metal: the local MySQL
    python3 pbx/sms_message_context.py --apply --local

Only runs when a trunk is named; with no such trunk the tool has nowhere to
point a MESSAGE and says so (exit 2) rather than inventing an endpoint. Exit
codes follow `pbx/media_address.py`: 1 means an apply converges the estate, 2
means the question could not be answered — never a pass.
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
from dataclasses import dataclass

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pbx_db  # noqa: E402

# The trunk inbound MESSAGES arrive on, and the context they belong in.
DEFAULT_TRUNK = "voipms_pjsip"
DEFAULT_CONTEXT = "sms-in"
# FreePBX stores per-trunk pjsip settings as rows in this table, keyed by trunkid.
KEYWORD = "message_context"


@dataclass(frozen=True)
class Finding:
    state: str
    detail: str
    repair: str


def quote(value: str) -> str:
    """A single-quoted MySQL string. Doubling the quote is the whole escape."""
    return "'" + value.replace("\\", "\\\\").replace("'", "''") + "'"


def parse_trunk_id(text: str) -> int | None:
    """The first numeric cell, or None when the trunk is not on this PBX."""
    for line in text.splitlines():
        token = line.strip()
        if token.isdigit():
            return int(token)
    return None


def parse_setting(text: str) -> str | None:
    """The current `message_context` value, or None when there is no such row.

    `mysql -N -B` renders a row as `id<TAB>data`, so an empty data column is a
    row that exists with no value — distinct from a row that is absent, which is
    what decides between an UPDATE and an INSERT.
    """
    for line in text.splitlines():
        parts = line.split("\t")
        if len(parts) >= 2 and parts[0].strip().isdigit():
            return parts[1].strip()
    return None


def judge(trunk: str, trunk_id: int, current: str | None, wanted: str) -> list[Finding]:
    """What is wrong with this trunk's inbound-MESSAGE routing, if anything."""
    if current == wanted and current:
        return []
    if current is None:
        return [Finding(
            state="unset",
            detail=f"PJSIP trunk {trunk!r} (id {trunk_id}) has no message_context, "
                   "so an inbound MESSAGE is accepted and dropped — no context "
                   "ever runs and nothing reaches a softphone or the sms-in dialplan",
            repair=f"apply: set message_context={wanted} on the trunk",
        )]
    if not current:
        return [Finding(
            state="empty",
            detail=f"PJSIP trunk {trunk!r} (id {trunk_id}) has an empty "
                   "message_context, which routes nothing",
            repair=f"apply: set message_context={wanted} on the trunk",
        )]
    return [Finding(
        state="wrong-context",
        detail=f"PJSIP trunk {trunk!r} (id {trunk_id}) routes inbound MESSAGEs "
               f"to {current!r}, not {wanted!r}",
        repair=f"apply: set message_context={wanted} on the trunk",
    )]


def render_apply_sql(trunk_id: int, wanted: str, exists: bool) -> str:
    """The single statement that converges the setting."""
    if exists:
        return (
            f"UPDATE pjsip SET data={quote(wanted)} "
            f"WHERE id={trunk_id} AND keyword={quote(KEYWORD)};"
        )
    return (
        "INSERT INTO pjsip (id, keyword, data, flags) "
        f"VALUES ({trunk_id}, {quote(KEYWORD)}, {quote(wanted)}, 0);"
    )


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


def read_trunk_id(*, local: bool, container: str, trunk: str) -> int | None:
    return parse_trunk_id(mysql(
        f"SELECT trunkid FROM trunks WHERE name = {quote(trunk)} "
        "ORDER BY trunkid LIMIT 1",
        local=local, container=container,
    ))


def read_setting(*, local: bool, container: str, trunk_id: int) -> str | None:
    return parse_setting(mysql(
        f"SELECT id, data FROM pjsip WHERE id = {trunk_id} AND keyword = {quote(KEYWORD)}",
        local=local, container=container,
    ))


def reload_pbx(*, local: bool, container: str) -> None:
    args = ["fwconsole", "reload"] if local else ["docker", "exec", container, "fwconsole", "reload"]
    try:
        subprocess.run(args, capture_output=True, text=True, timeout=300)
    except (OSError, subprocess.SubprocessError):
        pass


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--trunk",
        default=os.environ.get("VOIPMS_TRUNK_NAME", "").strip() or DEFAULT_TRUNK,
        help=f"the PJSIP trunk inbound MESSAGEs arrive on (default: {DEFAULT_TRUNK})",
    )
    parser.add_argument(
        "--context",
        default=os.environ.get("SMS_IN_CONTEXT", "").strip() or DEFAULT_CONTEXT,
        help=f"the context an inbound MESSAGE belongs in (default: {DEFAULT_CONTEXT})",
    )
    parser.add_argument("--container", default=os.environ.get("PBX_CONTAINER", ""),
                        help="the FreePBX container to read (default: autodetect)")
    parser.add_argument("--local", action="store_true",
                        help="talk to the local MySQL (inside the container or bare metal)")
    parser.add_argument("--apply", action="store_true",
                        help="write the setting (default: judge only)")
    parser.add_argument("--check", action="store_true",
                        help="judge and exit 0/1/2 (the default; writes nothing)")
    args = parser.parse_args(argv)

    local = args.local
    container = ""
    if not local:
        container = pbx_db.resolve_container(args.container)
        if not container:
            print("sms-message-context: no FreePBX container found — cannot tell", file=sys.stderr)
            return 2

    try:
        trunk_id = read_trunk_id(local=local, container=container, trunk=args.trunk)
    except pbx_db.RouteError as exc:
        print(f"sms-message-context: {exc} — cannot tell", file=sys.stderr)
        return 2

    if trunk_id is None:
        print(
            f"sms-message-context: no trunk named {args.trunk!r} on the PBX — there "
            "is nothing to point a MESSAGE at, so nothing is written",
            file=sys.stderr,
        )
        return 2

    try:
        current = read_setting(local=local, container=container, trunk_id=trunk_id)
    except pbx_db.RouteError as exc:
        print(f"sms-message-context: {exc} — cannot tell", file=sys.stderr)
        return 2

    where = "the local PBX" if local else container
    findings = judge(args.trunk, trunk_id, current, args.context)
    print(f"sms-message-context: trunk {args.trunk} (id {trunk_id}) on {where}, "
          f"message_context={current!r}")
    for finding in findings:
        print(f"  {finding.state}: {finding.detail}", file=sys.stderr)
        print(f"    repair: {finding.repair}", file=sys.stderr)
    if not findings:
        print(f"sms-message-context: an inbound MESSAGE on {args.trunk} is routed "
              f"to [{args.context}]")
        return 0

    if not args.apply:
        print(f"sms-message-context: {len(findings)} finding(s) — re-run with "
              "--apply to converge the setting", file=sys.stderr)
        return 1

    try:
        mysql(render_apply_sql(trunk_id, args.context, current is not None),
              local=local, container=container)
    except pbx_db.RouteError as exc:
        print(f"sms-message-context: {exc} — the setting was not converged", file=sys.stderr)
        return 2
    reload_pbx(local=local, container=container)

    # The read-back is the PBX's answer after the reload, not the write we made.
    try:
        current = read_setting(local=local, container=container, trunk_id=trunk_id)
    except pbx_db.RouteError as exc:
        print(f"sms-message-context: {exc} — written but not verified", file=sys.stderr)
        return 2
    if judge(args.trunk, trunk_id, current, args.context):
        print("sms-message-context: the setting did not converge", file=sys.stderr)
        return 1
    print(f"sms-message-context: inbound MESSAGEs on {args.trunk} now route to "
          f"[{args.context}]")
    return 0


if __name__ == "__main__":
    sys.exit(main())
