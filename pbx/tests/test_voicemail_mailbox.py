#!/usr/bin/env python3
"""The judgement behind `pbx/voicemail_mailbox.py`, without a PBX.

`*97` fails on this estate for a reason that lives in FreePBX's own create path
(see the tool's docstring): `Core::addUser` writes `voicemail = "novm"` whenever
the mailbox does not already exist, and the GraphQL `addExtension(vmEnable,
vmPassword)` never creates one. So the interesting cases are not "is the file
written" but "which of the four facts is wrong" — an extension the switch cannot
name from a caller id, a box that is missing, an extension FreePBX records as
having none, and a box the dialplan resolves in a different context than it
lives in. The gate is judged first because it is what the others are looked up
*with*, and it is the one a box-shaped check cannot see: a live mailbox, four
rows that agree about it, and a call that still ends one second in. The four
readings are parsed from the exact
shapes a live PBX prints, because each of them has a wrong-looking-right form:

  * `voicemail show users` is a fixed-width table, and the *user* column carries
    spaces — reading the second column as the context, or the third as the
    mailbox, would report mailboxes nobody has.
  * `database show AMPUSER` is one `/AMPUSER/<ext>/voicemail : <context>` line
    among dozens of `/AMPUSER/<ext>/cwtone`, `/AMPUSER/<ext>/device` settings,
    so the key has to be matched, not counted.
  * `select extension, voicemail from users` may legitimately hold the string
    `novm`, which is a verdict and not a missing value.

The one structural check on the PHP is here on purpose: `Voicemail::addMailbox`
reads the PIN from `vmpwd`, and a renamed key would create a mailbox with **no
password** and report success — the same shape of silent success this tool
exists to end.

Run:  python3 -m unittest discover -s pbx/tests -v
"""

from __future__ import annotations

import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import voicemail_mailbox as vm  # noqa: E402


def intent(extension="1001", name="Ada Lovelace", email="ada@example.test", pin="4321"):
    return vm.Intent(extension=extension, name=name, email=email, pin=pin)


# The shapes a live PBX prints, with the parts that make parsing easy to get
# wrong: free-form user names, the header, the empty answer, and AstDB's other
# families of key sitting beside the one that matters.
SHOW_USERS = """
context    mbox  user                                   zone       newmsg
default    1001  Ada Lovelace                           0          0
default    2002  Darnel Hunter (Cordless Phone)         0          1
device     3003  ATA                                    0          0
"""

SHOW_USERS_EMPTY = "There are no voicemail users configured.\n"

ASTDB = """
/AMPUSER/1001/cidname : Ada Lovelace
/AMPUSER/1001/cidnum : 1001
/AMPUSER/1001/cwtone : disabled
/AMPUSER/1001/voicemail : default
/AMPUSER/2002/voicemail : novm
/devices/1001/dial : PJSIP/1001
"""

# The family the caller is resolved out of, in the shape a live PBX prints it.
DEVICE = """
/DEVICE/1001/default_user : 1001
/DEVICE/1001/dial : PJSIP/1001
/DEVICE/1001/tech : pjsip
/DEVICE/1001/type : fixed
/DEVICE/1001/user : 1001
/DEVICE/2002/user : 2002
"""

USERS = "1001\tdefault\n2002\tnovm\n3003\t\n"


