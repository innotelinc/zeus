#!/usr/bin/env python3
"""`pbx/dograh_bindings.py` without a PBX or an engine.

The tool exists because the portal's binding and FreePBX's route are two stores
with no writer between them, so the interesting cases are the resolutions and the
refusals, not the write:

  * a binding is a *workflow* — the id or the name the Voice screen stores — and
    the dialplan entry is that workflow's *number*, read from the engine because
    it is not arithmetic (`8008` is workflow 10);
  * a binding the engine has no number for is refused **by name** rather than
    guessed at, because a wrong guess re-points a customer's number at somebody
    else's agent;
  * a DID with no `incoming` row is a person's job, not this tool's — inventing
    FreePBX's other fourteen columns is how a route ends up half-formed.

The CLI cases run the real script with `--numbers-tsv`/`--incoming-tsv`, so the
whole judgement is rehearsed with no container at all.

Run:  python3 -m unittest discover -s pbx/tests -v
"""

from __future__ import annotations

import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import dograh_bindings as db  # noqa: E402

SCRIPT = os.path.join(os.path.dirname(HERE), "dograh_bindings.py")

NUMBERS = "1\tIT Help Desk Mock Interview\t8000\n4\tBusiness Receptionist\t8003\n10\tFull Stack Developer\t8008\n"


class Reading(unittest.TestCase):
    def test_the_mapping_is_read_by_id_and_by_name(self):
        by_id, by_name = db.parse_numbers(NUMBERS)
        self.assertEqual(by_id, {"1": "8000", "4": "8003", "10": "8008"})
        self.assertEqual(by_name["Business Receptionist"], "8003")

    def test_a_row_without_an_address_contributes_nothing(self):
        by_id, by_name = db.parse_numbers("4\tBusiness Receptionist\t\n7\tSurvey\n")
        self.assertEqual(by_id, {})
        self.assertEqual(by_name, {})

    def test_an_id_wins_over_a_name_spelled_like_one(self):
        """A workflow named `4` must not shadow workflow 4."""
        by_id, by_name = db.parse_numbers("4\tReceptionist\t8003\n9\t4\t8999\n")
        self.assertEqual(db.resolve("4", by_id, by_name), "8003")
        self.assertEqual(db.resolve("9", by_id, by_name), "8999")

    def test_an_unknown_binding_resolves_to_nothing(self):
        by_id, by_name = db.parse_numbers(NUMBERS)
        for binding in ("99", "Philosophy", "", "  "):
            with self.subTest(binding=binding):
                self.assertEqual(db.resolve(binding, by_id, by_name), "")


class Judging(unittest.TestCase):
    def setUp(self):
        self.by_id, self.by_name = db.parse_numbers(NUMBERS)

    def judge(self, bindings, routes):
        return db.judge(bindings, routes, self.by_id, self.by_name)

    def test_a_did_on_the_workflow_its_binding_names_is_in_sync(self):
        in_sync, drift, unresolved = self.judge(
            {"7745057135": "4"}, {"7745057135": "dograh-inbound,8003,1"}
        )
        self.assertEqual(drift, [])
        self.assertEqual(unresolved, [])
        self.assertEqual(in_sync, ["7745057135 -> dograh-inbound,8003,1"])

    def test_a_binding_stored_as_a_name_resolves_the_same_way(self):
        in_sync, drift, _ = self.judge(
            {"7745057135": "Business Receptionist"}, {"7745057135": "dograh-inbound,8003,1"}
        )
        self.assertEqual(drift, [])
        self.assertEqual(len(in_sync), 1)

    def test_a_route_on_another_workflow_is_drift(self):
        _, drift, _ = self.judge({"7745057135": "1"}, {"7745057135": "dograh-inbound,8003,1"})
        self.assertEqual(len(drift), 1)
        self.assertIn("wants dograh-inbound,8000,1", drift[0])

    def test_a_binding_the_engine_cannot_place_is_refused_by_name(self):
        _, drift, unresolved = self.judge(
            {"7745057135": "Philosophy"}, {"7745057135": "dograh-inbound,8003,1"}
        )
        self.assertEqual(drift, [])
        self.assertEqual(len(unresolved), 1)
        self.assertIn("Philosophy", unresolved[0])

    def test_a_did_with_no_row_is_a_person_s_job(self):
        """The tool repoints rows; it never invents one (see the module docstring)."""
        _, drift, unresolved = self.judge({"7745057135": "4"}, {})
        self.assertEqual(drift, [])
        self.assertIn("no inbound route to repoint", unresolved[0])

    def test_a_route_spelled_with_a_leading_one_is_the_same_route(self):
        _, drift, _ = self.judge({"7745057135": "4"}, {"17745057135": "dograh-inbound,8003,1"})
        self.assertEqual(drift, [])


