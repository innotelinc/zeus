#!/usr/bin/env python3
"""The extension-secret verdict, asserted with no PBX and no portal.

`pbx/extension_secret.py` notices the fault that keeps a softphone from
registering while every other screen stays green: the portal row holds no
credential, or one the PBX never rendered, so every REGISTER is a 401 and the
only symptom is a phone that will not come up. Its judgement is pure and pinned
here rather than only measured on `.30`.

Three things about the contract are worth more than the happy path, and all are
held below:

  * **One direction.** The PBX renders no `[<ext>-auth]` for the AvantFax service
    lines (`3291`–`3294`, IAX2 modems), and a portal row with a secret and no
    PBX credential is that line, not drift. Reporting it would make the check
    permanently red on the estate's own fax service.
  * **The rendered file is authoritative, first file wins.** A hand-written
    `pjsip_custom.conf` may carry a credential FreePBX does not render; where
    both do, it is the generated `pjsip.auth.conf` the PBX will accept.
  * **An unread credential is not a match.** A missing table, an empty portal, a
    PBX that renders nothing at all, an unreadable dump — each is "cannot tell",
    never "in sync".

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
import extension_secret as es  # noqa: E402

# Verbatim shape of a rendered `pjsip.auth.conf` (the measured estate).
AUTH_CONF = (
    "[4132643964-auth]\n"
    "type=auth\n"
    "auth_type=userpass\n"
    "password=DD@l1lama\n"
    "username=4132643964\n"
    "\n"
    "[4132912045-auth]\n"
    "type=auth\n"
    "auth_type=userpass\n"
    "password=rendered-by-freepbx-not-a-real-secret\n"
    "username=4132912045\n"
    "\n"
    "[101-auth]\n"
    "type=auth\n"
    "password=101secret\n"
)


class RenderedSecretsTest(unittest.TestCase):
    def test_parses_the_auth_sections(self):
        self.assertEqual(es.parse_auth_conf(AUTH_CONF),
                         {"4132643964": "DD@l1lama",
                          "4132912045": "rendered-by-freepbx-not-a-real-secret",
                          "101": "101secret"})

    def test_a_non_auth_section_does_not_leak_a_password(self):
        # `[<ext>-aor]` is not a credential. Reading one would report a working
        # endpoint as secretless — or, worse, as holding the wrong secret.
        text = "[4132912045-aor]\npassword=not-a-credential\n"
        self.assertEqual(es.parse_auth_conf(text), {})

    def test_a_hand_written_file_only_supplies_what_the_generated_one_does_not(self):
        # The generated file is authoritative; first file wins.
        merged = es.rendered_secrets({
            "pjsip.auth.conf": "[12000-auth]\npassword=generated\n",
            "pjsip_custom.conf": "[12000-auth]\npassword=hand-written\n[9999-auth]\npassword=only-here\n",
        })
        self.assertEqual(merged, {"12000": "generated", "9999": "only-here"})

    def test_a_file_that_is_not_there_supplies_nothing(self):
        # The generated file alone, with no hand-written file beside it, is the
        # ordinary shape on this estate.
        self.assertEqual(es.rendered_secrets({"pjsip.auth.conf": AUTH_CONF}),
                         {"4132643964": "DD@l1lama",
                          "4132912045": "rendered-by-freepbx-not-a-real-secret",
                          "101": "101secret"})


class JudgeTest(unittest.TestCase):
    def test_the_measured_estate_after_a_repair_is_clean(self):
        portal = {"4132643964": "DD@l1lama",
                  "4132912045": "rendered-by-freepbx-not-a-real-secret",
                  "3291": "329fax"}
        self.assertEqual(es.judge(portal, es.parse_auth_conf(AUTH_CONF)), [])

    def test_the_measured_estate_before_a_repair_names_wendel(self):
        # The live drift this tool was written for: the portal adopted the
        # extension with no secret while the PBX renders one.
        portal = {"4132643964": "DD@l1lama", "4132912045": None}
        self.assertEqual(es.judge(portal, es.parse_auth_conf(AUTH_CONF)),
                         [("4132912045", es.MISSING)])

    def test_a_secret_the_pbx_does_not_render_is_drift(self):
        portal = {"4132912045": "portal-invented"}
        self.assertEqual(es.judge(portal, es.parse_auth_conf(AUTH_CONF)),
                         [("4132912045", es.DIFFERS)])

    def test_a_portal_secret_with_no_pbx_credential_is_not_drift(self):
        # 3291-3294 are IAX2 modems: no auth section will ever exist, and the
        # portal's own secret for them is the right one.
        portal = {"3291": "329fax", "3292": "329fax"}
        self.assertEqual(es.judge(portal, es.parse_auth_conf(AUTH_CONF)), [])

    def test_no_credential_anywhere_is_named(self):
        # Not drift between two sources — a line nothing can register, which is
        # a phone the accounting owner cannot use.
        portal = {"4132912045": None, "4132643964": None}
        self.assertEqual(es.judge(portal, {}),
                         [("4132643964", es.UNREGISTERABLE),
                          ("4132912045", es.UNREGISTERABLE)])

    def test_findings_sort_numerically(self):
        portal = {"4132912045": None, "3291": None}
        self.assertEqual(es.judge(portal, {}),
                         [("3291", es.UNREGISTERABLE),
                          ("4132912045", es.UNREGISTERABLE)])

    def test_describe_names_the_extension_and_the_repair(self):
        self.assertIn("4132912045", es.describe(("4132912045", es.MISSING)))
        self.assertIn("Repair adopts it", es.describe(("4132912045", es.MISSING)))


class PortalSecretsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="extension-secret-")
        self.db = os.path.join(self.tmp, "pbx.db")
        con = sqlite3.connect(self.db)
        con.execute("CREATE TABLE freepbx_extensions "
                    "(id TEXT, extension_id TEXT, extension_secret TEXT, status TEXT)")
        for row in [("a", "12000", "DD@l1lama", "active"),
                    ("b", "3291", "329fax", "active"),
                    ("c", "4132912045", None, "active"),
                    ("d", "", "x", "active"),
                    ("e", None, "y", "active")]:
            con.execute("INSERT INTO freepbx_extensions VALUES (?, ?, ?, ?)", row)
        con.commit()
        con.close()

    def test_every_row_counts_whatever_its_status(self):
        # A `released` row is still a row the portal would hand a softphone.
        self.assertEqual(set(es.portal_secrets(self.db)), {"12000", "3291", "4132912045"})

    def test_a_missing_secret_reads_as_none_not_as_absent(self):
        self.assertIsNone(es.portal_secrets(self.db)["4132912045"])

    def test_a_missing_table_raises_rather_than_reading_as_empty(self):
        empty = os.path.join(self.tmp, "empty.db")
        sqlite3.connect(empty).close()
        with self.assertRaises(sqlite3.Error):
            es.portal_secrets(empty)


class MainTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="extension-secret-")
        self.db = os.path.join(self.tmp, "pbx.db")
        con = sqlite3.connect(self.db)
        con.execute("CREATE TABLE freepbx_extensions "
                    "(id TEXT, extension_id TEXT, extension_secret TEXT, status TEXT)")
        con.execute("INSERT INTO freepbx_extensions VALUES ('a', '4132643964', 'DD@l1lama', 'active')")
        con.commit()
        con.close()
        self.auth = os.path.join(self.tmp, "pjsip.auth.conf")
        with open(self.auth, "w", encoding="utf-8") as handle:
            handle.write(AUTH_CONF)

    def _run(self, *args: str) -> tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = es.main(list(args))
        return rc, out.getvalue(), err.getvalue()

    def test_in_sync_exits_zero(self):
        rc, out, _ = self._run("--db", self.db, "--auth-conf", self.auth, "--check")
        self.assertEqual(rc, 0)
        self.assertIn("every portal extension holds the secret the PBX renders", out)

    def test_a_missing_secret_exits_one_and_names_the_extension(self):
        con = sqlite3.connect(self.db)
        con.execute("INSERT INTO freepbx_extensions VALUES ('b', '4132912045', NULL, 'active')")
        con.commit()
        con.close()
        rc, _, err = self._run("--db", self.db, "--auth-conf", self.auth, "--check")
        self.assertEqual(rc, 1)
        self.assertIn("4132912045", err)
        self.assertIn("Repair adopts it", err)

    def test_no_database_is_cannot_tell_not_a_pass(self):
        rc, _, err = self._run("--auth-conf", self.auth, "--check")
        self.assertEqual(rc, 2)
        self.assertIn("no --db given", err)

    def test_a_database_that_is_not_there_is_cannot_tell(self):
        rc, _, err = self._run("--db", os.path.join(self.tmp, "absent.db"),
                               "--auth-conf", self.auth, "--check")
        self.assertEqual(rc, 2)
        self.assertIn("does not exist", err)

    def test_an_empty_portal_is_cannot_tell_not_a_clean_estate(self):
        empty = os.path.join(self.tmp, "empty.db")
        con = sqlite3.connect(empty)
        con.execute("CREATE TABLE freepbx_extensions "
                    "(id TEXT, extension_id TEXT, extension_secret TEXT, status TEXT)")
        con.commit()
        con.close()
        rc, _, err = self._run("--db", empty, "--auth-conf", self.auth, "--check")
        self.assertEqual(rc, 2)
        self.assertIn("names no extension", err)

    def test_an_unreadable_auth_conf_is_cannot_tell(self):
        rc, _, err = self._run("--db", self.db, "--auth-conf",
                               os.path.join(self.tmp, "absent.conf"), "--check")
        self.assertEqual(rc, 2)
        self.assertIn("cannot read", err)

    def test_a_pbx_that_renders_no_credential_is_cannot_tell(self):
        # A blank comparison would report every extension as fine. Refuse.
        blank = os.path.join(self.tmp, "blank.conf")
        with open(blank, "w", encoding="utf-8") as handle:
            handle.write("; nothing but comments\n")
        rc, _, err = self._run("--db", self.db, "--auth-conf", blank, "--check")
        self.assertEqual(rc, 2)
        self.assertIn("renders no credential at all", err)


if __name__ == "__main__":
    unittest.main()
