#!/usr/bin/env python3
"""pbx/portal_config_access.py — let the portal write the files it owns.

## The failure this exists to remove

The portal's repair path (`POST /api/phone/extensions/repair`) appends
`[<ext>](+)` plus the WebRTC media settings to `pjsip.endpoint_custom_post.conf`,
and the media address to `pjsip_media_custom.conf`. Both are *operator-owned*
files — FreePBX includes them and never regenerates them — which is exactly why
they are the sanctioned place to write. What nothing established is whether the
portal's process can write them at all.

It cannot, and the shape of the failure is why this took a live box to find.
The portal is a Node process running as the image's `nextjs` user (uid 1001);
the PBX container runs Asterisk as `asterisk`. The `pbx-asterisk-config` volume
is shared between them, and the PBX's own boot entrypoint runs

    fwconsole chown

on every start (docker-entrypoint-full.sh). FreePBX's chown walks `$ASTETCDIR`
recursively and sets **0775 asterisk:asterisk** on every file and directory
under it (Console/Chown.class.php, the framework `rdir` rule). 0775 is
owner+group — "other" gets nothing. uid 1001 is not `asterisk`, so the portal
holds no write bit on either file, and `writeFileSync` throws `EACCES`.

The repair route catches that and reports it as the *state*, not as the write
failure: `stateFor()` cannot read the append it failed to write, so the response
says

    pjsip.endpoint_custom_post.conf does not carry `[4132643964](+)`, so
    Asterisk has no WebRTC endpoint for this extension and a browser cannot
    register. Add `[4132643964](+)` with the media settings — the repair path
    does.

which is the exact text the operator saw before clicking Repair. The route
returns 200, the console reports success, and the file is untouched — the
failure is completely silent and reads as "repair does nothing".

## The fix, and why the group has to be the portal's own

The obvious grant — put the portal in the `asterisk` group with compose
`group_add` and leave the files `0664 asterisk:asterisk` — **does not work on
this image, and that is the second half of the bug.** Measured on `.30`:

```
# docker exec zeus-portal sh -c 'su-exec nextjs:nodejs id'
uid=1001(nextjs) gid=1001(nodejs) groups=1001(nodejs)
```

`group_add` does reach the container — `docker exec zeus-portal id` shows the
granted gid — but the entrypoint drops privileges with `su-exec nextjs:nodejs`
(`docker-entrypoint.sh`), and **`su-exec` resets the supplementary group set to
the target user's own groups**. The `group_add` grant is discarded before the
Node server is ever exec'd, so a file owned `asterisk:asterisk` is still
unwritable by it. Confirmed by writing from the server's exact identity:

```
997:1000 mode 664  ->  WRITE FAILED EACCES     # the live bug
997:1001 mode 664  ->  WRITE OK                # the fix
```

So the files are given the portal's **primary** gid, which survives `su-exec`:
`asterisk:<portal-gid>` at `0664`. Asterisk (the owner) keeps its access; the
portal (its primary group) gains write. Nothing else changes hands, and no
container's group set has to be right for it to hold.

The files are the interesting case — `systemSetRecursivePermissions` strips the
execute bit for files, so an `rdir` rule of 0775 lands as **0664**, already
group-writable. What matters is *which* group, and `fwconsole chown` resets it
to `asterisk` on every boot, which is why this runs on every boot right after
that chown.

The alternative — chmod at the portal's write site — does not work: the portal
can chmod a file only if it owns it, and after `fwconsole chown` it does not.
The grant has to come from the side that does own the files, which is the PBX.

## The directory, and why removing a leftover needs a third grant

Repair also *removes* a pre-decision `pjsip_ext_<ext>.conf`, and none of the
above makes that possible. `unlink(2)` checks the **directory**: the caller
needs write *and* execute on the parent, and the mode, owner and group of the
file itself do not enter into the decision at all. So a file-shaped grant cannot
close this — a root-owned leftover stays unremovable however the file is owned.

`fwconsole chown` leaves `$ASTETCDIR` at `0775 asterisk:asterisk`, so the
directory *is* group-writable — for the `asterisk` group, which the portal is
not in (`su-exec` again). Measured on `.30` against the directory itself:

```
1001:1001  ->  EACCES    # the portal as it really runs: "other" on the dir, r-x
1001:1000  ->  OK        # in the asterisk group — the same grant su-exec drops
997:1000   ->  OK        # asterisk, the owner
0:0        ->  OK
```

So the directory is given the portal's **primary** gid as well, exactly as the
two files are. Nothing that writes `$ASTETCDIR` today loses anything: FreePBX
and Apache's workers run as `asterisk` (uid 997 — the owner, who keeps its own
`rwx`), and the `asterisk` group has no members left to lose (`asterisk:x:1000:`
is the owner's own primary group). What the portal gains is the ability to
create, rename and remove **entries** in the config directory — which is the
operation it cannot perform any other way. It gains no access to the entries
themselves: a directory's group bits do not reach into a file's own mode, and
everything else under `$ASTETCDIR` stays `asterisk:asterisk`.

## Judging the group membership

The PBX side cannot observe another container's supplementary groups, so the
tool takes them as an input: `--portal-groups` is the set of gids the portal
process runs with. The default is the `nextjs` user's own groups, which is the
truth after `su-exec` — and the reason the default is not "plus the asterisk
gid" is the whole finding above: that grant does not reach the server.

## What it deliberately does not touch

Only the directory and the two files the portal writes are touched, named
explicitly. Everything else in `$ASTETCDIR` stays 0775 asterisk:asterisk,
because the portal has no business writing it and a broad `chmod -R g+w` would
hand it the PBX.

    # judge, write nothing (0 in sync, 1 an apply converges it, 2 cannot tell)
    python3 pbx/portal_config_access.py --check

    # the PBX container (host side, via docker exec) or bare metal
    python3 pbx/portal_config_access.py --apply

    # what the portal's own process would be granted, to judge off-host
    python3 pbx/portal_config_access.py --check --portal-groups 1000,1001

Exit codes follow `pbx/media_address.py`: 0 in sync, 1 drift (an apply converges
it), 2 cannot tell.
"""
from __future__ import annotations