class Intents(unittest.TestCase):
    def test_a_wrapped_document_and_a_bare_list_are_the_same_document(self):
        wrapped = vm.parse_intents(
            '{"extensions": [{"extension": "1001", "name": "Ada", "pin": "4321"}]}'
        )
        bare = vm.parse_intents('[{"extension": "1001", "name": "Ada", "pin": "4321"}]')
        self.assertEqual(wrapped, bare)
        self.assertEqual(wrapped, [intent("1001", "Ada", "", "4321")])

    def test_the_migration_snapshot_is_itself_a_valid_intent(self):
        """`/root/pbx-merge/accounts.json` is the operator's document, and it
        already carries the name, the extension and `vm.pin`. Requiring it to be
        translated first is where a PIN gets dropped."""
        snapshot = (
            '{"source_host": "voice", "accounts": ['
            '{"extension": "4132643964", "name": "Darnel Hunter",'
            ' "secret": "abc", "voicemail": "default", "vm": {"pin": "4321"}}]}'
        )
        self.assertEqual(
            vm.parse_intents(snapshot),
            [vm.Intent("4132643964", "Darnel Hunter", "", "4321")],
        )

    def test_a_pin_under_any_of_its_three_names(self):
        for row in (
            {"pin": "4321"},
            {"voicemail_pin": "4321"},
            {"vm_password": "4321"},
            {"vm": {"pin": "4321"}},
        ):
            with self.subTest(row=row):
                self.assertEqual(vm._pin_of(row), "4321")

    def test_refusals_name_the_mistake(self):
        for text, needle in (
            ("not json", "not JSON"),
            ("[]", "no extensions"),
            ('[{"extension": "10a1", "name": "Ada"}]', "not digits"),
            # The estate's extensions are ten-digit DIDs, so the range has to
            # reach them; only something past Asterisk's own limit is refused.
            ('[{"extension": "1234567890123456", "name": "Ada"}]', "not digits"),
            ('[{"extension": "1001"}]', "has no name"),
            (
                '[{"extension": "1001", "name": "Ada"},'
                ' {"extension": "1001", "name": "Ada"}]',
                "appears twice",
            ),
            ('["1001"]', "not an object"),
        ):
            with self.subTest(text=text):
                with self.assertRaises(vm.IntentError) as raised:
                    vm.parse_intents(text)
                self.assertIn(needle, str(raised.exception))

    def test_a_missing_pin_is_a_refusal_rather_than_a_generated_one(self):
        rows = [
            intent("1001", pin=""),
            intent("1002", pin="123"),
            intent("1003", pin="4321"),
        ]
        trouble = vm.unpinned(rows, fallback="")
        self.assertIn("no PIN", trouble["1001"])
        self.assertIn("4-8 digits", trouble["1002"])
        self.assertNotIn("1003", trouble)

    def test_the_fallback_pin_covers_only_the_rows_that_have_none(self):
        rows = [intent("1001", pin=""), intent("1002", pin="9999")]
        self.assertEqual(vm.unpinned(rows, fallback="1111"), {})
        self.assertEqual(vm.pin_for(rows[0], "1111"), "1111")
        self.assertEqual(vm.pin_for(rows[1], "1111"), "9999")


class Readings(unittest.TestCase):
    def test_a_loaded_mailbox_is_read_with_its_context(self):
        self.assertEqual(
            vm.parse_loaded(SHOW_USERS),
            {"1001": "default", "2002": "default", "3003": "device"},
        )

    def test_an_installation_with_no_mailboxes_reads_as_none_not_as_an_error(self):
        """`{}` is a real answer and the tool reports it; `None` is the plumbing
        failing, and the two are kept apart so a PBX that did not answer is
        never reported as a PBX with no mailboxes."""
        self.assertEqual(vm.parse_loaded(SHOW_USERS_EMPTY), {})

    def test_astdb_yields_the_voicemail_key_only(self):
        self.assertEqual(vm.parse_astdb(ASTDB), {"1001": "default", "2002": "novm"})

    def test_the_caller_id_pair_is_read_out_of_its_two_families(self):
        """`AMPUSER/<ext>/cidname` and `DEVICE/<id>/user` are the keys
        `macro-user-callerid` names a caller with; `devices/...` (lower case) is
        a different family's decoy and must not be read as one."""
        self.assertEqual(vm.parse_cidname(ASTDB), {"1001": "Ada Lovelace"})
        self.assertEqual(vm.parse_device_user(DEVICE), {"1001": "1001", "2002": "2002"})

    def test_an_empty_caller_id_family_reads_as_no_one(self):
        self.assertEqual(vm.parse_device_user(""), {})
        self.assertEqual(vm.parse_cidname(""), {})

    def test_users_rows_carry_a_verdict_not_a_missing_value(self):
        self.assertEqual(
            vm.parse_users(USERS), {"1001": "default", "2002": "novm", "3003": ""}
        )


