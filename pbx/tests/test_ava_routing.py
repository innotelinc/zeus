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


class CapstoneTargetTest(unittest.TestCase):
    """WHICH interview an account reaches, and the rule that it cannot outlive
    the entitlement that allows one at all."""

    def test_entitled_account_gets_its_own_target(self):
        out = _render(
            {
                "accounts": [
                    {"did": "7745057135", "capstone_addon": True, "capstone_target": "8005"},
                    {"did": "4132643964", "capstone_addon": True, "capstone_target": "8007"},
                ]
            }
        )
        self.assertIn("Set(ZEUS_CAPSTONE_TARGET=8005)", out)
        self.assertIn("Set(ZEUS_CAPSTONE_TARGET=8007)", out)

    def test_entitled_account_with_no_binding_gets_an_empty_target(self):
        # Empty rather than omitted: [zeus-ai-interview] refuses on empty, and
        # an omitted line would leave whatever the channel already carried.
        out = _render({"accounts": [{"did": "7745057135", "capstone_addon": True}]})
        self.assertIn("Set(ZEUS_CAPSTONE_TARGET=)", out)
        # ...and nothing else was written as a target.
        self.assertEqual(out.count("Set(ZEUS_CAPSTONE_TARGET="), 2)  # account + fallback

    def test_a_binding_without_the_entitlement_is_dropped(self):
        # The subscription lapsed but the row did not: the row must not be able
        # to name a workflow on its own.
        out = _render(
            {"accounts": [{"did": "7745057135", "capstone_target": "8005"}]}
        )
        self.assertNotIn("8005", out)
        self.assertIn("Set(ZEUS_CAPSTONE_ADDON=0)", out)

    def test_target_is_set_before_the_call_leaves_the_context(self):
        out = _render(
            {"accounts": [{"did": "7745057135", "capstone_addon": True, "capstone_target": "8005"}]}
        )
        self.assertLess(
            out.index("Set(ZEUS_CAPSTONE_TARGET=8005)"),
            out.index("Goto(zeus-ai-first-response"),
        )

    def test_rejects_a_target_that_could_escape_dialplan_exists(self):
        for bad in ["8005,1)", "${X}", "a b", "8}Set(A=1)", "x" * 65, "8005\nSet(X=1)"]:
            with self.subTest(target=bad):
                with self.assertRaises(ar.PlanError):
                    ar.validate(
                        {"accounts": [{"did": "7745057135", "capstone_target": bad}]}
                    )


