#!/usr/bin/env python3
"""Unit tests for pbx/provision_extension.py — the extension/device owner.

D6 exists because two products created PBX objects by writing tables directly,
and `(1,'maxchans')` — a MySQL `1062` on `pjsip`'s primary key — broke an
unrelated feature somewhere else in the GUI. The behaviour that prevents a
repeat is not the create call; it is the *decision* in front of it:

  * a name that already exists is idempotent, not an error;
  * a name that half-exists is refused, and the refusal names the half;
  * a name with an orphaned technology row, leftover AstDB state, or a
    two-owner endpoint is refused, because creating over it collides or silently
    shadows somebody else's object — and a person, not another run, clears it;
  * the exit codes keep "an apply fixes this" (1) apart from "only a person
    can" (3), so a timer never reloads a live switch to change no row.

Run:  python3 -m unittest discover -s pbx/tests -v
"""
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import provision_extension as prov  # noqa: E402


def _intent(ext: str, name: str = "Ada Lovelace") -> prov.Intent:
    return prov.Intent(extension=ext, name=name)


class ParseIntentsTest(unittest.TestCase):
    def test_a_wrapped_document(self):
        intents = prov.parse_intents(
            json.dumps({"extensions": [{"extension": "1001", "name": "Ada"}]})
        )
        self.assertEqual([i.extension for i in intents], ["1001"])
        self.assertEqual(intents[0].name, "Ada")

    def test_a_bare_list_is_accepted(self):
        intents = prov.parse_intents(json.dumps([{"extension": "1001", "name": "Ada"}]))
        self.assertEqual(intents[0].extension, "1001")

    def test_the_account_and_email_ride_along(self):
        intents = prov.parse_intents(
            json.dumps(
                {
                    "extensions": [
                        {
                            "extension": "1001",
                            "name": "Ada",
                            "email": "ada@example.com",
                            "account": "u1",
                        }
                    ]
                }
            )
        )
        self.assertEqual(intents[0].email, "ada@example.com")
        self.assertEqual(intents[0].account, "u1")

    def test_a_non_numeric_extension_is_refused(self):
        # A `_2XX` is a route pattern, not an extension you can provision; the
        # GUI will build one, and every consumer on this box assumes digits.
        with self.assertRaises(prov.IntentError) as caught:
            prov.parse_intents(json.dumps([{"extension": "_2XX", "name": "Ada"}]))
        self.assertIn("2-8 digits", str(caught.exception))

    def test_a_missing_name_is_refused(self):
        with self.assertRaises(prov.IntentError) as caught:
            prov.parse_intents(json.dumps([{"extension": "1001", "name": "  "}]))
        self.assertIn("no name", str(caught.exception))

    def test_the_same_extension_twice_is_refused(self):
        with self.assertRaises(prov.IntentError) as caught:
            prov.parse_intents(
                json.dumps(
                    [
                        {"extension": "1001", "name": "Ada"},
                        {"extension": "1001", "name": "Grace"},
                    ]
                )
            )
        self.assertIn("twice", str(caught.exception))

    def test_an_empty_document_is_refused(self):
        # An empty intent is what a broken export looks like, and judging
        # nothing as "in sync" is the worst possible answer to it.
        with self.assertRaises(prov.IntentError) as caught:
            prov.parse_intents(json.dumps({"extensions": []}))
        self.assertIn("lists no extensions", str(caught.exception))

    def test_junk_is_refused(self):
        with self.assertRaises(prov.IntentError):
            prov.parse_intents("{not json")


class ParseAstdbTest(unittest.TestCase):
    REAL = "\n".join(
        [
            "/AMPUSER/1001/device : 1001",
            "/AMPUSER/1001/callwaiting : enabled",
            "/AMPUSER/1002/ringtimer : 0",
            "/AMPUSER/unsupported : x",
            "/CW/1003 : ENABLED",
            "",
        ]
    )

    def test_reads_the_extension_off_each_key(self):
        self.assertEqual(prov.parse_astdb(self.REAL), frozenset({"1001", "1002", "unsupported"}))

    def test_empty_output_is_an_empty_set(self):
        self.assertEqual(prov.parse_astdb(""), frozenset())

    def test_a_family_level_value_is_not_an_extension(self):
        self.assertEqual(prov.parse_astdb("/AMPUSER : something"), frozenset())


