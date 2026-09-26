#!/usr/bin/env python3
"""pbx/media_address.py — the address Asterisk hands a LAN phone, kept on disk.

Asterisk puts the address it wants media sent to in the answer SDP. Inside this
estate's PBX container that address is the *docker bridge* — `c=IN IP4
172.19.0.4` — and a phone on the LAN has no route to it. The phone obeys the
SDP, sends its talk path and every DTMF digit into a subnet it cannot reach,
Asterisk receives none of it, and `rtp_timeout=30` hangs the call up at exactly
thirty seconds. Nobody notices the missing direction: Asterisk keeps sending
*toward the phone's real address*, so the caller still **hears** the prompts.
Measured on `.30` with `rtp set debug on`: 1119 RTP packets sent to the phone,
0 received. It arrives as "my voicemail touchtone does not work and it hangs up
on me", and every other check — dialplan, mailbox, DSN, trunks — is green,
because the trunks are the half that works.

## Why it is per endpoint, and where it therefore goes

`external_media_address` (the trunk half) is the WAN address and is right for
peers *outside* `local_net`. A LAN phone needs the opposite, so no single value
can serve both and the fix has to be per endpoint: `media_address` on the
endpoint is the address Asterisk advertises for *that* endpoint's media. The
trunks deliberately get no such line.

It cannot be a static file in this repo either. It is a fact about the running
host — the LAN address and the set of endpoints FreePBX currently has — so it is
rendered from the box, exactly like `rtp_custom.conf` and the `local_net` lines.
`docker-entrypoint-full.sh` runs this tool on every boot (the address from
`LAN_IP`/`PJSIP_MEDIA_ADDRESS`); `scripts/setup.sh` runs it on bare metal. A
rebuilt box therefore gets the lines back without a person re-adding them, which
is the gap this tool closes: before it, the lines lived only in the
`pbx-asterisk-config` volume and an image rebuild lost them, with nothing but the
smoke check to say so.

## The file, and why it is not `pjsip.endpoint_custom_post.conf`

FreePBX generates `pjsip.conf` with `#include pjsip.endpoint_custom_post.conf`
*after* the generated endpoints, and the portal appends `[<ext>](+)` there for a
softphone's WebRTC settings. Our line is also an `[<ext>](+)` append — and the
portal treats *any* `[<ext>](+)` in that file as its own, cutting and rewriting
every one of them on the next softphone provision. A media line written there
would be deleted the first time somebody opened the Phone screen.

So the sections live in their own operator-owned file, `pjsip_media_custom.conf`,
which this tool owns outright, and it keeps one `#include` for it in
`pjsip.endpoint_custom_post.conf`. That file is loaded after the endpoints and
FreePBX never regenerates it, so `(+)` appends to the endpoint FreePBX owns; and
the include line is not a `[<name>]` header, so the portal's block-surgery
neither reads it nor cuts it. It is placed before the first section for that
same reason — the portal's last block extends to end-of-file, so a line appended
after it would be cut away with the block. One object per extension, one owner
per line.

## Reading and writing

    # judge, write nothing (0 in sync, 1 an apply converges it, 2 cannot tell)
    python3 pbx/media_address.py --address 192.168.1.30 --check

    # the live PBX (host side): the endpoint list comes from its own `devices`
    python3 pbx/media_address.py --address 192.168.1.30 --apply

    # off-host / inside the container: judge a device-table dump
    mysql -N -B -u root asterisk \\
        -e "SELECT id FROM devices WHERE tech IN ('sip','pjsip')" \\
      | python3 pbx/media_address.py --devices-tsv - --address 192.168.1.30 --apply

Exit codes follow `pbx/dograh_routes.py`: 1 means an apply converges the estate,
and 2 means the question could not be answered (no address, no endpoints, no
config dir) — never a pass.
"""
from __future__ import annotations

import argparse
import ipaddress
import os
import pwd
import sys
import tempfile
from typing import Collection

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pbx_db  # noqa: E402

# The file this tool owns, and the ones it only touches through one #include.
MEDIA_FILE = "pjsip_media_custom.conf"
INCLUDE_HOST = "pjsip.endpoint_custom_post.conf"
INCLUDE_LINE = "#include pjsip_media_custom.conf"

