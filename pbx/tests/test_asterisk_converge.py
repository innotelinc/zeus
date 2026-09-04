#!/usr/bin/env python3
"""Unit tests for pbx/asterisk_converge.py — shared-voice-plane merge semantics.

Run:  python3 -m unittest discover -s pbx/tests -v
"""
import os
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import asterisk_converge as ac  # noqa: E402


class SplitBlocksTest(unittest.TestCase):
    def test_attaches_leading_comment_run_to_context(self):
        text = (
            "; doc header for the context below\n"
            "; second line\n"
            "[dograh-inbound]\nexten => 8000,1,NoOp()\n"
            "\n"
            "[from-internal-custom]\nexten => 8001,1,NoOp()\n"
        )
        blocks = ac.split_blocks(text)
        kinds = [b[0] for b in blocks]
        self.assertEqual(kinds, ["ctx", "ctx"])
        # the two comment lines ride along with the first context
        self.assertEqual(blocks[0][2][0:2], ["; doc header for the context below\n",
                                             "; second line\n"])
        self.assertNotIn("; doc header", blocks[1][2][0])


class ReplaceTest(unittest.TestCase):
    ZEUS = (
        "; Zeus portal dialplan\n"
        "[from-zeus-portal]\n"
        "exten => _Z.,1,NoOp(Zeus portal extension ${EXTEN})\n"
        " same => n,Hangup()\n"
    )
    STOCK = (
        "[some-gui-context]\n"
        "exten => 100,1,Answer()\n"
    )

    def test_replaces_in_place_and_preserves_foreign_contexts(self):
        merged = ac.merge_into(self.STOCK, self.ZEUS, owner="zeus")
        self.assertIn("[some-gui-context]", merged)      # foreign survives
        self.assertIn("[from-zeus-portal]", merged)
        self.assertIn("exten => _Z.,1,NoOp", merged)

    def test_idempotent(self):
        once = ac.merge_into(self.STOCK, self.ZEUS, owner="zeus")
        twice = ac.merge_into(once, self.ZEUS, owner="zeus")
        self.assertEqual(once, twice)

    def test_updates_replace_updated_source(self):
        merged = ac.merge_into(self.STOCK, self.ZEUS, owner="zeus")
        updated = self.ZEUS.replace("Hangup()", "Wait(1)\n same => n,Hangup()")
        merged2 = ac.merge_into(merged, updated, owner="zeus")
        self.assertEqual(merged2.count("exten => _Z.,1,NoOp"), 1)
        self.assertIn("Wait(1)", merged2)

    def test_appends_when_context_missing_at_eof(self):
        merged = ac.merge_into("", self.ZEUS, owner="zeus")
        self.assertTrue(merged.startswith("; Zeus portal dialplan\n[from-zeus-portal]"))
        self.assertTrue(merged.endswith(" same => n,Hangup()\n"))

    def test_second_product_replaces_only_its_own_context(self):
        target = ac.merge_into("", self.ZEUS, owner="zeus")
        capstone = (
            "[dograh-inbound]\n"
            "exten => 8000,1,NoOp(Dograh)\n"
            " same => n,Stasis(dograh)\n"
            " same => n,Hangup()\n"
        )
        merged = ac.merge_into(target, capstone, owner="capstone")
        self.assertIn("[from-zeus-portal]", merged)
        self.assertIn("[dograh-inbound]", merged)
        # capstone re-run must not disturb zeus's context
        again = ac.merge_into(merged, capstone, owner="capstone")
        self.assertEqual(again, merged)