class ObserveRoundTripTest(unittest.TestCase):
    def test_a_measurement_survives_to_dict_from_dict(self):
        observed = prov.Observed(
            users=frozenset({"1001"}),
            devices=frozenset({"1001"}),
            sip_ids=frozenset({"2001"}),
            pjsip_ids=frozenset({"2001"}),
            astdb=frozenset({"3001"}),
            endpoint_two_owner=frozenset({"4001"}),
            modules_ok=False,
            modules_note="core is disabled",
        )
        again = prov.Observed.from_dict(observed.to_dict())
        self.assertEqual(again, observed)

    def test_a_dict_missing_every_key_is_all_empty_not_an_error(self):
        self.assertEqual(prov.Observed.from_dict({}), prov.Observed())

    def test_a_field_that_is_not_a_list_is_refused(self):
        with self.assertRaises(prov.IntentError):
            prov.Observed.from_dict({"users": "1001"})


class JudgeTest(unittest.TestCase):
    def setUp(self):
        self.intents = [_intent("1001"), _intent("1002", "Grace Hopper")]

    def test_a_user_and_a_device_is_in_sync(self):
        report = prov.judge(
            [_intent("1001")], prov.Observed(users=frozenset({"1001"}), devices=frozenset({"1001"}))
        )
        self.assertEqual([i.extension for i in report.in_sync], ["1001"])
        self.assertEqual(report.create, [])
        self.assertEqual(report.refused, [])

    def test_nothing_at_all_means_create(self):
        report = prov.judge(self.intents, prov.Observed())
        self.assertEqual([i.extension for i in report.create], ["1001", "1002"])
        self.assertEqual(report.in_sync, [])

    def test_a_user_without_a_device_is_refused_and_names_the_half(self):
        report = prov.judge([_intent("1001")], prov.Observed(users=frozenset({"1001"})))
        self.assertEqual(report.create, [])
        refusal = report.refused[0]
        self.assertIn("user object but no device", refusal.reason)
        self.assertIn("Extensions", refusal.repair)

    def test_a_device_without_a_user_is_refused_and_names_the_other_half(self):
        report = prov.judge([_intent("1001")], prov.Observed(devices=frozenset({"1001"})))
        self.assertIn("device but no user object", report.refused[0].reason)

    def test_an_orphaned_technology_row_is_refused_by_table_name(self):
        for table in ("sip_ids", "pjsip_ids"):
            with self.subTest(table=table):
                observed = prov.Observed(**{table: frozenset({"1001"})})
                report = prov.judge([_intent("1001")], observed)
                self.assertEqual(report.create, [])
                self.assertIn("1001", report.refused_extensions())
                self.assertIn(table.split("_")[0], report.refused[0].reason)
                # The refusal has to name the class, because `(1,'maxchans')`
                # is the error this exists to replace.
                self.assertIn("maxchans", report.refused[0].repair)

    def test_leftover_astdb_state_is_refused_with_the_verb_that_clears_it(self):
        report = prov.judge([_intent("1001")], prov.Observed(astdb=frozenset({"1001"})))
        self.assertEqual(report.create, [])
        self.assertIn("call forwarding", report.refused[0].reason)
        self.assertIn("database deltree AMPUSER 1001", report.refused[0].repair)

    def test_a_two_owner_endpoint_is_refused_before_anything_else(self):
        # The most damaging state wins the naming: creating a device here would
        # add a third object to a load tree that already has two.
        observed = prov.Observed(
            pjsip_ids=frozenset({"1001"}),
            astdb=frozenset({"1001"}),
            endpoint_two_owner=frozenset({"1001"}),
        )
        report = prov.judge([_intent("1001")], observed)
        self.assertIn("two owners", report.refused[0].reason)
        self.assertIn("pjsip_owner_check", report.refused[0].repair)

    def test_one_refusal_does_not_stop_the_other_intents(self):
        observed = prov.Observed(
            users=frozenset({"1001"}), devices=frozenset({"1001"}), astdb=frozenset({"1002"})
        )
        report = prov.judge(self.intents, observed)
        self.assertEqual([i.extension for i in report.in_sync], ["1001"])
        self.assertEqual(report.refused_extensions(), ["1002"])

    def test_an_unusable_core_module_refuses_everything(self):
        report = prov.judge(
            self.intents, prov.Observed(modules_ok=False, modules_note="core is disabled")
        )
        self.assertEqual(report.create, [])
        self.assertEqual(report.in_sync, [])
        self.assertEqual(len(report.refused), 2)
        self.assertIn("core is disabled", report.refused[0].reason)
        self.assertIn("enable core", report.refused[0].repair)