import argparse
import grp
import os
import pwd
import stat
import sys
from typing import Collection

# The files the portal writes, and the only ones this tool relaxes.
#
# `pjsip.endpoint_custom_post.conf` carries the portal's `[<ext>](+)` WebRTC
# blocks and the `#include` for the media file; `pjsip_media_custom.conf`
# carries the per-endpoint `media_address` appends. Both are operator-owned —
# FreePBX includes them and never regenerates them — so both are the portal's to
# write, and both are reverted to 0775 by `fwconsole chown` on every boot.
PORTAL_FILES = (
    "pjsip.endpoint_custom_post.conf",
    "pjsip_media_custom.conf",
)

# The mode that makes a file writable by its group while leaving it readable to
# everyone — what 0775 would have been if FreePBX's chown had not stripped the
# other bits. Applied to files only, never to the directory: 0775 on the
# directory is already group-writable, and widening it would change what the PBX
# hands out rather than what the portal may change.
PORTAL_FILE_MODE = 0o664

# The leftover Repair removes, named in the directory message so an operator
# can see which file the missing directory bit is about. Not a path this tool
# opens: it is a name to recognise, and the portal owns the actual removal.
LEGACY_FRAGMENT = "pjsip_ext_<ext>.conf"

# The group Asterisk's own files are owned by, and the name this tool chgrps
# away from. Not the group the portal needs — see the module docstring.
PBX_GROUP = "asterisk"

# The portal image's own group (`addgroup --system --gid 1001 nodejs` in the
# Dockerfile) and the uid its server runs as. Used when the names do not
# resolve, so an off-host judgement still has an honest default.
PORTAL_GID = 1001
PORTAL_UID = 1001


def pbx_gid(group: str = PBX_GROUP) -> int:
    """`group`'s gid, or `-1` when it does not exist here."""
    try:
        return grp.getgrnam(group).gr_gid
    except KeyError:
        return -1


def portal_gid() -> int:
    """The portal server's primary gid: the `nextjs` user's, else 1001.

    This is the gid that survives `su-exec nextjs:nodejs`, so it is the one the
    portal-owned files are given.
    """
    try:
        return pwd.getpwnam("nextjs").pw_gid
    except KeyError:
        return PORTAL_GID


