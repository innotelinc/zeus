"""Unit tests for the legacy PBX account migration decisions.

These cover the parts that decide *what* happens to an account, so a change in
the mapping is caught here rather than on a live PBX.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import legacy_voice_migrate as migrate  # noqa: E402


def account(**overrides):
    base = {
        "extension": "7745057135",
        "name": "Denovo Credit Corporation",
        "device_tech": "pjsip",
        "voicemail": "default",
        "outboundcid": '"DENOVO CREDIT CORPORATION" <7745057135>',
        "secret": "legacy-secret",
        "vm": {"pin": "4321"},
    }
    base.update(overrides)
    return base


class CoreInputTests(unittest.TestCase):
    def test_carries_caller_id_outbound_cid_and_voicemail_pin(self):
        payload = migrate.core_input(account())
        self.assertEqual(payload["extensionId"], "7745057135")
        self.assertEqual(payload["name"], "Denovo Credit Corporation")
        self.assertEqual(payload["callerID"], "Denovo Credit Corporation <7745057135>")
        self.assertEqual(payload["outboundCid"], '"DENOVO CREDIT CORPORATION" <7745057135>')
        self.assertEqual(payload["vmPassword"], "4321")
        self.assertTrue(payload["vmEnable"])

    def test_account_without_voicemail_omits_the_pin(self):
        payload = migrate.core_input(account(voicemail="novm", vm={"pin": "4321"}))
        self.assertFalse(payload["vmEnable"])
        self.assertNotIn("vmPassword", payload)

    def test_blank_voicemail_is_treated_as_disabled(self):
        self.assertFalse(migrate.core_input(account(voicemail=""))["vmEnable"])
        self.assertTrue(migrate.voicemail_enabled(account(voicemail="default")))
        self.assertTrue(migrate.voicemail_enabled(account(voicemail="yes")))

    def test_blank_outbound_cid_is_not_sent(self):
        payload = migrate.core_input(account(outboundcid="   "))
        self.assertNotIn("outboundCid", payload)


class DestinationTests(unittest.TestCase):
    def test_legacy_voice_agent_destination_maps_to_the_zeus_agent(self):
        self.assertEqual(migrate.translated_destination("from-external,824,1"),
                         "dograh-inbound,8000,1")

    def test_other_destinations_pass_through(self):
        self.assertEqual(migrate.translated_destination("ext-group,329,1"),
                         "ext-group,329,1")
        self.assertEqual(migrate.translated_destination("dograh-inbound,8001,1"),
                         "dograh-inbound,8001,1")


class SecretTests(unittest.TestCase):
    def test_upsert_targets_the_table_freepbx_reads(self):
        statement = migrate.secret_upsert_sql("3291", "abc123")
        self.assertIn("insert into sip", statement)
        self.assertIn("('3291', 'secret', 'abc123', 0)", statement)
        self.assertIn("on duplicate key update data='abc123'", statement)

    def test_single_quotes_in_a_secret_are_escaped(self):
        statement = migrate.secret_upsert_sql("3291", "pa'ss")
        self.assertIn("'pa''ss'", statement)
        self.assertNotIn("'pa'ss'", statement)


class AuthConfTests(unittest.TestCase):
    CONFIG = """;--------------------------------------------------------------------------------;
[0]
#include pjsip.auth_custom.conf

[12000-auth]
type = auth
auth_type = userpass
password = legacy-secret
username = 12000

[101-auth]
type = auth
password = webrtc-test
username = 101
"""

    def test_reads_each_extensions_generated_credential(self):
        secrets = migrate.parse_auth_conf(self.CONFIG)
        self.assertEqual(secrets["12000"], "legacy-secret")
        self.assertEqual(secrets["101"], "webrtc-test")

    def test_transport_sections_are_not_mistaken_for_auth(self):
        self.assertEqual(migrate.parse_auth_conf("[12000]\ntype = endpoint\npassword = x\n"), {})

    def test_missing_extension_is_absent_rather_than_guessed(self):
        self.assertNotIn("9999", migrate.parse_auth_conf(self.CONFIG))


class TechNoteTests(unittest.TestCase):
    def test_iax2_is_called_out_because_the_target_cannot_host_it(self):
        note = migrate.tech_note("iax2")
        self.assertIsNotNone(note)
        self.assertIn("reprovisioning", note)

    def test_pjsip_needs_no_note(self):
        self.assertIsNone(migrate.tech_note("pjsip"))


class PlanTests(unittest.TestCase):
    def test_an_account_already_carrying_the_legacy_secret_is_left_alone(self):
        lines = migrate.plan_account(account(), exists=True,
                                     secret_on_target="legacy-secret",
                                     tech_on_target="pjsip")
        self.assertEqual(len(lines), 1)
        self.assertTrue(lines[0].startswith("OK"))

    def test_a_missing_account_is_planned_with_its_ucp_user(self):
        lines = migrate.plan_account({**account(), "um": True}, exists=False,
                                     secret_on_target="", tech_on_target="")
        self.assertTrue(any("create" in line and "UCP" in line for line in lines))

    def test_a_differing_secret_is_planned(self):
        lines = migrate.plan_account(account(), exists=True,
                                     secret_on_target="generated",
                                     tech_on_target="pjsip")
        self.assertTrue(any("set legacy device secret" in line for line in lines))

    def test_an_iax2_account_reports_the_constraint_and_not_a_tech_switch(self):
        lines = migrate.plan_account(account(device_tech="iax2"), exists=True,
                                     secret_on_target="legacy-secret",
                                     tech_on_target="pjsip")
        self.assertTrue(any(line.startswith("NOTE") for line in lines))
        self.assertFalse(any("tech pjsip -> iax2" in line for line in lines))


if __name__ == "__main__":
    unittest.main()
