#!/usr/bin/env python3
"""The portal's write access to the files it owns, asserted with no PBX.

`pbx/portal_config_access.py` closes a gap whose signature is a button that does
nothing: the portal's Repair appends to `pjsip.endpoint_custom_post.conf`, the
PBX's boot entrypoint runs `fwconsole chown` which imposes its framework rule on
everything under `/etc/asterisk`, the portal runs as uid 1001, and
`writeFileSync` throws `EACCES`. The route then reports the *state* it failed to
change, so the operator reads the same sentence before and after clicking
Repair.

The judgement is the kernel's, so it is worth pinning rather than only measuring
on `.30`:

  * a file the portal owns and may write is in sync;
  * a `0664 asterisk:asterisk` file is **not** writable by the portal — the
    entrypoint's `su-exec nextjs:nodejs` resets the supplementary group set, so
    a compose `group_add` grant never reaches the server (measured on `.30`);
  * a file owned `asterisk:<portal gid>` is writable, because the portal's
    **primary** group is what survives `su-exec` — that is the fix;
  * a file that does not exist yet is not drift, because the directory is
    group-writable and the portal creates it on first write;
  * an apply adds the group-write bit and re-asserts the group, and nothing
    else, so a file an operator tightened is not silently published.

## Why most of these tests never touch the filesystem

The judgement is a function of `(uid, gid, mode)` and nothing else, so it is
tested as one: `judge_stat()` takes a stat result the test built and
`plan()` takes one and returns the mode it wants. That is deliberate.

An earlier version of this suite built real files and `chown`ed them to the
uids under test. It passed 22/22 as root and **11/22** as the unprivileged
`runner` user — which is who CI is. `chown` to a foreign uid needs root, so the
call was swallowed, the file kept the *test runner's own* uid, and uid 1001 was
simultaneously the portal identity and the owner of every fixture: files that
were supposed to be unwritable came back owned-by-the-portal and writable. The
suite's verdict depended on who ran it, which is the one thing a regression
guard must not do.

So the ownership matrix is asserted directly, and the filesystem is used only
for the claims that are genuinely about a real inode: that `--check` writes
nothing, that a missing directory is `cannot tell`, and that `--apply` converges
a real box. Those use the *running* user's own uid/gid, which any user can set,
and the two gid-changing converge tests are skipped without root rather than
asserted on a chown that silently did nothing.

Run:  python3 -m unittest discover -s pbx/tests -v
"""
from __future__ import annotations

import contextlib
import io
import os
import pwd
import stat
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import portal_config_access as pca  # noqa: E402

# The live identities, from `.30`. These are values under test, not values this
# process needs to be able to assume — `judge_stat` never checks them against
# `os.getuid()`, so the numbers are the ones the bug actually had.
PORTAL_UID = 1001
PORTAL_GID = 1000
PBX_GID = 100  # `asterisk`

# A group that exists on every host, used where the tool takes a *name*
# (`--pbx-group`) rather than a number.
GROUP = "root"


def st(mode: int, uid: int = 0, gid: int = PBX_GID) -> os.stat_result:
    """A stat result shaped like `os.stat`'s 10-tuple, for `judge_stat`/`plan`.

    `os.stat_result` is constructed from `(mode, ino, dev, nlink, uid, gid,
    size, atime, mtime, ctime)`, which is why `st_uid`/`st_gid` can be any pair
    at all without a filesystem having to agree.
    """
    return os.stat_result((stat.S_IFREG | mode, 1, 1, 1, uid, gid, 0, 0.0, 0.0, 0.0))


IS_ROOT = os.geteuid() == 0
needs_root = unittest.skipUnless(
    IS_ROOT, "changing a file's gid needs root, and a chown that silently did nothing is worse than no test"
)


