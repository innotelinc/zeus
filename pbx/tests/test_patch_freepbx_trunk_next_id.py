#!/usr/bin/env python3
"""Unit tests for pbx/patch-freepbx-trunk-next-id.py.

The patch edits PHP we do not own, so the tests care about two things: that the
*behaviour* it installs actually prevents the duplicate-key write, and that it
refuses to touch a file it does not recognise instead of rewriting it blind.

Run:  python3 -m unittest discover -s pbx/tests -v
"""
import importlib.util
import os
import sys
import tempfile
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_PATCHER = os.path.join(_HERE, "..", "patch-freepbx-trunk-next-id.py")

# The module name has hyphens, so it cannot be imported by name.
_spec = importlib.util.spec_from_file_location("trunk_next_id_patch", _PATCHER)
pt = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pt)

HUNK_NEXT_ID = pt.HUNKS[0]
HUNK_PJSIP = pt.HUNKS[1]


def _fixture(hunk, before="", after=""):
    """A minimal file containing the hunk's original block, in context."""
    return before + hunk["original"] + after


NEXT_ID_FILE = _fixture(
    HUNK_NEXT_ID,
    before="    public function addTrunk($name, $tech, $settings, $editmode=false) {\n"
           "        if (!$editmode) {\n",
    after="        } else {\n            $trunknum = $settings['trunknum'];\n        }\n",
)

PJSIP_FILE = _fixture(
    HUNK_PJSIP,
    before="\tpublic function addTrunk($trunknum, $settings) {\n",
    after="\t\t\t$ins->bindParam(':keyword', $k);\n"
          "\t\t\t$ins->bindParam(':data', $v);\n"
          "\t\t\t$ins->execute();\n\t\t}\n\t}\n",
)


class NextIdSemanticsTest(unittest.TestCase):
    """What hunk 1 computes — mirrored in Python so it is testable."""

    def test_empty_estate_starts_at_one(self):
        self.assertEqual(pt.next_trunk_id([]), 1)

    def test_id_zero_does_not_shift_the_answer(self):
        """The whole bug: id 0 must not make id 1 look free."""
        self.assertEqual(pt.next_trunk_id([0]), 1)
        self.assertEqual(pt.next_trunk_id([0, 1, 2, 3, 4]), 5)

    def test_occupied_ids_are_skipped(self):
        self.assertEqual(pt.next_trunk_id([1]), 2)
        self.assertEqual(pt.next_trunk_id([1, 2]), 3)

    def test_gap_is_reused_not_skipped(self):
        self.assertEqual(pt.next_trunk_id([0, 2, 3]), 1)

    def test_the_estate_state_that_caused_the_bug(self):
        """Live trunk ids are 0,1,2 — an add must land on 3, never 1."""
        self.assertEqual(pt.next_trunk_id([0, 1, 2]), 3)

    def test_string_ids_from_the_database_are_handled(self):
        self.assertEqual(pt.next_trunk_id(["0", "1", "2"]), 3)

    def test_negative_and_id_zero_are_ignored(self):
        self.assertEqual(pt.next_trunk_id([0, -1]), 1)
        self.assertEqual(pt.next_trunk_id([0, -1, 1]), 2)


class ApplyNextIdTest(unittest.TestCase):
    def test_patches_the_shipped_loop(self):
        out = pt.apply_hunk(HUNK_NEXT_ID, NEXT_ID_FILE)
        self.assertTrue(pt.is_applied(HUNK_NEXT_ID, out))
        self.assertIn("$used[$trunknum]", out)

    def test_is_idempotent(self):
        once = pt.apply_hunk(HUNK_NEXT_ID, NEXT_ID_FILE)
        self.assertEqual(pt.apply_hunk(HUNK_NEXT_ID, once), once)

    def test_surrounding_php_is_preserved(self):
        out = pt.apply_hunk(HUNK_NEXT_ID, NEXT_ID_FILE)
        self.assertIn("public function addTrunk", out)
        self.assertIn("$trunknum = $settings['trunknum'];", out)

    def test_refuses_an_unrecognised_file(self):
        with self.assertRaises(pt.PatchError):
            pt.apply_hunk(HUNK_NEXT_ID, "<?php\n// some other version entirely\n")

    def test_refusal_names_the_hunk_and_the_file(self):
        try:
            pt.apply_hunk(HUNK_NEXT_ID, "<?php\n")
        except pt.PatchError as exc:
            self.assertIn("trunk-next-id", str(exc))
            self.assertIn("Core.class.php", str(exc))
        else:  # pragma: no cover - guarded by the assertion above
            self.fail("expected PatchError")