class Verdicts(unittest.TestCase):
    """The decision table, in the order the facts fail."""

    def judge(self, *, loaded, users, astdb, ext="1001", cidname=None, device_user=None):
        # Wired by default: the four-fact table below is about the mailbox, so
        # only the tests that are *about* the caller-id gate leave it out.
        return vm.verdict(
            intent(ext),
            loaded=loaded,
            users=users,
            astdb=astdb,
            cidname={"1001": "Ada Lovelace", "2002": "Two"} if cidname is None else cidname,
            device_user={"1001": "1001", "2002": "2002"} if device_user is None else device_user,
        )

    def test_an_extension_the_switch_cannot_name_is_reported_before_the_box(self):
        """The estate's second `*97` failure, and the one a box-shaped check
        cannot see: the mailbox exists, every row agrees about it, and the call
        still ends one second in because `macro-user-callerid` could not turn
        the caller id into an extension."""
        finding = self.judge(
            loaded={"1001": "default"},
            users={"1001": "default"},
            astdb={"1001": "default"},
            cidname={},
            device_user={},
        )
        self.assertEqual(finding.state, "no-caller-id")
        self.assertIn("DEVICE/1001/user", finding.repair)
        self.assertIn("AMPUSER/1001/cidname", finding.repair)
        self.assertFalse(finding.ok)

    def test_an_empty_cidname_is_the_same_as_a_missing_one(self):
        """`macro-user-callerid` reads the attribute, not the key: a cidname
        that is present and blank blanks AMPUSER just as well."""
        finding = self.judge(
            loaded={"1001": "default"},
            users={"1001": "default"},
            astdb={"1001": "default"},
            cidname={"1001": ""},
            device_user={"1001": "1001"},
        )
        self.assertEqual(finding.state, "no-caller-id")
        self.assertIn("cidname", finding.detail)

    def test_the_estate_s_first_failure_is_a_missing_mailbox(self):
        """Every row FreePBX's own create path produced: no box anywhere, and the
        user row saying so. The missing box is reported first because it is the
        fact `*97` needs, and it is what an apply creates."""
        finding = self.judge(loaded={}, users={"1001": "novm"}, astdb={"1001": "novm"})
        self.assertEqual(finding.state, "no-mailbox")
        self.assertIn("addMailbox(1001)", finding.repair)
        self.assertFalse(finding.ok)

    def test_a_box_that_exists_while_the_extension_says_novm(self):
        finding = self.judge(
            loaded={"1001": "default"}, users={"1001": "novm"}, astdb={"1001": "default"}
        )
        self.assertEqual(finding.state, "not-enabled")
        self.assertIn("users.voicemail", finding.repair)

    def test_a_box_the_dialplan_looks_up_in_the_wrong_context(self):
        """The mailbox is real and recorded, and `app-vmmain` still asks for it in
        a context it is not in — the state a hand-added box leaves behind."""
        finding = self.judge(
            loaded={"1001": "default"}, users={"1001": "default"}, astdb={"1001": "device"}
        )
        self.assertEqual(finding.state, "context-disagrees")
        self.assertIn("AMPUSER/1001/voicemail", finding.repair)

    def test_an_absent_astdb_key_is_the_same_disagreement(self):
        finding = self.judge(
            loaded={"1001": "default"}, users={"1001": "default"}, astdb={}
        )
        self.assertEqual(finding.state, "context-disagrees")

    def test_a_mailbox_the_dialplan_resolves_is_ok(self):
        finding = self.judge(
            loaded={"1001": "default"}, users={"1001": "default"}, astdb={"1001": "default"}
        )
        self.assertTrue(finding.ok)
        self.assertEqual(finding.repair, "")


class ApplyScript(unittest.TestCase):
    """What the PHP has to keep saying, checked from the text.

    A rename here does not fail loudly: `addMailbox` would take the settings
    array, find no `vmpwd`, and write a mailbox whose password is empty.
    """

    def test_the_box_is_read_before_it_is_written(self):
        """The read decides between create and leave-alone, so it has to come
        first: `addMailbox` on a box that already exists would move its messages'
        context out from under anyone who has any."""
        self.assertLess(
            vm.APPLY_SCRIPT.index("$vm->getMailbox"),
            vm.APPLY_SCRIPT.index("$vm->addMailbox"),
        )

    def test_the_pin_goes_in_under_the_key_the_module_reads(self):
        self.assertIn("'vmpwd'", vm.APPLY_SCRIPT)

    def test_the_dialplan_s_own_key_is_written_too(self):
        """`users.voicemail` is what FreePBX shows; `AMPUSER/<ext>/voicemail` is
        what `Macro(get-vmcontext)` resolves. Writing one and not the other is
        the disagreement this tool reports."""
        self.assertIn("UPDATE users SET voicemail", vm.APPLY_SCRIPT)
        self.assertIn("database_put('AMPUSER'", vm.APPLY_SCRIPT)
        self.assertIn("'/voicemail'", vm.APPLY_SCRIPT)

    def test_the_intent_arrives_out_of_the_argument_list(self):
        """It carries a PIN, and `ps` can read a command line."""
        self.assertIn("getenv('ZEUS_VM_INTENTS')", vm.APPLY_SCRIPT)

    def test_the_caller_id_pair_is_written_from_the_pbx_s_own_rows(self):
        """The device keys come from the devices table rather than from an
        invented value, which is what makes this the framework's set."""
        self.assertIn("database_put('DEVICE'", vm.APPLY_SCRIPT)
        self.assertIn("FROM devices WHERE id = ?", vm.APPLY_SCRIPT)


if __name__ == "__main__":
    unittest.main()
