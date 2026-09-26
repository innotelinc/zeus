#!/usr/bin/env python3
"""The extension-mirror verdict, asserted with no PBX and no portal.

`pbx/extension_mirror.py` notices the one thing no product screen can: a phone
FreePBX has and the portal has never heard of. Its failure is silent by
construction — the line rings, its number answers, and the portal's screens are
not wrong because they say nothing at all — so the judgement is pure and pinned
here rather than only measured on `.30`.

Two things about the contract are worth more than the happy path, and both are
held below:

  * **One direction.** The mirror deliberately carries rows the PBX does not own
    as users (the AvantFax service lines, a demo softphone). Were those reported
    as drift, the check would be permanently red and an operator would learn to
    ignore it — which is the failure every judgement tool in this directory
    exists to avoid.
  * **An unread mirror is not a clean one.** A missing table raises, an empty
    mirror and an empty user list are both "cannot tell", never "in sync".

Run:  python3 -m unittest discover -s pbx/tests -v
"""
from __future__ import annotations

import contextlib
import io
import os
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import extension_mirror as em  # noqa: E402

# Verbatim shape of `SELECT extension, name FROM users` on `.30` (mysql -N -B).
USERS = (
    "12000\tCordless Phone\n"
    "15000\tFax Machine\n"
    "4132643964\tDarnel Hunter\n"
    "4132912045\tWendel\n"
    "4132951200\tGrandmas Place Inc\n"
    "4135612020\tHD Logistics Inc\n"
    "7745057135\tDenovo Credit Corporation\n"
    "8579901777\tUS Agents Inc\n"
)

# The portal's `freepbx_extensions.extension_id` on the same box, verbatim. Note
# what is here and not in USERS: the AvantFax service lines and a demo softphone.
MIRROR = {
    "1001", "12000", "15000", "3291", "3292", "3293", "3294",
    "4132643964", "4132951200", "4135612020", "7745057135", "8579901777",
}


class ParseUsersTest(unittest.TestCase):
    def test_real_table(self):
        users = em.parse_users(USERS)
        self.assertEqual(len(users), 8)
        self.assertEqual(users["4132912045"], "Wendel")

    def test_a_nameless_extension_is_kept(self):
        # It is still an extension. Dropping it would report an estate as
        # mirrored because the lines that could not be named went unjudged.
        self.assertEqual(em.parse_users("4132912045\t\n"), {"4132912045": ""})
        self.assertEqual(em.parse_users("4132912045"), {"4132912045": ""})

    def test_blank_lines_and_a_blank_extension_are_skipped(self):
        self.assertEqual(em.parse_users("\n\n\tSomebody\n"), {})


class JudgeTest(unittest.TestCase):
    def test_the_measured_box_reports_exactly_wendel(self):
        # 4132912045 is the live estate's whole drift: a real FreePBX user and
        # device with no mirror row.
        self.assertEqual(em.judge(em.parse_users(USERS), MIRROR), ["4132912045 (Wendel)"])

    def test_a_portal_row_with_no_pbx_user_is_not_drift(self):
        # 3291-3294 and 1001 are mirror rows and not PBX users. They are the
        # estate's fax service and a demo softphone, and reporting them would
        # make the check permanently red.
        users = em.parse_users(USERS)
        self.assertEqual(em.judge(users, MIRROR | {"9999"}), em.judge(users, MIRROR))

    def test_an_unmirrored_extension_without_a_name_is_still_named(self):
        self.assertEqual(em.judge({"4132912045": ""}, MIRROR), ["4132912045"])

    def test_extensions_sort_numerically(self):
        # A string sort puts 10000 before 9999, which reads as a report whose
        # first line is the second-lowest extension number.
        self.assertEqual(em.judge({"10000": "A", "9999": "B"}, set()),
                         ["9999 (B)", "10000 (A)"])

    def test_a_fully_mirrored_box_is_clean(self):
        self.assertEqual(em.judge(em.parse_users(USERS), MIRROR | {"4132912045"}), [])


class MirrorExtensionsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="extension-mirror-")
        self.db = os.path.join(self.tmp, "pbx.db")
        con = sqlite3.connect(self.db)
        con.execute("CREATE TABLE freepbx_extensions (id TEXT, extension_id TEXT, status TEXT)")
        for row in [("a", "12000", "active"), ("b", "3291", "active"),
                    ("c", "4132643964", "released"), ("d", "", "active"),
                    ("e", None, "active")]:
            con.execute("INSERT INTO freepbx_extensions VALUES (?, ?, ?)", row)
        con.commit()
        con.close()

    def test_every_row_counts_whatever_its_status(self):
        # A `released` row still means the portal knows the extension exists, so
        # it is mirrored. Only a row the portal has no record of is drift.
        self.assertEqual(em.mirror_extensions(self.db), {"12000", "3291", "4132643964"})

    def test_a_missing_table_raises_rather_than_reading_as_empty(self):
        empty = os.path.join(self.tmp, "empty.db")
        sqlite3.connect(empty).close()
        with self.assertRaises(sqlite3.Error):
            em.mirror_extensions(empty)


class MainTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="extension-mirror-")
        self.db = os.path.join(self.tmp, "pbx.db")
        con = sqlite3.connect(self.db)
        con.execute("CREATE TABLE freepbx_extensions (id TEXT, extension_id TEXT, status TEXT)")
        con.execute("INSERT INTO freepbx_extensions VALUES ('a', '4132951200', 'active')")
        con.commit()
        con.close()
        self.tsv = os.path.join(self.tmp, "users.tsv")
        with open(self.tsv, "w", encoding="utf-8") as fh:
            fh.write("4132951200\tGrandmas Place Inc\n")

    def _run(self, *args: str) -> tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = em.main(list(args))
        return rc, out.getvalue(), err.getvalue()

    def test_in_sync_exits_zero(self):
        rc, out, _ = self._run("--db", self.db, "--users-tsv", self.tsv, "--check")
        self.assertEqual(rc, 0)
        self.assertIn("every FreePBX extension is in the portal's mirror", out)

    def test_an_unmirrored_extension_exits_one_and_names_it(self):
        with open(self.tsv, "a", encoding="utf-8") as fh:
            fh.write("4132912045\tWendel\n")
        rc, _, err = self._run("--db", self.db, "--users-tsv", self.tsv, "--check")
        self.assertEqual(rc, 1)
        self.assertIn("not in the portal's mirror: 4132912045 (Wendel)", err)

    def test_no_database_is_cannot_tell_not_a_pass(self):
        rc, _, err = self._run("--users-tsv", self.tsv, "--check")
        self.assertEqual(rc, 2)
        self.assertIn("no mirror to judge against", err)

    def test_a_database_that_is_not_there_is_cannot_tell(self):
        rc, _, err = self._run("--db", os.path.join(self.tmp, "absent.db"),
                               "--users-tsv", self.tsv, "--check")
        self.assertEqual(rc, 2)
        self.assertIn("does not exist", err)

    def test_an_empty_mirror_is_cannot_tell_not_a_fully_drifted_box(self):
        empty = os.path.join(self.tmp, "empty.db")
        con = sqlite3.connect(empty)
        con.execute("CREATE TABLE freepbx_extensions (id TEXT, extension_id TEXT, status TEXT)")
        con.commit()
        con.close()
        rc, _, err = self._run("--db", empty, "--users-tsv", self.tsv, "--check")
        self.assertEqual(rc, 2)
        self.assertIn("names no extension in the mirror", err)

    def test_a_pbx_with_no_users_is_cannot_tell_not_a_clean_mirror(self):
        # A PBX whose user table reads empty is a broken measurement or an
        # unprovisioned box; either way a green tick would be a claim this tool
        # cannot support.
        blank = os.path.join(self.tmp, "blank.tsv")
        open(blank, "w", encoding="utf-8").close()
        rc, _, err = self._run("--db", self.db, "--users-tsv", blank, "--check")
        self.assertEqual(rc, 2)
        self.assertIn("names no extension", err)

    def test_an_unreadable_user_table_is_cannot_tell(self):
        rc, _, err = self._run("--db", self.db, "--users-tsv",
                               os.path.join(self.tmp, "absent.tsv"), "--check")
        self.assertEqual(rc, 2)
        self.assertIn("cannot read", err)


if __name__ == "__main__":
    unittest.main()