class ApplyPjsipWriteTest(unittest.TestCase):
    """Hunk 2 must make the write clear-then-insert, and keep the insert."""

    def test_delete_precedes_the_insert(self):
        out = pt.apply_hunk(HUNK_PJSIP, PJSIP_FILE)
        self.assertTrue(pt.is_applied(HUNK_PJSIP, out))
        delete_at = out.index("DELETE FROM `pjsip`")
        insert_at = out.index("INSERT INTO `pjsip`")
        self.assertLess(delete_at, insert_at)

    def test_the_insert_itself_is_untouched(self):
        out = pt.apply_hunk(HUNK_PJSIP, PJSIP_FILE)
        self.assertIn(
            "INSERT INTO `pjsip` (`id`, `keyword`, `data`, `flags`) "
            "VALUES ( $trunknum, :keyword, :data, 0 )",
            out,
        )

    def test_the_loop_body_is_untouched(self):
        """The stack trace must still end at the same three lines."""
        out = pt.apply_hunk(HUNK_PJSIP, PJSIP_FILE)
        self.assertIn("$ins->bindParam(':data', $v);\n\t\t\t$ins->execute();", out)

    def test_deletes_by_the_parameter_not_by_interpolation(self):
        out = pt.apply_hunk(HUNK_PJSIP, PJSIP_FILE)
        self.assertIn("`id` = :trunknum", out)
        self.assertIn("array(':trunknum' => $trunknum)", out)

    def test_is_idempotent(self):
        once = pt.apply_hunk(HUNK_PJSIP, PJSIP_FILE)
        self.assertEqual(pt.apply_hunk(HUNK_PJSIP, once), once)

    def test_refuses_an_unrecognised_file(self):
        with self.assertRaises(pt.PatchError):
            pt.apply_hunk(HUNK_PJSIP, "<?php\n")


class HunkDeclarationTest(unittest.TestCase):
    """The two hunks must stay separate and independently applicable."""

    def test_two_distinct_hunks_on_distinct_files(self):
        self.assertEqual(len(pt.HUNKS), 2)
        self.assertNotEqual(HUNK_NEXT_ID["file"], HUNK_PJSIP["file"])

    def test_markers_are_absent_from_the_originals(self):
        for hunk in pt.HUNKS:
            self.assertNotIn(hunk["marker"], hunk["original"])

    def test_every_patch_adds_text(self):
        """A patch that changed nothing could silently no-op."""
        for hunk in pt.HUNKS:
            self.assertGreater(len(hunk["patched"]), len(hunk["original"]))
            self.assertNotEqual(hunk["patched"], hunk["original"])

    def test_each_hunk_actually_changes_a_file_holding_it(self):
        for hunk, fixture in ((HUNK_NEXT_ID, NEXT_ID_FILE), (HUNK_PJSIP, PJSIP_FILE)):
            self.assertNotEqual(pt.apply_hunk(hunk, fixture), fixture)

    def test_each_marker_appears_in_its_own_patch(self):
        for hunk in pt.HUNKS:
            self.assertIn(hunk["marker"], hunk["patched"])


class CliTest(unittest.TestCase):
    def _write(self, text):
        fd, path = tempfile.mkstemp(suffix=".php")
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(text)
        self.addCleanup(os.unlink, path)
        return path

    def _read(self, path):
        with open(path, encoding="utf-8") as fh:
            return fh.read()

    def test_check_reports_drift_without_writing(self):
        path = self._write(NEXT_ID_FILE)
        before = self._read(path)
        rc = pt.main(["--file", path, "--hunk", "trunk-next-id", "--check"])
        self.assertEqual(rc, 1)
        self.assertEqual(self._read(path), before)

    def test_patch_writes_and_backs_up(self):
        path = self._write(NEXT_ID_FILE)
        with tempfile.TemporaryDirectory() as backups:
            rc = pt.main(["--file", path, "--hunk", "trunk-next-id", "--backup-dir", backups])
            self.assertEqual(rc, 0)
            self.assertTrue(pt.is_applied(HUNK_NEXT_ID, self._read(path)))
            self.assertEqual(len(os.listdir(backups)), 1)

    def test_rerun_is_a_no_op_and_does_not_re_backup(self):
        path = self._write(NEXT_ID_FILE)
        with tempfile.TemporaryDirectory() as backups:
            args = ["--file", path, "--hunk", "trunk-next-id", "--backup-dir", backups]
            pt.main(args)
            self.assertEqual(pt.main(args), 0)
            self.assertEqual(len(os.listdir(backups)), 1)

    def test_check_passes_once_applied(self):
        path = self._write(pt.apply_hunk(HUNK_NEXT_ID, NEXT_ID_FILE))
        self.assertEqual(pt.main(["--file", path, "--hunk", "trunk-next-id", "--check"]), 0)

    def test_unrecognised_file_exits_nonzero_and_leaves_it_alone(self):
        path = self._write("<?php\n// unknown\n")
        with tempfile.TemporaryDirectory() as backups:
            rc = pt.main(["--file", path, "--hunk", "trunk-next-id", "--backup-dir", backups])
            self.assertEqual(rc, 1)
            self.assertEqual(self._read(path), "<?php\n// unknown\n")

    def test_missing_file_is_reported(self):
        rc = pt.main(["--file", "/nonexistent/Core.class.php", "--hunk", "trunk-next-id"])
        self.assertEqual(rc, 2)

    def test_file_without_a_single_hunk_is_rejected(self):
        path = self._write(NEXT_ID_FILE)
        self.assertEqual(pt.main(["--file", path]), 2)


if __name__ == "__main__":
    sys.exit(unittest.main())