class AppendSharedTest(unittest.TestCase):
    """[from-internal-custom] is the shared context: FreePBX's generated
    [from-internal] includes it, and both products add dialable entries."""

    ZEUS_FRAG = (
        "[from-internal-custom]\n"
        "include => from-zeus-portal\n"
    )
    CAP_FRAG = (
        "[from-internal-custom]\n"
        "exten => 8000,1,NoOp(Dialing the IT agent)\n"
        " same => n,Goto(dograh-inbound,8000,1)\n"
    )
    CAP_FRAG_EXT = (
        "[from-internal-custom]\n"
        "exten => 8000,1,NoOp(Dialing the IT agent)\n"
        " same => n,Goto(dograh-inbound,8000,1)\n"
        "\n"
        "exten => 8001,1,NoOp(Dialing the DevOps agent)\n"
        " same => n,Goto(dograh-inbound,8001,1)\n"
    )
    BASE = (
        "; FreePBX-generated extensions_custom.conf content\n"
        "[from-internal-custom]\n"
        "exten => 100,1,NoOp(gui-added)\n"
        "\n"
        "[dograh-inbound]\n"
        "exten => 8000,1,Stasis(dograh)\n"
    )

    def test_zeus_appends_marked_segment_inside_shared_context(self):
        merged = ac.merge_into(self.BASE, self.ZEUS_FRAG, owner="zeus",
                               append_shared={"from-internal-custom"})
        self.assertIn("include => from-zeus-portal", merged)
        self.assertIn("; >>> begin zeus", merged)
        self.assertIn("; >>> end zeus", merged)
        # gui-added and the [dograh-inbound] context untouched
        self.assertIn("exten => 100,1,NoOp(gui-added)", merged)
        self.assertIn("[dograh-inbound]", merged)

    def test_two_products_coexist_and_are_idempotent(self):
        m1 = ac.merge_into(self.BASE, self.ZEUS_FRAG, owner="zeus",
                           append_shared={"from-internal-custom"})
        m2 = ac.merge_into(m1, self.CAP_FRAG, owner="capstone",
                           append_shared={"from-internal-custom"})
        self.assertIn("include => from-zeus-portal", m2)
        self.assertIn("Goto(dograh-inbound,8000,1)", m2)
        # re-running either owner never duplicates and never drops the other
        m3 = ac.merge_into(m2, self.ZEUS_FRAG, owner="zeus",
                           append_shared={"from-internal-custom"})
        m4 = ac.merge_into(m3, self.CAP_FRAG, owner="capstone",
                           append_shared={"from-internal-custom"})
        self.assertEqual(m2, m4)
        self.assertEqual(m2.count("; >>> begin zeus"), 1)
        self.assertEqual(m2.count("; >>> begin capstone"), 1)
        self.assertEqual(m2.count("include => from-zeus-portal"), 1)

    def test_owner_update_replaces_only_its_own_segment(self):
        m1 = ac.merge_into(self.BASE, self.ZEUS_FRAG, owner="zeus",
                           append_shared={"from-internal-custom"})
        m2 = ac.merge_into(m1, self.CAP_FRAG, owner="capstone",
                           append_shared={"from-internal-custom"})
        cap_v2 = self.CAP_FRAG.replace("8000", "8001")
        m3 = ac.merge_into(m2, cap_v2, owner="capstone",
                           append_shared={"from-internal-custom"})
        # capstone's segment updated in place (exten + Goto lines)
        self.assertEqual(m3.count("8001"), 2)
        # old capstone Goto gone; the only remaining 8000 is the separate
        # [dograh-inbound] context that BASE legitimately defines
        self.assertEqual(m3.count("Goto(dograh-inbound,8000,1)"), 0)
        self.assertEqual(m3.count("8000"), 1)
        self.assertIn("include => from-zeus-portal", m3)  # zeus intact

    def test_owner_reapply_is_byte_idempotent_alone(self):
        # Regression: each owner was stripping its segment and re-appending at
        # the tail, so re-running one owner flipped segment order past the
        # other owner's segment (idempotent only as a pair, never alone).
        m1 = ac.merge_into(self.BASE, self.ZEUS_FRAG, owner="zeus",
                           append_shared={"from-internal-custom"})
        m2 = ac.merge_into(m1, self.CAP_FRAG, owner="capstone",
                           append_shared={"from-internal-custom"})
        z1 = ac.merge_into(m2, self.ZEUS_FRAG, owner="zeus",
                           append_shared={"from-internal-custom"})
        z2 = ac.merge_into(z1, self.ZEUS_FRAG, owner="zeus",
                           append_shared={"from-internal-custom"})
        self.assertEqual(z1, z2)  # zeus alone must not shuffle capstone
        c1 = ac.merge_into(m2, self.CAP_FRAG, owner="capstone",
                           append_shared={"from-internal-custom"})
        c2 = ac.merge_into(c1, self.CAP_FRAG, owner="capstone",
                           append_shared={"from-internal-custom"})
        self.assertEqual(c1, c2)
        # segment order preserved: zeus keeps sitting above capstone
        self.assertLess(z1.index("; >>> begin zeus"),
                        z1.index("; >>> begin capstone"))

    def test_replace_preserves_previous_context_trailing_comments(self):
        # Regression: zeus's [from-zeus-portal] gets appended at EOF; on
        # re-parse the previous [dograh-inbound]'s trailing comments become
        # zeus's attributed prefix, and a zeus re-apply used to delete them.
        file_with_trailer = (
            "[dograh-inbound]\n"
            "exten => 8000,1,Stasis(dograh)\n"
            " same => n,Hangup()\n"
            "\n"
            "; Register more Dograh extensions by adding exten lines\n"
            "; exten => _8XXX,1,NoOp(Dograh voice agent inbound ${EXTEN})\n"
        )
        once = ac.merge_into(file_with_trailer, self.ZEUS_FRAG, owner="zeus",
                             append_shared={"from-internal-custom"})
        # dograh's trailing comments still present after the append
        self.assertIn("; Register more Dograh extensions", once)
        # and a zeus re-apply must not eat them
        twice = ac.merge_into(once, self.ZEUS_FRAG, owner="zeus",
                              append_shared={"from-internal-custom"})
        self.assertEqual(once, twice)
        self.assertIn("; Register more Dograh extensions", twice)
        self.assertIn("; >>> begin zeus", twice)

    def test_creates_context_when_missing(self):
        merged = ac.merge_into("", self.ZEUS_FRAG, owner="zeus",
                               append_shared={"from-internal-custom"})
        self.assertIn("[from-internal-custom]", merged)
        self.assertIn("; >>> begin zeus", merged)

    def test_empty_target_is_stable_across_applies(self):
        once = ac.merge_into("", self.ZEUS_FRAG, owner="zeus",
                             append_shared={"from-internal-custom"})
        twice = ac.merge_into(once, self.ZEUS_FRAG, owner="zeus",
                              append_shared={"from-internal-custom"})
        self.assertEqual(once, twice)

    def test_legacy_unmarked_copy_is_absorbed_not_duplicated(self):
        # Pre-converge entrypoints injected the fragment into the shared
        # context WITHOUT ownership markers. Converging must absorb that
        # legacy body into the marked segment, not append a second copy.
        legacy = (
            "[from-internal-custom]\n"
            "exten => 8000,1,NoOp(Dialing the IT agent)\n"
            " same => n,Goto(dograh-inbound,8000,1)\n"
            "\n"
            "exten => 8001,1,NoOp(Dialing the DevOps agent)\n"
            " same => n,Goto(dograh-inbound,8001,1)\n"
            "[dograh-inbound]\n"
            "exten => 8000,1,Stasis(dograh)\n"
        )
        once = ac.merge_into(legacy, self.CAP_FRAG_EXT, owner="capstone",
                             append_shared={"from-internal-custom"})
        # exactly one copy of the shared context body, now under markers
        self.assertEqual(once.count("NoOp(Dialing the IT agent)"), 1)
        self.assertEqual(once.count("NoOp(Dialing the DevOps agent)"), 1)
        self.assertIn("; >>> begin capstone", once)
        # foreign [dograh-inbound] context untouched
        self.assertEqual(once.count("[dograh-inbound]"), 1)
        # idempotent across a second apply
        twice = ac.merge_into(once, self.CAP_FRAG_EXT, owner="capstone",
                              append_shared={"from-internal-custom"})
        self.assertEqual(once, twice)

    def test_legacy_strip_keeps_foreign_marked_segment_and_gui_lines(self):
        # A mixed file mid-migration: GUI-added entry + the legacy unmarked
        # full capstone body + zeus's marked segment. Only the legacy
        # capstone copy is absorbed (byte-identical to the fragment body);
        # everything foreign survives.
        mixed = (
            "[from-internal-custom]\n"
            "exten => 100,1,NoOp(gui-added)\n"
            "\n"
            "exten => 8000,1,NoOp(Dialing the IT agent)\n"
            " same => n,Goto(dograh-inbound,8000,1)\n"
            "\n"
            "exten => 8001,1,NoOp(Dialing the DevOps agent)\n"
            " same => n,Goto(dograh-inbound,8001,1)\n"
            "; >>> begin zeus\n"
            "include => from-zeus-portal\n"
            "; >>> end zeus\n"
            "[dograh-inbound]\n"
            "exten => 8000,1,Stasis(dograh)\n"
        )
        merged = ac.merge_into(mixed, self.CAP_FRAG_EXT, owner="capstone",
                               append_shared={"from-internal-custom"})
        self.assertEqual(merged.count("NoOp(Dialing the IT agent)"), 1)
        self.assertEqual(merged.count("NoOp(Dialing the DevOps agent)"), 1)
        self.assertEqual(merged.count("exten => 100,1,NoOp(gui-added)"), 1)
        self.assertEqual(merged.count("include => from-zeus-portal"), 1)
        self.assertIn("; >>> begin capstone", merged)
        self.assertIn("; >>> begin zeus", merged)
        # idempotent
        again = ac.merge_into(merged, self.CAP_FRAG_EXT, owner="capstone",
                              append_shared={"from-internal-custom"})
        self.assertEqual(merged, again)


