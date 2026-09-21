#!/usr/bin/env python3
"""Unit tests for pbx/ava_routing.py — per-account AVA routing + add-on gate.

What matters here is what the rendered dialplan does, not the tool's shape:
every account must be answered (never dropped), the Capstone handoff must be
impossible without an explicit entitlement, and nothing an operator or a phone
table can contain may escape into the dialplan.

Run:  python3 -m unittest discover -s pbx/tests -v
"""
import json
import os
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import ava_routing as ar  # noqa: E402


def _write_plan(tmpdir: str, plan: dict) -> str:
    path = os.path.join(tmpdir, "plan.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(plan, fh)
    return path


def _render(plan: dict) -> str:
    return ar.render(ar.validate(plan))


class CapstoneGateTest(unittest.TestCase):
    """The add-on must be opt-in, and unreadable-as-truthy values must not grant it."""

    def test_entitled_account_gets_the_gate_flag(self):
        out = _render({"accounts": [{"did": "7745057135", "capstone_addon": True}]})
        self.assertIn("Set(ZEUS_CAPSTONE_ADDON=1)", out)

    def test_unentitled_account_is_explicitly_zero_not_unset(self):
        out = _render({"accounts": [{"did": "7745057135"}]})
        self.assertIn("Set(ZEUS_CAPSTONE_ADDON=0)", out)
        self.assertNotIn("ZEUS_CAPSTONE_ADDON=1", out)

    def test_truthy_lookalikes_do_not_grant_the_addon(self):
        # A JSON string, a 1, and a null all reach us from exports and from
        # SQLite booleans. Only a real boolean True may unlock a paid product.
        for value in ["true", 1, "1", None, "yes"]:
            with self.subTest(value=value):
                out = _render({"accounts": [{"did": "7745057135", "capstone_addon": value}]})
                self.assertNotIn("ZEUS_CAPSTONE_ADDON=1", out)

    def test_gate_flag_is_set_before_entering_stasis(self):
        # AVA holds the channel; the flag has to be on it before Stasis, or the
        # handoff check sees nothing.
        out = _render({"accounts": [{"did": "7745057135", "capstone_addon": True}]})
        self.assertLess(out.index("Set(ZEUS_CAPSTONE_ADDON=1)"), out.index("Goto(zeus-ai-first-response"))


class RoutingTest(unittest.TestCase):
    def test_every_account_routes_into_the_first_response_flow(self):
        out = _render(
            {
                "accounts": [
                    {"did": "4132643964", "agent": "dhunter"},
                    {"did": "7745057135", "capstone_addon": True},
                ]
            }
        )
        self.assertEqual(out.count("Goto(zeus-ai-first-response,s,1)"), 3)  # 2 accounts + fallback
        self.assertIn("exten => 4132643964,", out)
        self.assertIn("Set(AI_AGENT=dhunter)", out)

    def test_missing_agent_falls_back_to_the_default_agent(self):
        out = _render({"accounts": [{"did": "7745057135"}]})
        self.assertIn(f"Set(AI_AGENT={ar.DEFAULT_AGENT})", out)

    def test_provider_and_audio_profile_overrides_render(self):
        out = _render(
            {
                "accounts": [
                    {
                        "did": "7745057135",
                        "provider": "zeus_premium",
                        "audio_profile": "telephony_ulaw_8k",
                    }
                ]
            }
        )
        self.assertIn("Set(AI_PROVIDER=zeus_premium)", out)
        self.assertIn("Set(AI_AUDIO_PROFILE=telephony_ulaw_8k)", out)

    def test_unmatched_did_gets_the_fallback_not_an_error(self):
        out = _render({"accounts": [{"did": "7745057135"}]})
        self.assertIn(f"exten => {ar.DEFAULT_AGENT},1,", out)


class ValidationTest(unittest.TestCase):
    def test_renders_did_as_digits(self):
        out = _render({"accounts": [{"did": "+1 (774) 505-7135"}]})
        # The +1 must not survive: FreePBX matches the 10-digit national form,
        # so 17745057135 would miss the account's route entirely.
        self.assertIn("exten => 7745057135,", out)
        self.assertNotIn("17745057135", out)

    def test_rejects_undialable_did(self):
        for bad in ["1234", "not-a-number", "", "12345678901234567890"]:
            with self.subTest(did=bad):
                with self.assertRaises(ar.PlanError):
                    ar.validate({"accounts": [{"did": bad}]})

    def test_rejects_duplicate_did(self):
        # Two rows for one DID would make routing depend on row order.
        with self.assertRaises(ar.PlanError):
            ar.validate(
                {"accounts": [{"did": "7745057135"}, {"did": "7745057135"}]}
            )

    def test_rejects_agent_slug_that_could_escape_the_dialplan(self):
        for bad in ["receptionist\nSet(BAD=1)", "Receptionist", "a b", "${X}", "a" * 65]:
            with self.subTest(agent=bad):
                with self.assertRaises(ar.PlanError):
                    ar.validate({"accounts": [{"did": "7745057135", "agent": bad}]})

    def test_rejects_unsafe_provider_or_profile(self):
        with self.assertRaises(ar.PlanError):
            ar.validate(
                {"accounts": [{"did": "7745057135", "provider": "x}Set(A=1)"}]}
            )

    def test_load_plan_rejects_malformed_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "plan.json")
            with open(path, "w", encoding="utf-8") as fh:
                fh.write("{oops")
            with self.assertRaises(ar.PlanError):
                ar.load_plan(path)

    def test_load_plan_requires_accounts_list(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(ar.PlanError):
                ar.load_plan(_write_plan(tmp, {"rows": []}))


class PlanFromDbTest(unittest.TestCase):
    def _db(self, tmpdir: str, *, addons: bool, addon_row=None) -> str:
        path = os.path.join(tmpdir, "portal.db")
        con = sqlite3.connect(path)
        con.executescript(
            """
            CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT);
            CREATE TABLE phone_numbers (
                id TEXT PRIMARY KEY, user_id TEXT, did TEXT,
                status TEXT NOT NULL DEFAULT 'active'
            );
            """
        )
        if addons:
            con.executescript(
                "CREATE TABLE account_addons (user_id TEXT, addon TEXT, entitled INTEGER);"
            )
        if addon_row:
            con.execute("INSERT INTO account_addons VALUES (?, ?, ?)", addon_row)
        con.execute("INSERT INTO users VALUES ('u1', 'a@example.com')")
        con.execute("INSERT INTO phone_numbers VALUES ('n1', 'u1', '7745057135', 'active')")
        con.execute("INSERT INTO phone_numbers VALUES ('n2', 'u1', '4132643964', 'cancelled')")
        con.commit()
        con.close()
        return path

    def test_reads_only_active_numbers(self):
        with tempfile.TemporaryDirectory() as tmp:
            plan = ar.plan_from_db(self._db(tmp, addons=False))
        self.assertEqual([a["did"] for a in plan["accounts"]], ["7745057135"])

    def test_absent_addon_table_means_no_addon(self):
        # A portal that has never checked entitlements must not unlock Capstone.
        with tempfile.TemporaryDirectory() as tmp:
            plan = ar.plan_from_db(self._db(tmp, addons=False))
        rendered = ar.render(ar.validate(plan))
        self.assertIn("ZEUS_CAPSTONE_ADDON=0", rendered)

    def test_reads_recorded_entitlement(self):
        with tempfile.TemporaryDirectory() as tmp:
            plan = ar.plan_from_db(
                self._db(tmp, addons=True, addon_row=("u1", "capstone", 1))
            )
        rendered = ar.render(ar.validate(plan))
        self.assertIn("ZEUS_CAPSTONE_ADDON=1", rendered)

    def test_wrong_database_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "other.db")
            sqlite3.connect(path).close()
            with self.assertRaises(ar.PlanError):
                ar.plan_from_db(path)