class JudgeMatrixTest(unittest.TestCase):
    """`judge_stat`: which write clause lets the portal through, for every mode.

    Every combination of (mode, ownership, membership) that decides the live
    bug. No inode is created, so this runs identically as root and as `runner`.
    """

    def judge(self, mode, *, uid=0, gid=PBX_GID, portal_uid=PORTAL_UID,
              groups=(PORTAL_GID,)):
        return pca.judge_stat(st(mode, uid, gid), portal_uid, set(groups))

    def test_the_measured_failure_is_refused(self):
        # `fwconsole chown`'s framework rule, as it lands on a file: 0664
        # asterisk:asterisk (the `rdir` rule strips the execute bit for files).
        # uid 1001 holds no write bit and is not in group 100 — the live state.
        writable, detail = self.judge(0o664)
        self.assertFalse(writable)
        self.assertIn("no write bit", detail)

    def test_the_portals_own_gid_on_the_file_is_what_makes_it_writable(self):
        # The fix: the file carries the portal's PRIMARY gid, which is what
        # survives the entrypoint's `su-exec nextjs:nodejs`.
        writable, detail = self.judge(0o664, gid=PORTAL_GID)
        self.assertTrue(writable, detail)
        self.assertIn(f"group {PORTAL_GID}", detail)

    def test_the_supplementary_grant_is_only_as_good_as_the_groups_given(self):
        # The trap this tool exists to not fall into, stated precisely. A
        # compose `group_add` of the asterisk gid *would* make this file
        # writable — the kernel clause is real and `judge_stat` honours it when
        # handed that group. What makes it a trap is that `su-exec
        # nextjs:nodejs` discards the grant before the server runs, so that
        # input is a state the process is never in. Hence the default in
        # `portal_groups()` is the portal's own primary gid and this test pins
        # both ends: given the phantom grant the file is writable, and the
        # default does not hand it over.
        writable, _ = self.judge(0o664, groups=(PBX_GID,))
        self.assertTrue(writable, "the kernel clause must still be honoured")
        self.assertNotIn(PBX_GID, pca.portal_groups(None))

    def test_a_0775_file_is_not_writable_without_membership_either(self):
        # The mode 0775 lands as for a directory; the group-write bit is present
        # and still useless without membership.
        self.assertFalse(self.judge(0o775)[0])

    def test_the_group_bit_alone_is_not_enough_without_membership(self):
        self.assertFalse(self.judge(0o644)[0])

    def test_a_portal_owned_file_needs_no_group_grant(self):
        # Owner clause, not group clause: the portal owns the file and holds the
        # owner write bit. Judged with *no* group membership at all.
        writable, detail = self.judge(0o644, uid=PORTAL_UID, groups=())
        self.assertTrue(writable, detail)
        self.assertIn("owned by the portal", detail)

    def test_world_writable_is_accepted_but_named(self):
        writable, detail = self.judge(0o666)
        self.assertTrue(writable, detail)
        self.assertIn("world-writable", detail)

    def test_no_clause_passing_means_eacces(self):
        # 0600 owned by the PBX: not the portal's uid, not its group, no other
        # bit. This is what EACCES actually looks like, and the one combination
        # where the fault is the mode rather than the group.
        writable, detail = self.judge(0o600)
        self.assertFalse(writable)
        self.assertIn("no write bit", detail)

    def test_the_detail_names_the_fault_not_the_symptom(self):
        # "repair does nothing" is the symptom; the ownership triple is the
        # fault, so the message has to carry it or it diagnoses nothing.
        _, detail = self.judge(0o664)
        self.assertIn(f"uid {PORTAL_UID}", detail)
        self.assertIn(str(PBX_GID), detail)
        self.assertIn("0o664", detail)

    def test_ownership_by_another_non_portal_uid_is_still_refused(self):
        # Guards against the class of bug a root-only suite hides: if the check
        # were "is this file owned by someone", the owner uid would pass.
        self.assertFalse(self.judge(0o664, uid=PORTAL_UID + 1, groups=())[0])


class PlanTest(unittest.TestCase):
    """`plan`: the mode an apply wants, and whether the group moves with it."""

    def test_it_only_ever_adds_the_group_write_bit(self):
        want, _ = pca.plan(st(0o644), PORTAL_GID)
        self.assertEqual(stat.S_IMODE(want), 0o664)

    def test_an_already_group_writable_file_keeps_its_mode(self):
        want, move = pca.plan(st(0o664, gid=PORTAL_GID), PORTAL_GID)
        self.assertEqual(stat.S_IMODE(want), 0o664)
        self.assertFalse(move)

    def test_a_tightened_file_is_not_published(self):
        # 0600 is an operator's decision; group-write must not drag group- or
        # world-read along with it.
        want, _ = pca.plan(st(0o600), PORTAL_GID)
        self.assertEqual(stat.S_IMODE(want), 0o620)

    def test_the_group_moves_whenever_it_is_not_already_the_portals(self):
        _, move = pca.plan(st(0o664, gid=PBX_GID), PORTAL_GID)
        self.assertTrue(move)

    def test_no_wanted_gid_means_the_group_is_left_alone(self):
        # `-1` is "no portal gid to grant"; converge must not then try to chgrp
        # every file to -1 and fail on all of them.
        _, move = pca.plan(st(0o664, gid=PBX_GID), -1)
        self.assertFalse(move)