# FreePBX's device table. Both technologies are desk phones the PBX routes to
# and both are handed an SDP address, so both need the line.
DEVICES_QUERY = "SELECT id FROM devices WHERE tech IN ('sip','pjsip')"

# Docker's own ranges. A phone on the LAN cannot reach any of them, so a line
# pointing at one is the bug this tool exists to remove, not a fix for it.
# 172.16.0.0/12 is the bridge range the README keeps naming; link-local and
# loopback are the other two addresses a container picks when it is confused.
BAD_NETS = (
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("169.254.0.0/16"),
    ipaddress.ip_network("172.16.0.0/12"),
)


def parse_devices(text: str) -> list[str]:
    """`SELECT id FROM devices ...` (mysql -N -B) as a list of extension ids.

    One id per line; blanks and repeats dropped. Kept as strings: an extension
    is a dial string, not an integer, and `12000` must stay `12000`.
    """
    seen: list[str] = []
    for line in text.splitlines():
        ext = line.split("\t")[0].strip()
        if ext and ext not in seen:
            seen.append(ext)
    return seen


def bad_address(address: str) -> str:
    """Why this address is unusable as a media address, or `""` if it is fine.

    An empty answer is the dangerous one — Asterisk then advertises its own
    local address and the LAN phone goes deaf in the one direction it cannot
    see — so an address that cannot be parsed is refused by name rather than
    written and discovered at the phone.
    """
    if not address:
        return "no address"
    try:
        ip = ipaddress.ip_address(address)
    except ValueError:
        return f"'{address}' is not an IP address"
    if ip.is_loopback:
        return f"{address} is loopback"
    if ip.is_link_local:
        return f"{address} is link-local"
    for net in BAD_NETS:
        if ip in net:
            return f"{address} is in {net} (a docker or container range — a LAN phone cannot reach it)"
    return ""


def _ext_key(extension: str) -> tuple[int, int, str]:
    """Digits sort numerically — `1001` before `12000` — everything else after."""
    return (0, int(extension), "") if extension.isdigit() else (1, 0, extension)


def render_media_section(extension: str, address: str) -> str:
    """One `[<ext>](+) media_address=<addr>` append, ending in a newline.

    The unit the portal mirrors in `src/lib/pjsip-endpoint.ts`
    (`renderMediaSection`) — same bytes, pinned by `scripts/pjsip-endpoint.test.mjs`.
    It is an append (`(+)`), so it extends the endpoint FreePBX owns; it defines
    no object.
    """
    return f"[{extension}](+)\nmedia_address={address}\n"


def render_media_file(endpoints: Collection[str], address: str) -> str:
    """The whole `pjsip_media_custom.conf`: one `[<ext>](+)` append per endpoint.

    Byte-stable for the same input, so `--check` and a second `--apply` are the
    same read: the comment is fixed text and the endpoints are sorted.
    """
    lines = [
        "; Media addresses for this PBX's own LAN endpoints.",
        "; Auto-generated by pbx/media_address.py — do not edit; FreePBX never",
        "; regenerates this file, but the boot entrypoint rewrites it from the host.",
        ";",
        "; `[<ext>](+)` APPENDS media_address to the endpoint FreePBX generates for",
        "; that extension in pjsip.endpoint.conf — the same object the PBX routes to,",
        "; so the phone is told an address it can actually reach. Without it Asterisk",
        "; advertises its own container address and the phone's voice and DTMF are",
        "; lost, with rtp_timeout hanging the call up.",
        ";",
        "; The trunks are deliberately absent: they are outside local_net and need the",
        "; WAN address (external_media_address). One value cannot serve both halves.",
        "",
    ]
    for ext in sorted(endpoints, key=_ext_key):
        lines.append(render_media_section(ext, address))
    return "\n".join(lines)


def with_include(text: str) -> str:
    """`text` with one `#include pjsip_media_custom.conf`, prepended when absent.

    Never duplicated, and never appended. The host file is the portal's: the
    portal parses it into `[<name>]` blocks and cuts them, and its last block
    extends to end-of-file — so an include appended *after* the portal's own
    block would be cut away with it the next time a softphone is provisioned. A
    prelude line before the first section is never inside any block, so it
    survives; every other byte is carried over untouched.
    """
    if any(line.strip() == INCLUDE_LINE for line in text.splitlines()):
        return text
    return f"{INCLUDE_LINE}\n{text}"


