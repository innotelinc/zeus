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

The tests use a group that exists on every host rather than assuming an
`asterisk` group, and pass the gids explicitly, so they do not depend on how
this box was provisioned.

Run:  python3 -m unittest discover -s pbx/tests -v
"""
from __future__ import annotations

import contextlib
import io
import os
import pwd
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import portal_config_access as pca  # noqa: E402

# A group that is on every host. The tool takes the group as an input
# (`--pbx-group`), so a test group is honest rather than a special case.
GROUP = "root"
GROUP_GID = pwd.getpwnam("root").pw_gid
PORTAL_UID = 1001
PORTAL_GID = 1000


class JudgeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="portal-access-")
        self.path = os.path.join(self.tmp, pca.PORTAL_FILES[0])

    def _make(self, mode: int, gid: int = GROUP_GID) -> None:
        with open(self.path, "w", encoding="utf-8") as fh:
            fh.write("[101](+)\n")
        os.chmod(self.path, mode)
        try:
            os.chown(self.path, 0, gid)
        except PermissionError:  # a non-root test run: the mode still decides
            pass

    def test_a_missing_file_is_not_drift(self):
        # The portal creates it on first write and the directory is
        # group-writable, so "not written yet" is a real state, not a fault.
        writable, detail = pca.judge(self.path, PORTAL_UID, {GROUP_GID}, GROUP_GID)
        self.assertTrue(writable)
        self.assertIn("not written yet", detail)

    def test_the_measured_failure_is_refused(self):
        # `fwconsole chown`'s framework rule, as it lands on a file: 0664
        # asterisk:asterisk (the `rdir` rule strips the execute bit for files).
        # uid 1001 holds no write bit and is not in the group — the live state.
        self._make(0o664)
        writable, detail = pca.judge(self.path, PORTAL_UID, {PORTAL_GID}, GROUP_GID)
        self.assertFalse(writable)
        self.assertIn("no write bit", detail)

    def test_the_portals_own_gid_on_the_file_is_what_makes_it_writable(self):
        # The fix: the file is owned by the portal's PRIMARY gid, which is what
        # survives the entrypoint's `su-exec nextjs:nodejs`.
        self._make(0o664, gid=PORTAL_GID)
        writable, _ = pca.judge(self.path, PORTAL_UID, {PORTAL_GID}, PORTAL_GID)
        self.assertTrue(writable)

    def test_a_supplementary_grant_is_not_counted(self):
        # The trap this tool exists to not fall into: a compose `group_add`
        # grant is discarded by `su-exec`, so a judgement that counted it would
        # report a state the server is not in.
        self._make(0o664, gid=GROUP_GID)
        writable, detail = pca.judge(self.path, PORTAL_UID, {PORTAL_GID}, PORTAL_GID)
        self.assertFalse(writable)
        self.assertIn("no write bit", detail)

    def test_a_0775_file_is_not_writable_without_membership_either(self):
        self._make(0o775)
        writable, _ = pca.judge(self.path, PORTAL_UID, {PORTAL_GID}, GROUP_GID)
        self.assertFalse(writable)

    def test_the_group_bit_alone_is_not_enough_without_membership(self):
        self._make(0o644)
        writable, _ = pca.judge(self.path, PORTAL_UID, {PORTAL_GID}, GROUP_GID)
        self.assertFalse(writable)

    def test_a_portal_owned_file_needs_no_group_grant(self):
        self._make(0o644)
        writable, detail = pca.judge(self.path, 0, {PORTAL_GID}, GROUP_GID)
        self.assertTrue(writable)
        self.assertIn("owned by the portal", detail)

    def test_world_writable_is_accepted_but_named(self):
        self._make(0o666)
        writable, detail = pca.judge(self.path, PORTAL_UID, {PORTAL_GID}, GROUP_GID)
        self.assertTrue(writable)
        self.assertIn("world-writable", detail)


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


class ConvergeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="portal-access-")
        self.path = os.path.join(self.tmp, pca.PORTAL_FILES[1])
        with open(self.path, "w", encoding="utf-8") as fh:
            fh.write("[101](+)\nmedia_address=192.168.1.30\n")
        os.chmod(self.path, 0o664)

    def test_it_moves_the_group_to_the_portals_own(self):
        # The load-bearing change: `fwconsole chown` sets the group to
        # `asterisk`, which the portal cannot use after `su-exec`.
        changed, detail = pca.converge(self.path, PORTAL_GID)
        self.assertTrue(changed, detail)
        self.assertEqual(os.stat(self.path).st_gid, PORTAL_GID)
        self.assertEqual(os.stat(self.path).st_mode & 0o777, 0o664)

    def test_a_file_already_in_the_portals_group_is_a_no_op(self):
        os.chown(self.path, -1, PORTAL_GID)
        changed, detail = pca.converge(self.path, PORTAL_GID)
        self.assertFalse(changed, detail)

    def test_it_adds_only_the_group_write_bit(self):
        os.chmod(self.path, 0o644)
        changed, _ = pca.converge(self.path, PORTAL_GID)
        self.assertTrue(changed)
        self.assertEqual(os.stat(self.path).st_mode & 0o777, 0o664)

    def test_a_tightened_file_is_not_published(self):
        # 0600 is an operator's decision; adding group-write must not add
        # group- or world-read.
        os.chmod(self.path, 0o600)
        pca.converge(self.path, PORTAL_GID)
        self.assertEqual(os.stat(self.path).st_mode & 0o777, 0o620)

    def test_a_missing_file_is_reported_not_created(self):
        # The portal creates it; a tool that created it here would write an
        # empty PJSIP file the PBX then loads.
        changed, detail = pca.converge(os.path.join(self.tmp, "nope.conf"), PORTAL_GID)
        self.assertFalse(changed)
        self.assertIn("not written yet", detail)


class MainTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="portal-access-")
        for name in pca.PORTAL_FILES:
            path = os.path.join(self.tmp, name)
            with open(path, "w", encoding="utf-8") as fh:
                fh.write("; x\n")
            os.chmod(path, 0o644)
            try:
                os.chown(path, 0, GROUP_GID)
            except PermissionError:
                pass

    def _run(self, *args: str) -> tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = pca.main(list(args))
        return rc, out.getvalue(), err.getvalue()

    def _base(self, *extra: str) -> list[str]:
        return ["--asterisk-dir", self.tmp, "--pbx-group", GROUP,
                "--portal-uid", str(PORTAL_UID), "--portal-gid", str(PORTAL_GID),
                *extra]

    def test_a_644_box_is_drift_and_check_writes_nothing(self):
        rc, _, err = self._run(*self._base("--check", "--portal-groups", str(PORTAL_GID)))
        self.assertEqual(rc, 1)
        self.assertIn("NOT writable", err)
        self.assertEqual(
            os.stat(os.path.join(self.tmp, pca.PORTAL_FILES[0])).st_mode & 0o777, 0o644
        )

    def test_an_apply_then_a_check_is_in_sync(self):
        rc, _, _ = self._run(*self._base("--apply", "--portal-groups", str(PORTAL_GID)))
        self.assertEqual(rc, 0)
        # The files now carry the portal's own gid, which survives su-exec.
        rc, out, _ = self._run(*self._base("--portal-groups", str(PORTAL_GID)))
        self.assertEqual(rc, 0)
        self.assertIn("writable by the portal", out)

    def test_a_640_file_is_still_drift(self):
        # A file an operator tightened to 0640: the group bit is gone, and the
        # tool says so rather than reporting the group as sufficient.
        for name in pca.PORTAL_FILES:
            os.chmod(os.path.join(self.tmp, name), 0o640)
        rc, _, err = self._run(*self._base("--check", "--portal-groups", str(PORTAL_GID)))
        self.assertEqual(rc, 1)
        self.assertIn("NOT writable", err)

    def test_a_missing_config_dir_is_cannot_tell(self):
        rc, _, err = self._run("--asterisk-dir", os.path.join(self.tmp, "absent"),
                               "--check")
        self.assertEqual(rc, 2)
        self.assertIn("not a directory", err)

    def test_files_that_do_not_exist_yet_are_in_sync(self):
        empty = tempfile.mkdtemp(prefix="portal-access-empty-")
        rc, out, _ = self._run("--asterisk-dir", empty, "--pbx-group", GROUP,
                               "--portal-gid", str(PORTAL_GID), "--check")
        self.assertEqual(rc, 0)
        self.assertIn("not written yet", out)

    def test_no_portal_gid_is_cannot_tell(self):
        # With no gid to grant there is nothing to judge against, so the tool
        # refuses rather than reporting every file as fine.
        rc, _, err = self._run("--asterisk-dir", self.tmp, "--portal-gid", "-1",
                               "--portal-groups", str(PORTAL_GID), "--check")
        self.assertEqual(rc, 2)
        self.assertIn("cannot tell", err)


if __name__ == "__main__":
    unittest.main()