def portal_groups(explicit: str | None) -> set[int]:
    """The gids the portal *server* runs with.

    Explicit wins. Otherwise the `nextjs` user's own groups — which is exactly
    what the process has after the entrypoint's `su-exec nextjs:nodejs`, and
    deliberately **not** plus the asterisk gid: `su-exec` discards the
    `group_add` grant, so counting it would judge a state the server is not in.
    """
    if explicit is not None:
        gids: set[int] = set()
        for part in explicit.split(","):
            part = part.strip()
            if part:
                gids.add(int(part))
        return gids

    gids = {portal_gid()}
    try:
        entry = pwd.getpwnam("nextjs")
        gids.update(os.getgrouplist("nextjs", entry.pw_gid))
    except KeyError:
        pass
    return gids


def judge_stat(info: os.stat_result, portal_uid: int, groups: Collection[int]) -> tuple[bool, str]:
    """Whether a process running as `portal_uid` in `groups` may write this file.

    The test is the one the kernel makes: a process may write a file when it
    owns it and the owner write bit is set, **or** it is in the file's group and
    the group write bit is set, **or** the other write bit is set. Anything else
    is `EACCES`, and saying *which* clause is missing is the whole value of this
    tool — "repair does nothing" is the symptom, not the fault.

    Pure, and separated from `judge()`'s `stat`, so the ownership/mode matrix
    can be pinned for every combination — including the ones a test process
    cannot create for itself, because changing a file's uid/gid needs root and
    CI does not run as root.
    """
    mode = stat.S_IMODE(info.st_mode)
    if info.st_uid == portal_uid and mode & stat.S_IWUSR:
        return True, f"owned by the portal (uid {portal_uid})"
    if info.st_gid in groups and mode & stat.S_IWGRP:
        return True, f"group-writable and the portal is in group {info.st_gid}"
    if mode & stat.S_IWOTH:
        return True, "world-writable"

    owner = "root" if info.st_uid == 0 else f"uid {info.st_uid}"
    # The message names the missing clause, because "repair does nothing" is the
    # symptom and this is the fault.
    return (
        False,
        f"{oct(mode)} {owner}:{info.st_gid} — the portal (uid {portal_uid}, "
        f"groups {sorted(groups)}) holds no write bit",
    )


def judge_dir(path: str, portal_uid: int, groups: Collection[int]) -> tuple[bool, str]:
    """`judge_removal_stat` for `path`, with the states a stat cannot report."""
    try:
        info = os.stat(path)
    except OSError as exc:
        return False, f"cannot stat {path}: {exc}"
    if not stat.S_ISDIR(info.st_mode):
        return False, f"{path} is not a directory, so nothing can be removed from it"
    return judge_removal_stat(info, portal_uid, groups)


def judge(path: str, portal_uid: int, groups: Collection[int]) -> tuple[bool, str]:
    """`judge_stat` for `path`, with the two states a stat cannot report."""
    try:
        info = os.stat(path)
    except FileNotFoundError:
        # Not written yet is a real state: the portal creates it on first write
        # and the directory is group-writable, so this is not drift.
        return True, "not written yet (the directory is group-writable)"
    except OSError as exc:
        return False, f"cannot stat {path}: {exc}"
    return judge_stat(info, portal_uid, groups)


def plan(info: os.stat_result, want_gid: int) -> tuple[int, bool]:
    """The mode `info` needs to be portal-writable, and whether its group moves.

    Pure, for the same reason as `judge_stat`: what the fix *should* do is a
    decision about (mode, gid), and a decision that can only be tested as root
    is a decision nobody has tested.
    """
    want = stat.S_IMODE(info.st_mode) | stat.S_IWGRP
    return want, want_gid != -1 and info.st_gid != want_gid