class CallEnvelopeTest(unittest.TestCase):
    """D2: the small, certain facts both agents need, stamped once at ingress."""

    def test_every_route_is_stamped_with_the_trace_id(self):
        out = _render(
            {
                "accounts": [
                    {"did": "7745057135", "account": "u1"},
                    {"did": "4132643964", "account": "u2"},
                ]
            }
        )
        # Two accounts + the fallback: an unmatched DID is still a call, and a
        # call with no trace id is one the two products cannot reconcile.
        self.assertEqual(out.count("Set(AI_CALL_ID=${UNIQUEID})"), 3)
        self.assertEqual(out.count("Set(AI_CALLER_NUM=${CALLERID(num)})"), 3)

    def test_the_context_token_is_stamped_on_every_entry_the_call_id_is(self):
        # The portal reads the call's context back by this handle
        # (/api/voice/context/{token}), so an entry that stamps a trace id but
        # no token is a call whose agents cannot fetch anything.
        out = _render(
            {
                "accounts": [
                    {"did": "7745057135", "account": "u1"},
                    {"did": "4132643964", "account": "u2"},
                ]
            }
        )
        self.assertEqual(
            out.count("Set(AI_CONTEXT_TOKEN=${UNIQUEID})"),
            out.count("Set(AI_CALL_ID=${UNIQUEID})"),
        )

    def test_the_token_is_the_call_and_never_an_account_value(self):
        # It is a pointer, not a secret, and not an account id: what authorises
        # the read is the agent credential, so the channel must not carry
        # anything an attacker could turn into a lookup on its own.
        out = _render({"accounts": [{"did": "7745057135", "account": "u1"}]})
        token_lines = [
            line for line in out.splitlines()
            if "Set(AI_CONTEXT_TOKEN" in line
        ]
        self.assertTrue(token_lines)
        for line in token_lines:
            self.assertIn("${UNIQUEID}", line)
            self.assertNotIn("u1", line)

    def test_the_token_is_set_before_the_call_leaves_the_context(self):
        out = _render({"accounts": [{"did": "7745057135", "account": "u1"}]})
        self.assertLess(
            out.index("Set(AI_CONTEXT_TOKEN=${UNIQUEID})"),
            out.index("Goto(zeus-ai-first-response"),
        )

    def test_account_id_is_stamped_per_did(self):
        out = _render(
            {
                "accounts": [
                    {"did": "7745057135", "account": "u1"},
                    {"did": "4132643964", "account": "u2"},
                ]
            }
        )
        self.assertIn("Set(AI_ACCOUNT=u1)", out)
        self.assertIn("Set(AI_ACCOUNT=u2)", out)

    def test_no_account_id_renders_no_account_variable(self):
        # A plan exported without ids must not render an empty AI_ACCOUNT over
        # a channel that already has one. (The context header names the
        # variable, so the assertion is on the Set that would write it.)
        out = _render({"accounts": [{"did": "7745057135"}]})
        self.assertNotIn("Set(AI_ACCOUNT=", out)

    def test_rejects_an_account_id_that_could_escape_the_dialplan(self):
        with self.assertRaises(ar.PlanError):
            ar.validate(
                {"accounts": [{"did": "7745057135", "account": "u1\nSet(X=1)"}]}
            )


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
    def _db(
        self,
        tmpdir: str,
        *,
        addons: bool,
        addon_row=None,
        bindings: bool = False,
        binding_rows: tuple = (),
    ) -> str:
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
        if bindings:
            con.executescript(
                """
                CREATE TABLE voice_bindings (
                    user_id TEXT, did TEXT, capstone_binding TEXT,
                    PRIMARY KEY (user_id, did)
                );
                """
            )
            for row in binding_rows:
                con.execute("INSERT INTO voice_bindings VALUES (?, ?, ?)", row)
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

    def test_reads_the_capstone_binding_for_an_entitled_did(self):
        with tempfile.TemporaryDirectory() as tmp:
            plan = ar.plan_from_db(
                self._db(
                    tmp,
                    addons=True,
                    addon_row=("u1", "capstone", 1),
                    bindings=True,
                    binding_rows=[("u1", "7745057135", "8005")],
                )
            )
        rendered = ar.render(ar.validate(plan))
        self.assertIn("Set(ZEUS_CAPSTONE_TARGET=8005)", rendered)

    def test_a_binding_is_read_per_did_not_per_account(self):
        # One account, two numbers, one of them bound: the other must not
        # inherit the workflow.
        with tempfile.TemporaryDirectory() as tmp:
            path = self._db(
                tmp,
                addons=True,
                addon_row=("u1", "capstone", 1),
                bindings=True,
                binding_rows=[("u1", "7745057135", "8005")],
            )
            con = sqlite3.connect(path)
            con.execute(
                "INSERT INTO phone_numbers VALUES ('n3', 'u1', '4135612020', 'active')"
            )
            con.commit()
            con.close()
            plan = ar.plan_from_db(path)
        rendered = ar.render(ar.validate(plan))
        self.assertEqual(rendered.count("Set(ZEUS_CAPSTONE_TARGET=8005)"), 1)
        self.assertIn("Set(ZEUS_CAPSTONE_TARGET=)", rendered)

    def test_absent_bindings_table_means_no_target(self):
        # A portal that has never recorded a binding must not guess one.
        with tempfile.TemporaryDirectory() as tmp:
            plan = ar.plan_from_db(
                self._db(tmp, addons=True, addon_row=("u1", "capstone", 1))
            )
        rendered = ar.render(ar.validate(plan))
        self.assertIn("Set(ZEUS_CAPSTONE_TARGET=)", rendered)

    def test_plan_carries_the_portal_account_id(self):
        with tempfile.TemporaryDirectory() as tmp:
            plan = ar.plan_from_db(self._db(tmp, addons=False))
        self.assertEqual(plan["accounts"][0]["account"], "u1")

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