def _read(path: str) -> str:
    try:
        with open(path, encoding="utf-8", errors="replace") as handle:
            return handle.read()
    except FileNotFoundError:
        return ""


def _write(path: str, text: str) -> None:
    """Atomic write that keeps the file's mode, and hands it to asterisk if we can."""
    directory = os.path.dirname(path) or "."
    mode = 0o640
    try:
        mode = os.stat(path).st_mode & 0o7777
    except FileNotFoundError:
        pass
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".media-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
        os.chmod(tmp, mode)
        try:  # Asterisk runs as `asterisk`; a root-written file it cannot read is not a fix
            entry = pwd.getpwnam("asterisk")
            os.chown(tmp, entry.pw_uid, entry.pw_gid)
        except (KeyError, PermissionError, OSError):
            pass
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def read_live_devices(container: str) -> str:
    return pbx_db.mysql_exec(container, DEVICES_QUERY)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--asterisk-dir",
                    default=os.environ.get("PJSIP_CONF_DIR", "/etc/asterisk"),
                    help="the PBX config dir holding the pjsip files")
    ap.add_argument("--address",
                    default=os.environ.get("PJSIP_MEDIA_ADDRESS")
                    or os.environ.get("LAN_IP") or "",
                    help="the LAN address a phone can reach (default: $LAN_IP)")
    ap.add_argument("--devices-tsv",
                    help="a `SELECT id FROM devices ...` dump, or - for stdin")
    ap.add_argument("--container", default=os.environ.get("PBX_CONTAINER", ""),
                    help="the FreePBX container to read (default: autodetect)")
    ap.add_argument("--apply", action="store_true",
                    help="write the files (default: judge only)")
    ap.add_argument("--check", action="store_true",
                    help="judge and exit 0/1/2 (the default; this tool writes nothing)")
    args = ap.parse_args(argv)

    problem = bad_address(args.address)
    if problem:
        print(f"media-address: {problem} — nothing to write", file=sys.stderr)
        return 2
    if not os.path.isdir(args.asterisk_dir):
        print(f"media-address: {args.asterisk_dir} is not a directory — cannot tell",
              file=sys.stderr)
        return 2

    if args.devices_tsv:
        try:
            text = sys.stdin.read() if args.devices_tsv == "-" else open(
                args.devices_tsv, encoding="utf-8").read()
        except OSError as exc:
            print(f"media-address: cannot read {args.devices_tsv}: {exc}", file=sys.stderr)
            return 2
    else:
        container = pbx_db.resolve_container(args.container)
        if not container:
            print("media-address: no FreePBX container found — cannot tell", file=sys.stderr)
            return 2
        try:
            text = read_live_devices(container)
        except pbx_db.RouteError as exc:
            print(f"media-address: {exc} — cannot tell", file=sys.stderr)
            return 2
    endpoints = parse_devices(text)
    if not endpoints:
        print("media-address: the PBX names no sip/pjsip endpoint — cannot judge",
              file=sys.stderr)
        return 2

    media_path = os.path.join(args.asterisk_dir, MEDIA_FILE)
    host_path = os.path.join(args.asterisk_dir, INCLUDE_HOST)
    host_text = _read(host_path)
    desired_media = render_media_file(endpoints, args.address)
    desired_host = with_include(host_text)

    changed = [name for name, path, want in (
        (MEDIA_FILE, media_path, desired_media),
        (INCLUDE_HOST, host_path, desired_host),
    ) if _read(path) != want]

    print(f"media-address: {len(endpoints)} endpoint(s) in {args.asterisk_dir}, "
          f"advertising {args.address}")
    if not changed:
        print("media-address: every endpoint already advertises a reachable media address")
        return 0
    for name in changed:
        print(f"  out of date: {name}", file=sys.stderr)
    if args.check or not args.apply:
        print(f"media-address: {len(changed)} file(s) need media_address={args.address} "
              f"— re-run with --apply", file=sys.stderr)
        return 1

    for name, path, want in ((MEDIA_FILE, media_path, desired_media),
                             (INCLUDE_HOST, host_path, desired_host)):
        if _read(path) != want:
            _write(path, want)
    print(f"media-address: wrote media_address={args.address} and its #include")
    return 0


if __name__ == "__main__":
    sys.exit(main())