def judge_removal_stat(info: os.stat_result, portal_uid: int,
                       groups: Collection[int]) -> tuple[bool, str]:
    """Whether a process as `portal_uid` in `groups` may unlink in this directory.

    A different question from `judge_stat`, and not a wider version of it: the
    kernel resolves `unlink(2)` against the **parent directory** with a
    write+execute clause, and the entry being removed may be owned by root and
    unreadable to the caller — that does not stop the removal. Judging a
    directory with the file rule would therefore pass a mode the kernel refuses
    (`0664` on a directory has the group write bit and no search bit: nothing
    may be created in it, renamed in it, or removed from it) and refuse the one
    that works. Both clauses are pinned by the tests.
    """
    mode = stat.S_IMODE(info.st_mode)
    if info.st_uid == portal_uid and (mode & (stat.S_IWUSR | stat.S_IXUSR)) == (
            stat.S_IWUSR | stat.S_IXUSR):
        return True, f"owned by the portal (uid {portal_uid})"
    if info.st_gid in groups and (mode & (stat.S_IWGRP | stat.S_IXGRP)) == (
            stat.S_IWGRP | stat.S_IXGRP):
        return True, f"group-writable and searchable, and the portal is in group {info.st_gid}"
    if (mode & (stat.S_IWOTH | stat.S_IXOTH)) == (stat.S_IWOTH | stat.S_IXOTH):
        return True, "world-writable"

    owner = "root" if info.st_uid == 0 else f"uid {info.st_uid}"
    # Same shape as `judge_stat`'s message, and for the same reason: the fault
    # is the missing bit on the directory, and "Repair does nothing" is only the
    # symptom of it.
    return (
        False,
        f"{oct(mode)} {owner}:{info.st_gid} — the portal (uid {portal_uid}, "
        f"groups {sorted(groups)}) holds no write bit on the directory, and "
        f"unlinking a leftover {LEGACY_FRAGMENT} needs one there: the parent's "
        f"permission is what `unlink(2)` checks, not the file's",
    )


def plan_dir(info: os.stat_result, want_gid: int) -> tuple[int, bool]:
    """The mode a *directory* needs before the portal may create or remove in it.

    `plan` plus the group search bit: unlink needs write **and** execute, and a
    directory that keeps the write bit but lost the execute bit (an operator's
    `chmod 664`, a copy that did not preserve the mode) is still one the portal
    cannot use. Both bits are added; nothing else changes.
    """
    want, move_group = plan(info, want_gid)
    return want | stat.S_IXGRP, move_group


def apply_access(path: str, mode: int, move_group: bool, want_gid: int,
                 unchanged: str) -> tuple[bool, str]:
    """`chmod`/`chown` the pair `plan`/`plan_dir` decided, for a file or a directory.

    Returns (changed, detail). The group is moved to the portal's own gid rather
    than merely asserted to `asterisk`, because `su-exec` resets the server's
    supplementary groups — a path owned `asterisk:asterisk` is unusable no
    matter what `group_add` says. Only the bits the plan asked for are added;
    the rest of the mode is preserved so a file an operator tightened (0600) is
    not silently published.

    `unchanged` is the sentence to answer with when neither call was needed,
    because the two callers are making different claims — "already
    group-writable" for a file, "already writable and searchable by the portal"
    for the directory — and the operator reading them is diagnosing different
    faults. The syscalls are shared so their failure reporting is one piece of
    code rather than two that drift.
    """
    changed = False
    if mode != stat.S_IMODE(os.stat(path).st_mode):
        try:
            os.chmod(path, mode)
            changed = True
        except OSError as exc:
            return False, f"chmod failed: {exc}"
    if move_group:
        try:
            os.chown(path, -1, want_gid)
        except OSError as exc:
            # The mode already landed, so this is still a change — reporting
            # `False` would send an operator looking for a tool that did
            # nothing, which is the bug this file exists to end.
            return True, f"{oct(mode)} but chgrp to gid {want_gid} failed: {exc}"
        changed = True
    if not changed:
        return False, unchanged
    return True, f"{oct(mode)} gid {want_gid}"


def converge(path: str, want_gid: int) -> tuple[bool, str]:
    """Make the file `path` writable **by the portal's primary gid**."""
    try:
        info = os.stat(path)
    except FileNotFoundError:
        return False, "not written yet"
    except OSError as exc:
        return False, f"cannot stat: {exc}"

    want, move_group = plan(info, want_gid)
    return apply_access(path, want, move_group, want_gid, "already group-writable")