class RenderRevertTest(unittest.TestCase):
    def test_deletes_only_what_it_created_through_the_framework(self):
        script = prov.render_revert([_intent("1001"), _intent("1002")], "zeus-freepbx")
        self.assertIn("delUser", script)
        self.assertIn("delDevice", script)
        self.assertIn("'1001'", script)
        self.assertIn("'1002'", script)
        self.assertIn("docker exec -i zeus-freepbx php", script)
        # A raw table delete would leave the AstDB subtree behind — the whole
        # reason the undo is PHP and not the SQL ava_routes.py writes.
        self.assertNotIn("DELETE FROM", script)

    def test_an_empty_run_is_an_empty_list_not_a_bare_delete(self):
        script = prov.render_revert([], "zeus-freepbx")
        self.assertIn("array()", script)


class CliTest(unittest.TestCase):
    """The exit codes, which are the contract a timer and a smoke test read."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="zeus-prov-")
        self.addCleanup(lambda: __import__("shutil").rmtree(self.tmp, ignore_errors=True))

    def _write(self, name: str, payload) -> str:
        path = os.path.join(self.tmp, name)
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(payload, handle)
        return path

    def _intents(self) -> str:
        return self._write("intent.json", {"extensions": [{"extension": "1001", "name": "Ada"}]})

    def test_in_sync_is_zero(self):
        observed = self._write(
            "observed.json", {"users": ["1001"], "devices": ["1001"]}
        )
        self.assertEqual(
            prov.main(["--intent", self._intents(), "--observed-json", observed, "--check"]), 0
        )

    def test_a_creatable_extension_is_one(self):
        observed = self._write("observed.json", {})
        self.assertEqual(
            prov.main(["--intent", self._intents(), "--observed-json", observed, "--check"]), 1
        )

    def test_a_refusal_is_three_not_one(self):
        # 1 would send the timer's apply at a state no run can clear.
        observed = self._write("observed.json", {"astdb": ["1001"]})
        self.assertEqual(
            prov.main(["--intent", self._intents(), "--observed-json", observed, "--check"]), 3
        )

    def test_an_unreadable_measurement_is_two(self):
        self.assertEqual(
            prov.main(
                ["--intent", self._intents(), "--observed-json", "/nonexistent.json", "--check"]
            ),
            2,
        )

    def test_an_invalid_intent_is_one(self):
        bad = self._write("bad.json", {"extensions": [{"extension": "x", "name": "Ada"}]})
        observed = self._write("observed.json", {})
        self.assertEqual(
            prov.main(["--intent", bad, "--observed-json", observed, "--check"]), 1
        )

    def test_an_offline_apply_is_refused_outright(self):
        observed = self._write("observed.json", {})
        with self.assertRaises(SystemExit) as caught:
            prov.main(["--intent", self._intents(), "--observed-json", observed, "--apply"])
        self.assertEqual(caught.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