class CliTest(unittest.TestCase):
    def test_check_reports_drift_and_exit_code(self):
        with tempfile.TemporaryDirectory() as td:
            target = os.path.join(td, "extensions_custom.conf")
            frag = os.path.join(td, "zeus.conf")
            with open(target, "w") as fh:
                fh.write("[other]\nexten => 1,1,NoOp()\n")
            with open(frag, "w") as fh:
                fh.write("[from-zeus-portal]\nexten => _Z.,1,NoOp()\n")
            r = subprocess.run(
                [sys.executable, os.path.join(os.path.dirname(ac.__file__),
                                              "asterisk_converge.py"),
                 "--target", target, "--source", frag, "--owner", "zeus",
                 "--check"],
                capture_output=True, text=True)
            self.assertEqual(r.returncode, 1)
            self.assertIn("drift", r.stderr)
            # apply, then the check passes and the file is stable
            r2 = subprocess.run(
                [sys.executable, os.path.join(os.path.dirname(ac.__file__),
                                              "asterisk_converge.py"),
                 "--target", target, "--source", frag, "--owner", "zeus"],
                capture_output=True, text=True)
            self.assertEqual(r2.returncode, 0)
            r3 = subprocess.run(
                [sys.executable, os.path.join(os.path.dirname(ac.__file__),
                                              "asterisk_converge.py"),
                 "--target", target, "--source", frag, "--owner", "zeus",
                 "--check"],
                capture_output=True, text=True)
            self.assertEqual(r3.returncode, 0)


if __name__ == "__main__":
    unittest.main()
