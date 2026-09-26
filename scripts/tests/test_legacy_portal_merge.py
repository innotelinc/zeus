"""Unit tests for the portal-side legacy account merge.

The planners are pure, so what lands in the portal database can be checked here
instead of against a live SQLite file.

Run:  python3 -m unittest discover -s scripts/tests -v
"""
from __future__ import annotations

import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts"))

import legacy_portal_merge as merge  # noqa: E402


def account(**overrides):
    base = {
        "extension": "4132643964",
        "name": "Darnel Hunter",
        "voicemail": "default",
        "secret": "legacy-secret",
        "vm": {"pin": "1234"},
    }
    base.update(overrides)
    return base


class QuoteTests(unittest.TestCase):
    def test_none_becomes_sql_null(self):
        self.assertEqual(merge.quote(None), "NULL")

    def test_single_quotes_are_escaped(self):
        self.assertEqual(merge.quote("O'Brien Inc"), "'O''Brien Inc'")

    def test_numbers_are_stringified(self):
        self.assertEqual(merge.quote(0), "'0'")


class EmailTests(unittest.TestCase):
    def test_account_name_becomes_a_stable_address(self):
        self.assertEqual(merge.slug_email("Denovo Credit Corporation"),
                         "denovo-credit-corporation@innotel.us")

    def test_punctuation_does_not_leave_empty_segments(self):
        self.assertEqual(merge.slug_email("US Agents, Inc."),
                         "us-agents-inc@innotel.us")


class OwnershipTests(unittest.TestCase):
    def test_a_did_extension_belongs_to_its_own_account(self):
        self.assertEqual(merge.owner_of("4132643964"), "Darnel Hunter")

    def test_a_device_extension_hangs_off_the_corporate_account(self):
        for extension in ("12000", "15000", "3291", "3294"):
            self.assertEqual(merge.owner_of(extension), merge.CORPORATE)

    def test_routed_dids_are_included(self):
        self.assertEqual(merge.did_owners()["7745057136"], merge.CORPORATE)


class UserPlanTests(unittest.TestCase):
    def test_an_existing_account_is_matched_and_left_alone(self):
        existing = [{"id": "u1", "email": "dhunter@innotel.us", "name": "Darnel Hunter"}]
        owners, lines, statements = merge.plan_users({"Darnel Hunter"}, existing)
        self.assertEqual(owners["Darnel Hunter"], "u1")
        self.assertEqual(statements, [])
        self.assertTrue(lines[0].startswith("MATCH"))

    def test_a_new_account_is_created_for_authentik_to_bind_to(self):
        owners, lines, statements = merge.plan_users({"Grandmas Place Inc"}, [])
        self.assertEqual(len(statements), 1)
        self.assertIn("'!oidc'", statements[0])
        self.assertIn("grandmas-place-inc@innotel.us", statements[0])
        self.assertTrue(owners["Grandmas Place Inc"])

    def test_matching_ignores_case_and_surrounding_space(self):
        existing = [{"id": "u1", "email": "x@y", "name": "  dARnEL hUNTER "}]
        _, lines, statements = merge.plan_users({"Darnel Hunter"}, existing)
        self.assertEqual(statements, [])
        self.assertTrue(lines[0].startswith("MATCH"))


class NumberPlanTests(unittest.TestCase):
    def test_a_number_already_on_its_account_is_untouched(self):
        owners = {name: "u-" + name for name in merge.did_owners().values()}
        existing = {"4132643964": {"id": "n1", "user_id": "u-Darnel Hunter",
                                   "did": "4132643964"}}
        lines, statements = merge.plan_numbers(existing, owners, [])
        self.assertNotIn("4132643964", "".join(statements))
        self.assertTrue(any("4132643964" in line and line.startswith("OK") for line in lines))

    def test_a_number_on_the_wrong_account_is_reassigned_to_its_owner(self):
        owners = {name: "u-" + name for name in merge.did_owners().values()}
        existing = {"7745057135": {"id": "n2", "user_id": "u-Demo User",
                                   "did": "7745057135"}}
        lines, statements = merge.plan_numbers(existing, owners, [])
        self.assertTrue(any(line.startswith("MOVE") for line in lines))
        self.assertTrue(any(s.startswith("UPDATE phone_numbers SET user_id=") and "7745057135" in s
                            for s in statements))

    def test_the_fax_did_is_created_with_fax_enabled_only(self):
        owners = {name: "u-" + name for name in merge.did_owners().values()}
        _, statements = merge.plan_numbers({}, owners, [])
        fax = next(s for s in statements if "7745057136" in s)
        self.assertIn(", 0, 1, 'active'", fax)


