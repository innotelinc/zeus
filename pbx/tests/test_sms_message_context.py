#!/usr/bin/env python3
"""Unit tests for pbx/sms_message_context.py — inbound MESSAGE routing.

The failure this exists to catch is quiet from both directions: the trunk is
Registered, the `[sms-in]` dialplan is loaded, and a text that arrives is still
dropped because nothing points the trunk's MESSAGEs at a context. The live box
also carries the *wrong* config that reads as right — the legacy `[general]`
`accept_outofcall_message` block, which this Asterisk build does not implement
(neither res_pjsip.so nor res_pjsip_messaging.so contains the option strings;
`message_context` is the only MESSAGE option). So the tests are about shape:
real `mysql -N -B` output, the absent-vs-empty distinction that decides between
UPDATE and INSERT, and the exit-code contract.

Run:  python3 -m unittest discover -s pbx/tests -v
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import sms_message_context as sms  # noqa: E402

# Verbatim `mysql -N -B -u root asterisk -e "SELECT trunkid FROM trunks WHERE name='voipms_pjsip' ..."`.
TRUNK_ID = "2\n"
# Verbatim `... -e "SELECT id, data FROM pjsip WHERE id=2 AND keyword='message_context'"`,
# before the convergence: the row exists with an empty value.
SETTING_EMPTY = "2\t\n"
SETTING_SET = "2\tsms-in\n"
# And the absent row (a trunk FreePBX never wrote a value for).
SETTING_ABSENT = ""


class ParseTrunkIdTest(unittest.TestCase):
    def test_a_numeric_row_is_the_trunk(self):
        self.assertEqual(sms.parse_trunk_id(TRUNK_ID), 2)

    def test_no_row_is_none(self):
        self.assertIsNone(sms.parse_trunk_id(""))
        self.assertIsNone(sms.parse_trunk_id("\n  \n"))


class ParseSettingTest(unittest.TestCase):
    def test_a_set_value(self):
        self.assertEqual(sms.parse_setting(SETTING_SET), "sms-in")

    def test_an_empty_value_is_a_row_that_exists(self):
        """Empty is not absent: one UPDATEs, the other INSERTs."""
        self.assertEqual(sms.parse_setting(SETTING_EMPTY), "")

    def test_an_absent_row_is_none(self):
        self.assertIsNone(sms.parse_setting(SETTING_ABSENT))


class JudgeTest(unittest.TestCase):
    def test_in_sync_is_no_finding(self):
        self.assertEqual(sms.judge("voipms_pjsip", 2, "sms-in", "sms-in"), [])

    def test_an_absent_row_is_drift(self):
        findings = sms.judge("voipms_pjsip", 2, None, "sms-in")
        self.assertEqual([f.state for f in findings], ["unset"])
        # The repair names the action and the value, so an operator can do it
        # in the FreePBX GUI too ("Message Context" on the trunk).
        self.assertIn("message_context=sms-in", findings[0].repair)

    def test_an_empty_row_is_drift(self):
        findings = sms.judge("voipms_pjsip", 2, "", "sms-in")
        self.assertEqual([f.state for f in findings], ["empty"])

    def test_a_different_context_is_drift(self):
        findings = sms.judge("voipms_pjsip", 2, "from-trunk", "sms-in")
        self.assertEqual([f.state for f in findings], ["wrong-context"])
        self.assertIn("from-trunk", findings[0].detail)
        self.assertIn("sms-in", findings[0].detail)


class RenderApplySqlTest(unittest.TestCase):
    def test_an_existing_row_is_updated(self):
        sql = sms.render_apply_sql(2, "sms-in", exists=True)
        self.assertTrue(sql.startswith("UPDATE pjsip SET data='sms-in'"))
        self.assertIn("WHERE id=2 AND keyword='message_context'", sql)
        self.assertNotIn("INSERT", sql)

    def test_an_absent_row_is_inserted(self):
        sql = sms.render_apply_sql(7, "sms-in", exists=False)
        self.assertTrue(sql.startswith("INSERT INTO pjsip"))
        self.assertIn("(7, 'message_context', 'sms-in', 0)", sql)
        self.assertNotIn("UPDATE", sql)

    def test_a_quote_in_the_context_does_not_break_out(self):
        sql = sms.render_apply_sql(2, "o'brien", exists=True)
        self.assertIn("data='o''brien'", sql)


if __name__ == "__main__":
    unittest.main()