class PortalGroupsTest(unittest.TestCase):
    def test_explicit_gids_win(self):
        self.assertEqual(pca.portal_groups("1000, 1001"), {1000, 1001})

    def test_an_empty_explicit_value_is_no_groups(self):
        self.assertEqual(pca.portal_groups(""), set())

    def test_the_default_is_the_portals_primary_gid_not_the_pbx_group(self):
        # `su-exec` resets supplementary groups, so the default must be the
        # portal's own — counting the asterisk gid would judge a state the
        # server is never in.
        groups = pca.portal_groups(None)
        self.assertIn(pca.portal_gid(), groups)


class JudgePathTest(unittest.TestCase):
    """`judge`: the two states a stat result cannot report."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="portal-access-")
        self.path = os.path.join(self.tmp, pca.PORTAL_FILES[0])

    def test_a_missing_file_is_not_drift(self):
        # The portal creates it on first write and the directory is
        # group-writable, so "not written yet" is a real state, not a fault.
        writable, detail = pca.judge(self.path, PORTAL_UID, {PORTAL_GID})
        self.assertTrue(writable)
        self.assertIn("not written yet", detail)

    def test_a_real_file_the_portal_cannot_write_is_refused(self):
        # The matrix says this; the kernel has to agree, so it is built with
        # the running user's own uid and gid — which any user can set — and
        # judged as a portal the running user is not.
        with open(self.path, "w", encoding="utf-8") as fh:
            fh.write("[101](+)\n")
        os.chmod(self.path, 0o644)
        writable, detail = pca.judge(self.path, os.geteuid() + 4242, set())
        self.assertFalse(writable, detail)

    def test_a_real_group_writable_file_is_accepted(self):
        with open(self.path, "w", encoding="utf-8") as fh:
            fh.write("[101](+)\n")
        os.chmod(self.path, 0o664)
        writable, detail = pca.judge(self.path, os.geteuid() + 4242, {os.getgid()})
        self.assertTrue(writable, detail)


class ConvergeTest(unittest.TestCase):
    """`converge`: the mode and group bits, on a real inode.

    The file belongs to whoever runs the suite, so `--want_gid` is the running
    user's own gid in the tests that need the chgrp to succeed. Changing a
    group to something the caller does not hold needs root, so those are
    skipped rather than faked.
    """

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="portal-access-")
        self.path = os.path.join(self.tmp, pca.PORTAL_FILES[1])
        with open(self.path, "w", encoding="utf-8") as fh:
            fh.write("[101](+)\nmedia_address=192.168.1.30\n")
        os.chmod(self.path, 0o664)
        self.own_gid = os.getgid()

    def test_it_adds_only_the_group_write_bit(self):
        os.chmod(self.path, 0o644)
        changed, detail = pca.converge(self.path, self.own_gid)
        self.assertTrue(changed, detail)
        self.assertEqual(os.stat(self.path).st_mode & 0o777, 0o664)

    def test_a_tightened_file_is_not_published(self):
        os.chmod(self.path, 0o600)
        pca.converge(self.path, self.own_gid)
        self.assertEqual(os.stat(self.path).st_mode & 0o777, 0o620)

    def test_a_file_already_in_the_wanted_group_is_a_no_op(self):
        changed, detail = pca.converge(self.path, self.own_gid)
        self.assertFalse(changed, detail)

    def test_a_missing_file_is_reported_not_created(self):
        # The portal creates it; a tool that created it here would write an
        # empty PJSIP file the PBX then loads.
        changed, detail = pca.converge(os.path.join(self.tmp, "nope.conf"), self.own_gid)
        self.assertFalse(changed)
        self.assertIn("not written yet", detail)

    @needs_root
    def test_it_moves_the_group_to_the_portals_own(self):
        # The load-bearing change, and the one that cannot be asserted without
        # root: a foreign gid. `fwconsole chown` sets `asterisk`, which the
        # portal cannot use after `su-exec`.
        changed, detail = pca.converge(self.path, PORTAL_GID)
        self.assertTrue(changed, detail)
        self.assertEqual(os.stat(self.path).st_gid, PORTAL_GID)

    @unittest.skipIf(IS_ROOT, "root can chgrp to anything, so the failure is unreachable")
    def test_a_chgrp_that_cannot_happen_is_reported_as_a_change(self):
        # Unprivileged, converging onto a gid we do not hold: the mode still
        # lands, and the tool must say it changed something rather than
        # reporting "nothing to do" — which is the silent no-op this file
        # exists to remove.
        os.chmod(self.path, 0o644)
        changed, detail = pca.converge(self.path, PORTAL_GID)
        self.assertTrue(changed, detail)
        self.assertIn("chgrp", detail)
        self.assertEqual(os.stat(self.path).st_mode & 0o777, 0o664)


class MainTest(unittest.TestCase):
    """`main`: the exit codes the entrypoint and the sync tick branch on.

    The fixtures are owned by the running user and judged as a portal that user
    is not, so drift is real drift on any host. 0 in sync, 1 an apply converges
    it, 2 cannot tell.
    """

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="portal-access-")
        for name in pca.PORTAL_FILES:
            path = os.path.join(self.tmp, name)
            with open(path, "w", encoding="utf-8") as fh:
                fh.write("; x\n")
            os.chmod(path, 0o644)
        self.portal_uid = os.geteuid() + 4242
        self.portal_gid = os.getgid()

    def _run(self, *args: str) -> tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = pca.main(list(args))
        return rc, out.getvalue(), err.getvalue()

    def _base(self, *extra: str) -> list[str]:
        return ["--asterisk-dir", self.tmp, "--pbx-group", GROUP,
                "--portal-uid", str(self.portal_uid),
                "--portal-gid", str(self.portal_gid), *extra]

    def test_a_644_box_is_drift_and_check_writes_nothing(self):
        rc, _, err = self._run(*self._base("--check", "--portal-groups", str(self.portal_gid)))
        self.assertEqual(rc, 1, err)
        self.assertIn("NOT writable", err)
        self.assertEqual(
            os.stat(os.path.join(self.tmp, pca.PORTAL_FILES[0])).st_mode & 0o777, 0o644
        )

    def test_an_apply_then_a_check_is_in_sync(self):
        rc, _, err = self._run(*self._base("--apply", "--portal-groups", str(self.portal_gid)))
        self.assertEqual(rc, 0, err)
        rc, out, err = self._run(*self._base("--portal-groups", str(self.portal_gid)))
        self.assertEqual(rc, 0, err)
        self.assertIn("writable by the portal", out)

    def test_a_640_file_is_still_drift(self):
        # A file an operator tightened to 0640: the group write bit is gone, and
        # the tool says so rather than reporting the group as sufficient.
        for name in pca.PORTAL_FILES:
            os.chmod(os.path.join(self.tmp, name), 0o640)
        rc, _, err = self._run(*self._base("--check", "--portal-groups", str(self.portal_gid)))
        self.assertEqual(rc, 1, err)
        self.assertIn("NOT writable", err)

    def test_a_missing_config_dir_is_cannot_tell(self):
        rc, _, err = self._run("--asterisk-dir", os.path.join(self.tmp, "absent"),
                               "--check")
        self.assertEqual(rc, 2)
        self.assertIn("not a directory", err)

    def test_files_that_do_not_exist_yet_are_in_sync(self):
        empty = tempfile.mkdtemp(prefix="portal-access-empty-")
        rc, out, _ = self._run("--asterisk-dir", empty, "--pbx-group", GROUP,
                               "--portal-gid", str(self.portal_gid), "--check")
        self.assertEqual(rc, 0)
        self.assertIn("not written yet", out)

    def test_no_portal_gid_is_cannot_tell(self):
        # With no gid to grant there is nothing to judge against, so the tool
        # refuses rather than reporting every file as fine.
        rc, _, err = self._run("--asterisk-dir", self.tmp, "--portal-gid", "-1",
                               "--portal-groups", str(self.portal_gid), "--check")
        self.assertEqual(rc, 2)
        self.assertIn("cannot tell", err)


if __name__ == "__main__":
    unittest.main()