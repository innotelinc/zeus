#!/usr/bin/env python3
"""The DID ingress verdict, asserted with no PBX and no portal.

`pbx/dograh_routes.py` is the only thing that notices a DID pointing somewhere
other than a Dograh workflow, and its two failure modes are both *silent* on a
live box — a route that answers as the wrong agent, and a route that answers
nothing at all. Neither shows up as an outage, which is exactly why the judgement
is pure and pinned here rather than only measured on `.30`.

The third verdict — a line the portal marks `fax_enabled` that answers as the fax
service — is pinned for the opposite reason: it is the one *correct* destination
that is not a workflow, and the flag cannot be trusted to excuse more than that.
Measured on the estate, the Denovo interview line is fax-enabled and reaches
`dograh-inbound,8005,1`.

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
import dograh_routes as dr  # noqa: E402

# Verbatim shape of `SELECT extension, destination FROM incoming` on `.30`
# (mysql -N -B), after the AVA router was removed.
INCOMING = (
    "\tdograh-inbound,8003,1\n"
    "4132643964\tdograh-inbound,8000,1\n"
    "4132951200\tdograh-inbound,8003,1\n"
    "4138808180\tfrom-did-direct,4132912045,1\n"
    "7745057135\tdograh-inbound,8005,1\n"
    "7745057136\text-group,329,1\n"
    "8003\tdograh-inbound,8003,1\n"
)


class NormaliseDidTest(unittest.TestCase):
    def test_ten_digits_pass_through(self):
        self.assertEqual(dr.normalise_did("4132951200"), "4132951200")

    def test_a_leading_country_code_is_dropped(self):
        # The portal stores this one as 13025551002 and FreePBX as 3025551002;
        # comparing them raw reports a healthy route as missing.
        self.assertEqual(dr.normalise_did("13025551002"), "3025551002")

    def test_formatting_is_stripped(self):
        self.assertEqual(dr.normalise_did("+1 (413) 295-1200"), "4132951200")

    def test_empty_is_empty(self):
        self.assertEqual(dr.normalise_did(""), "")


class ParseIncomingTest(unittest.TestCase):
    def test_real_table(self):
        routes = dr.parse_incoming(INCOMING)
        self.assertEqual(routes["4132643964"], "dograh-inbound,8000,1")
        self.assertEqual(routes["7745057136"], "ext-group,329,1")

    def test_the_blank_extension_is_the_catch_all(self):
        # Kept under "" rather than dropped: "unrouted DIDs land here" is a fact
        # the report has to be able to state.
        self.assertEqual(dr.parse_incoming(INCOMING)[""], "dograh-inbound,8003,1")

    def test_blank_lines_and_short_rows_are_skipped(self):
        self.assertEqual(dr.parse_incoming("\n\nno-tabs-here\n"), {})

    def test_a_did_is_keyed_normalised(self):
        self.assertIn("7745057135", dr.parse_incoming("7745057135\tdograh-inbound,8005,1\n"))


class WorkflowOfTest(unittest.TestCase):
    def test_a_workflow_destination_is_named(self):
        self.assertEqual(dr.workflow_of("dograh-inbound,8003,1"), "8003")

    def test_another_context_is_not_a_workflow(self):
        self.assertEqual(dr.workflow_of("from-did-direct,4132912045,1"), "")
        self.assertEqual(dr.workflow_of("ext-group,329,1"), "")

    def test_the_bare_context_is_not_a_workflow(self):
        self.assertEqual(dr.workflow_of("dograh-inbound"), "")


class JudgeTest(unittest.TestCase):
    def test_every_did_on_a_workflow_is_clean(self):
        routes = dr.parse_incoming(INCOMING)
        self.assertEqual(dr.judge(["4132643964", "4132951200"], routes), ([], [], []))

    def test_a_did_ringing_its_own_extension_is_reported(self):
        # The live state before this was fixed: from-did-direct precedes the
        # catch-all, so the line rang the customer's own phone.
        routes = dr.parse_incoming("4132951200\tfrom-did-direct,4132951200,1\n")
        off, missing, faxed = dr.judge(["4132951200"], routes)
        self.assertEqual((missing, faxed), ([], []))
        self.assertEqual(off, ["4132951200 -> from-did-direct,4132951200,1"])

    def test_a_did_with_no_row_is_reported_separately(self):
        off, missing, _ = dr.judge(["8579901777"], dr.parse_incoming(INCOMING))
        self.assertEqual(off, [])
        self.assertEqual(missing, ["8579901777"])

    def test_the_catch_all_does_not_count_as_in_sync(self):
        # A DID with no row of its own answers as whatever the catch-all names,
        # which is the silent-wrong-agent failure — not a healthy ingress.
        routes = dr.parse_incoming(INCOMING)
        _, missing, _ = dr.judge(["3025551002"], routes)
        self.assertEqual(missing, ["3025551002"])

    def test_a_fax_line_answering_as_the_fax_service_is_left_alone(self):
        # `7745057136` is the estate's fax DID: `ext-group,329,1` is the fax
        # service, and the portal marks the line fax_enabled.
        routes = dr.parse_incoming(INCOMING)
        off, missing, faxed = dr.judge(["7745057136"], routes, {"7745057136"})
        self.assertEqual((off, missing), ([], []))
        self.assertEqual(faxed, ["7745057136 -> ext-group,329,1"])

    def test_without_the_flag_the_same_route_is_drift(self):
        # The flag is the whole difference: the estate's other group route is a
        # partner's phone service, and it is reported.
        routes = dr.parse_incoming(INCOMING)
        off, _, faxed = dr.judge(["7745057136"], routes)
        self.assertEqual(faxed, [])
        self.assertEqual(off, ["7745057136 -> ext-group,329,1"])

    def test_the_fax_flag_does_not_excuse_an_extension(self):
        # Measured: the Denovo interview line is fax_enabled *and* carries a
        # workflow. Were the flag read as "not a voice line", a fax-marked line
        # pointed at `from-did-direct` on a voice line would stop being
        # reported — which is the silent wrong-agent case this tool exists for.
        routes = dr.parse_incoming("7745057135\tfrom-did-direct,7745057135,1\n")
        off, _, faxed = dr.judge(["7745057135"], routes, {"7745057135"})
        self.assertEqual(faxed, [])
        self.assertEqual(off, ["7745057135 -> from-did-direct,7745057135,1"])

    def test_a_fax_line_with_no_row_is_still_unrouted(self):
        # A fax number answered by the catch-all is as wrong as an agent
        # answered by fax, so the flag does not buy it a row.
        _, missing, faxed = dr.judge(["7745057136"], dr.parse_incoming(""), {"7745057136"})
        self.assertEqual((missing, faxed), (["7745057136"], []))


class PlatformDidsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="dograh-routes-")
        self.db = os.path.join(self.tmp, "pbx.db")
        con = sqlite3.connect(self.db)
        con.execute("CREATE TABLE phone_numbers (user_id TEXT, did TEXT, status TEXT, fax_enabled INTEGER)")
        for n, (did, status, fax) in enumerate(
            [
                ("4132951200", "active", 0),
                ("13025551002", "active", 0),
                ("7745057136", "active", 1),
                ("7745057137", "released", 0),
            ]
        ):
            con.execute("INSERT INTO phone_numbers VALUES (?, ?, ?, ?)", (f"u{n}", did, status, fax))
        con.commit()
        con.close()

    def test_only_active_dids_are_judged_and_normalised(self):
        self.assertEqual(
            dr.platform_dids(self.db),
            {"3025551002": False, "4132951200": False, "7745057136": True},
        )

    def test_two_spellings_of_one_line_are_one_line_and_fax_wins(self):
        # 13025551002 and 3025551002 name the same line. A "no" from one
        # spelling must not erase a "yes" from the other.
        con = sqlite3.connect(self.db)
        con.execute("UPDATE phone_numbers SET fax_enabled = 1 WHERE did = '13025551002'")
        con.commit()
        con.close()
        self.assertTrue(dr.platform_dids(self.db)["3025551002"])

    def test_a_missing_table_raises_rather_than_reading_as_clean(self):
        empty = os.path.join(self.tmp, "empty.db")
        sqlite3.connect(empty).close()
        with self.assertRaises(sqlite3.Error):
            dr.platform_dids(empty)


class MainTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="dograh-routes-")
        self.db = os.path.join(self.tmp, "pbx.db")
        con = sqlite3.connect(self.db)
        con.execute("CREATE TABLE phone_numbers (user_id TEXT, did TEXT, status TEXT, fax_enabled INTEGER)")
        con.execute("INSERT INTO phone_numbers VALUES ('u1', '4132951200', 'active', 0)")
        con.commit()
        con.close()
        self.tsv = os.path.join(self.tmp, "incoming.tsv")
        with open(self.tsv, "w", encoding="utf-8") as fh:
            fh.write("4132951200\tdograh-inbound,8003,1\tdescription\n")

    def _run(self, *args: str) -> tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = dr.main(list(args))
        return rc, out.getvalue(), err.getvalue()

    def test_in_sync_exits_zero(self):
        rc, out, _ = self._run("--db", self.db, "--incoming-tsv", self.tsv, "--check")
        self.assertEqual(rc, 0)
        self.assertIn("every platform DID reaches", out)

    def test_a_fax_line_left_alone_is_named_and_does_not_change_the_exit_code(self):
        con = sqlite3.connect(self.db)
        con.execute("INSERT INTO phone_numbers VALUES ('u2', '7745057136', 'active', 1)")
        con.commit()
        con.close()
        with open(self.tsv, "a", encoding="utf-8") as fh:
            fh.write("7745057136\text-group,329,1\n")
        rc, out, err = self._run("--db", self.db, "--incoming-tsv", self.tsv, "--check")
        self.assertEqual(rc, 0)
        self.assertIn("fax line, left alone: 7745057136 -> ext-group,329,1", err)
        self.assertIn("1 fax line(s) left alone", out)

    def test_a_did_off_the_workflow_exits_one_and_names_it(self):
        with open(self.tsv, "w", encoding="utf-8") as fh:
            fh.write("4132951200\tfrom-did-direct,4132951200,1\n")
        rc, _, err = self._run("--db", self.db, "--incoming-tsv", self.tsv, "--check")
        self.assertEqual(rc, 1)
        self.assertIn("off the workflow: 4132951200", err)

    def test_no_database_is_cannot_tell_not_a_pass(self):
        rc, _, err = self._run("--incoming-tsv", self.tsv, "--check")
        self.assertEqual(rc, 2)
        self.assertIn("no plan to judge against", err)

    def test_a_database_that_is_not_there_is_cannot_tell(self):
        rc, _, err = self._run("--db", os.path.join(self.tmp, "absent.db"),
                               "--incoming-tsv", self.tsv, "--check")
        self.assertEqual(rc, 2)
        self.assertIn("does not exist", err)

    def test_an_empty_plan_is_cannot_tell_not_a_clean_ingress(self):
        empty = os.path.join(self.tmp, "empty.db")
        con = sqlite3.connect(empty)
        con.execute("CREATE TABLE phone_numbers (user_id TEXT, did TEXT, status TEXT, fax_enabled INTEGER)")
        con.commit()
        con.close()
        rc, _, err = self._run("--db", empty, "--incoming-tsv", self.tsv, "--check")
        self.assertEqual(rc, 2)
        self.assertIn("names no active DID", err)

    def test_an_unreadable_route_table_is_cannot_tell(self):
        rc, _, err = self._run("--db", self.db, "--incoming-tsv",
                               os.path.join(self.tmp, "absent.tsv"), "--check")
        self.assertEqual(rc, 2)
        self.assertIn("cannot read", err)


if __name__ == "__main__":
    unittest.main()