class ExtensionPlanTests(unittest.TestCase):
    def test_an_extension_already_present_is_skipped(self):
        owners = {merge.CORPORATE: "u1"}
        lines, statements = merge.plan_extensions({"3291": account(extension="3291")},
                                                  {"3291"}, owners)
        self.assertEqual(statements, [])
        self.assertTrue(lines[0].startswith("OK"))

    def test_the_legacy_secret_and_voicemail_pin_are_carried_over(self):
        owners = {"Darnel Hunter": "u1"}
        _, statements = merge.plan_extensions({"4132643964": account()}, set(), owners)
        self.assertIn("'legacy-secret'", statements[0])
        self.assertIn("'1234'", statements[0])
        self.assertIn(", 1, '1234', 'active'", statements[0])

    def test_an_extension_without_voicemail_gets_no_pin(self):
        owners = {merge.CORPORATE: "u1"}
        _, statements = merge.plan_extensions(
            {"3291": account(extension="3291", voicemail="novm", vm={"pin": "9999"})},
            set(), owners)
        self.assertIn("NULL", statements[0])
        self.assertNotIn("9999", statements[0])

    def test_extensions_are_ordered_shortest_first_for_readability(self):
        accounts = {"12000": account(extension="12000"), "3291": account(extension="3291")}
        owners = {merge.CORPORATE: "u1"}
        lines, _ = merge.plan_extensions(accounts, set(), owners)
        self.assertIn("3291", lines[0])
        self.assertIn("12000", lines[1])

    def test_an_explicit_owner_overrides_the_merge_rule(self):
        # What `adopt --account` needs: the extension placed under the account
        # the operator names, not the one the legacy rule would guess.
        owners = {"Elsewhere": "u9"}
        _, statements = merge.plan_extensions(
            {"4132912045": account(extension="4132912045", name="Wendel")}, set(), owners,
            owner_for=lambda _extension: "Elsewhere")
        self.assertIn("'u9'", statements[0])


class AdoptionTests(unittest.TestCase):
    """The half the snapshot cannot cover: an extension created after it."""

    def test_the_default_owner_is_the_same_rule_the_merge_uses(self):
        # 4132912045 is not one of the routed DIDs, so it hangs off the
        # corporate account exactly as any other device extension does.
        self.assertEqual(merge.owner_of("4132912045"), merge.CORPORATE)

    def test_a_live_account_is_read_off_the_pbx_in_the_snapshot_shape(self):
        with mock.patch.object(merge.pbx_db, "mysql_exec",
                               return_value="Wendel\tnovm\n") as exec_:
            got = merge.read_pbx_account("4132912045", "zeus-freepbx")
        self.assertEqual(got["extension"], "4132912045")
        self.assertEqual(got["name"], "Wendel")
        self.assertEqual(got["voicemail"], "novm")
        # The secret is never invented.
        self.assertIsNone(got["secret"])
        self.assertIn("'4132912045'", exec_.call_args.args[1])

    def test_an_extension_the_pbx_does_not_have_is_none(self):
        with mock.patch.object(merge.pbx_db, "mysql_exec", return_value=""):
            self.assertIsNone(merge.read_pbx_account("4099999999", "zeus-freepbx"))

    def test_a_snapshot_entry_is_preferred_over_the_live_pbx(self):
        # It carries the legacy secret and PIN, so the portal and the PBX keep
        # agreeing on the credentials the migration already wrote.
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
            json.dump({"source_host": "voice", "accounts": [
                {"extension": "4132912045", "name": "Wendel", "secret": "legacy"}]},
                handle)
            path = handle.name
        try:
            found = merge.account_from_snapshot(path, "4132912045")
        finally:
            Path(path).unlink()
        self.assertEqual(found["secret"], "legacy")

    def test_a_missing_snapshot_is_not_an_error(self):
        self.assertIsNone(merge.account_from_snapshot("/nonexistent.json", "4132912045"))

    def _run(self, argv, *, account, resolve="zeus-freepbx"):
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.object(merge.pbx_db, "resolve_container", return_value=resolve), \
             mock.patch.object(merge, "read_pbx_account", return_value=account), \
             mock.patch.object(merge, "rows", return_value=[]), \
             mock.patch.object(merge, "sqlite") as sqlite_:
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                rc = merge.main(argv)
        return rc, out.getvalue(), err.getvalue(), sqlite_

    def test_adopt_plans_without_writing_until_apply(self):
        rc, out, _, sqlite_ = self._run(
            ["adopt", "--extension", "4132912045", "--accounts", "/nonexistent.json"],
            account={"extension": "4132912045", "name": "Wendel", "voicemail": "novm"})
        self.assertEqual(rc, 0, out)
        self.assertIn("plan only", out)
        sqlite_.assert_not_called()

    def test_adopt_apply_writes_the_mirror_row(self):
        rc, out, _, sqlite_ = self._run(
            ["adopt", "--extension", "4132912045", "--accounts", "/nonexistent.json",
             "--apply"],
            account={"extension": "4132912045", "name": "Wendel", "voicemail": "novm"})
        self.assertEqual(rc, 0, out)
        self.assertIn("applied", out)
        sql = sqlite_.call_args.args[0]
        self.assertIn("INSERT INTO freepbx_extensions", sql)
        self.assertIn("'4132912045'", sql)

    def test_an_extension_that_is_not_on_the_pbx_is_not_adopted(self):
        rc, _, err, sqlite_ = self._run(
            ["adopt", "--extension", "4099999999", "--accounts", "/nonexistent.json"],
            account=None)
        self.assertEqual(rc, 1)
        self.assertIn("not a FreePBX extension", err)
        sqlite_.assert_not_called()


if __name__ == "__main__":
    unittest.main()