class Cli(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = self._tmp.name
        self.db_path = os.path.join(self.dir, "pbx.db")
        self.numbers = os.path.join(self.dir, "numbers.tsv")
        self.incoming = os.path.join(self.dir, "incoming.tsv")
        with open(self.numbers, "w", encoding="utf-8") as handle:
            handle.write(NUMBERS)

    def _portal(self, bindings):
        con = sqlite3.connect(self.db_path)
        con.execute("CREATE TABLE phone_numbers (did TEXT, status TEXT)")
        con.execute(
            "CREATE TABLE voice_bindings (user_id TEXT, did TEXT, capstone_binding TEXT)"
        )
        for did, binding in bindings:
            con.execute("INSERT INTO phone_numbers VALUES (?, 'active')", (did,))
            con.execute(
                "INSERT INTO voice_bindings VALUES ('u', ?, ?)", (did, binding)
            )
        con.commit()
        con.close()

    def _incoming(self, text):
        with open(self.incoming, "w", encoding="utf-8") as handle:
            handle.write(text)

    def _run(self, *args):
        proc = subprocess.run(
            [sys.executable, SCRIPT, "--db", self.db_path,
             "--numbers-tsv", self.numbers, "--incoming-tsv", self.incoming, *args],
            capture_output=True, text=True,
        )
        return proc.returncode, proc.stdout, proc.stderr

    def test_a_bound_did_on_its_workflow_exits_zero(self):
        self._portal([("4132643964", "4")])
        self._incoming("4132643964\tdograh-inbound,8003,1\n")
        rc, out, _ = self._run("--check")
        self.assertEqual(rc, 0, out)
        self.assertIn("every bound DID reaches the workflow its binding names", out)

    def test_a_bound_did_off_its_workflow_exits_one(self):
        self._portal([("4132643964", "4")])
        self._incoming("4132643964\tdograh-inbound,8000,1\n")
        rc, out, err = self._run("--check")
        self.assertEqual(rc, 1)
        self.assertIn("drift", out)
        self.assertIn("wants dograh-inbound,8003,1", out)
        self.assertIn("a person adds the missing row or fixes the binding", err)

    def test_a_binding_that_cannot_resolve_is_not_a_pass(self):
        self._portal([("4132643964", "Philosophy")])
        self._incoming("4132643964\tdograh-inbound,8000,1\n")
        rc, _, err = self._run("--check")
        self.assertEqual(rc, 1)
        self.assertIn("Philosophy", err)

    def test_a_portal_with_no_bindings_is_cannot_tell(self):
        self._portal([])
        self._incoming("")
        rc, _, err = self._run("--check")
        self.assertEqual(rc, 2)
        self.assertIn("binds no active DID", err)

    def test_a_binding_for_a_did_the_account_no_longer_holds_is_left_alone(self):
        """Only active numbers are judged — a stale binding is not a route."""
        con = sqlite3.connect(self.db_path)
        con.execute("CREATE TABLE phone_numbers (did TEXT, status TEXT)")
        con.execute(
            "CREATE TABLE voice_bindings (user_id TEXT, did TEXT, capstone_binding TEXT)"
        )
        con.execute("INSERT INTO phone_numbers VALUES ('4132643964', 'released')")
        con.execute("INSERT INTO voice_bindings VALUES ('u', '4132643964', '4')")
        con.commit()
        con.close()
        self._incoming("4132643964\tdograh-inbound,8000,1\n")
        rc, _, err = self._run("--check")
        self.assertEqual(rc, 2)
        self.assertIn("binds no active DID", err)


if __name__ == "__main__":
    unittest.main()