class CliTest(unittest.TestCase):
    def test_check_reports_drift_without_writing(self):
        with tempfile.TemporaryDirectory() as tmp:
            plan_path = _write_plan(
                tmp, {"accounts": [{"did": "7745057135", "capstone_addon": True}]}
            )
            out_path = os.path.join(tmp, "accounts.conf")
            self.assertEqual(ar.main(["--accounts-json", plan_path, "--out", out_path]), 0)
            with open(out_path, "r", encoding="utf-8") as fh:
                written = fh.read()

            # Same plan: no drift.
            self.assertEqual(
                ar.main(["--accounts-json", plan_path, "--out", out_path, "--check"]),
                0,
            )

            # Entitlement revoked: the rendered file is now stale.
            _write_plan(tmp, {"accounts": [{"did": "7745057135"}]})
            self.assertEqual(
                ar.main(["--accounts-json", plan_path, "--out", out_path, "--check"]),
                1,
            )
            with open(out_path, "r", encoding="utf-8") as fh:
                self.assertEqual(fh.read(), written, "--check must not write")

    def test_invalid_plan_exits_nonzero(self):
        with tempfile.TemporaryDirectory() as tmp:
            plan_path = _write_plan(tmp, {"accounts": [{"did": "nope"}]})
            self.assertEqual(ar.main(["--accounts-json", plan_path]), 1)


if __name__ == "__main__":
    unittest.main()