def converge_dir(path: str, want_gid: int) -> tuple[bool, str]:
    """Let the portal create and remove entries in the directory `path`.

    The same grant as `converge`, with the group search bit included — see
    `plan_dir`. It is what makes the repair path's removal of a leftover
    `pjsip_ext_<ext>.conf` possible at all.
    """
    try:
        info = os.stat(path)
    except OSError as exc:
        return False, f"cannot stat: {exc}"
    if not stat.S_ISDIR(info.st_mode):
        return False, "not a directory"

    want, move_group = plan_dir(info, want_gid)
    return apply_access(path, want, move_group, want_gid,
                        "already writable and searchable by the portal")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--asterisk-dir",
                    default=os.environ.get("PJSIP_CONF_DIR", "/etc/asterisk"),
                    help="the PBX config dir holding the portal-owned pjsip files")
    ap.add_argument("--portal-uid", type=int, default=None,
                    help="the portal process's uid (default: the `nextjs` user)")
    ap.add_argument("--portal-gid", type=int, default=None,
                    help="the gid the portal-owned files are given — the portal "
                         "server's PRIMARY gid, which survives `su-exec` "
                         "(default: the `nextjs` group)")
    ap.add_argument("--pbx-group", default=os.environ.get("PBX_GROUP", PBX_GROUP),
                    help=f"the group the PBX owns the files with (default: {PBX_GROUP}); "
                         "only used to report which group is being moved away from")
    ap.add_argument("--portal-groups",
                    default=os.environ.get("PORTAL_GROUPS"),
                    help="comma-separated gids the portal runs with "
                         "(default: nextjs's own groups — what survives "
                         "`su-exec`, and deliberately not plus the asterisk gid)")
    ap.add_argument("--apply", action="store_true",
                    help="make the directory and the files usable by the "
                         "portal's primary gid (default: judge only)")
    ap.add_argument("--check", action="store_true",
                    help="judge and exit 0/1/2 (the default; this tool writes nothing)")
    args = ap.parse_args(argv)

    if not os.path.isdir(args.asterisk_dir):
        print(f"portal-access: {args.asterisk_dir} is not a directory — cannot tell",
              file=sys.stderr)
        return 2

    portal_uid = args.portal_uid
    if portal_uid is None:
        try:
            portal_uid = pwd.getpwnam("nextjs").pw_uid
        except KeyError:
            # This container (the PBX) has no `nextjs` user — the portal is a
            # different image. The uid is only ever *reported*, so falling back
            # to the image's own uid keeps the message honest instead of saying
            # "uid -1", which reads as a broken measurement.
            portal_uid = PORTAL_UID
    groups = portal_groups(args.portal_groups)
    want_gid = args.portal_gid if args.portal_gid is not None else portal_gid()
    if want_gid == -1:
        print("portal-access: no portal gid to grant — cannot tell", file=sys.stderr)
        return 2

    # The directory first, because it grants a different capability from the two
    # files: the repair path's *removal* of a leftover `pjsip_ext_<ext>.conf`.
    # Its label is the trailing-slash form so a reader can tell which of these
    # lines is about the directory and not one of the files in it.
    dir_label = args.asterisk_dir.rstrip("/") + "/"
    targets: list[tuple[str, str, bool]] = [
        (dir_label, args.asterisk_dir, True),
        *((name, os.path.join(args.asterisk_dir, name), False) for name in PORTAL_FILES),
    ]

    out_of_sync: list[tuple[str, str, bool]] = []
    for label, path, is_dir in targets:
        writable, detail = (judge_dir if is_dir else judge)(path, portal_uid, groups)
        if writable:
            access = ("the portal can create and remove entries in it" if is_dir
                      else "the portal can write it")
            print(f"portal-access: {label} — {access} ({detail})")
        else:
            out_of_sync.append((label, path, is_dir))
            print(f"portal-access: {label} — NOT writable by the portal: {detail}",
                  file=sys.stderr)

    if not out_of_sync:
        print(
            f"portal-access: the portal can write its config files and remove a "
            f"leftover {LEGACY_FRAGMENT} from {dir_label}"
        )
        return 0

    if args.check or not args.apply:
        print(
            f"portal-access: {len(out_of_sync)} path(s) the portal cannot write — "
            f"the repair path will report the state instead of writing it; "
            f"re-run with --apply",
            file=sys.stderr,
        )
        return 1

    for label, path, is_dir in out_of_sync:
        _, detail = (converge_dir if is_dir else converge)(path, want_gid)
        print(f"portal-access: {label} — {detail}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
