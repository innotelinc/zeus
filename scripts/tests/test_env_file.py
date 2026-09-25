#!/usr/bin/env python3
"""Unit tests for scripts/env_file.py — the .env reader/writer.

The deploy path rotates secrets into `.env` (the FreePBX AMI/ARI secrets, the
portal's voice-context secret). That file holds the estate's other secrets and
is hand-curated, so the contract that matters is narrow and unforgiving: set one
key, change nothing else, and refuse anything that would corrupt the file rather
than write it and hope.

Run:  python3 -m unittest discover -s scripts/tests -v
"""
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import env_file as ef  # noqa: E402


class ReadTest(unittest.TestCase):
    def test_reads_a_plain_value(self):
        self.assertEqual(ef.read_key("A=1\nVOICE_CONTEXT_SECRET=abc\n", "VOICE_CONTEXT_SECRET"), "abc")

    def test_missing_key_is_none_not_empty(self):
        self.assertIsNone(ef.read_key("A=1\n", "VOICE_CONTEXT_SECRET"))

    def test_empty_value_reads_as_empty_string(self):
        self.assertEqual(ef.read_key("VOICE_CONTEXT_SECRET=\n", "VOICE_CONTEXT_SECRET"), "")

    def test_strips_quotes(self):
        self.assertEqual(ef.read_key('K="abc"\n', "K"), "abc")
        self.assertEqual(ef.read_key("K='abc'\n", "K"), "abc")

    def test_strips_an_inline_comment_only_after_whitespace(self):
        self.assertEqual(ef.read_key("K=abc  # note\n", "K"), "abc")
        # a '#' glued to the value is part of it, not a comment
        self.assertEqual(ef.read_key("K=abc#def\n", "K"), "abc#def")

    def test_last_occurrence_wins_like_compose(self):
        self.assertEqual(ef.read_key("K=one\nK=two\n", "K"), "two")

    def test_a_prefix_of_another_key_is_not_a_match(self):
        self.assertIsNone(ef.read_key("VOICE_CONTEXT_SECRET_OLD=x\n", "VOICE_CONTEXT_SECRET"))


class UpsertTest(unittest.TestCase):
    def test_sets_an_absent_key_without_touching_the_rest(self):
        before = "# header\nA=1\n\n# tail comment\nB=2\n"
        after = ef.upsert(before, "K", "v")
        self.assertTrue(after.startswith(before.rstrip("\n")))
        self.assertIn("K=v\n", after)

    def test_replaces_in_place_keeping_the_line_position(self):
        after = ef.upsert("A=1\nK=old\nB=2\n", "K", "new")
        self.assertEqual(after, "A=1\nK=new\nB=2\n")

    def test_collapses_a_duplicate_key_to_one_line(self):
        after = ef.upsert("K=one\nA=1\nK=two\n", "K", "final")
        self.assertEqual(after, "K=final\nA=1\n")

    def test_ends_with_exactly_one_newline(self):
        for text in ("A=1", "A=1\n", "A=1\n\n\n"):
            self.assertTrue(ef.upsert(text, "K", "v").endswith("v\n"))
            self.assertFalse(ef.upsert(text, "K", "v").endswith("v\n\n"))

    def test_refuses_a_value_with_a_newline(self):
        with self.assertRaises(ef.Refused):
            ef.upsert("A=1\n", "K", "one\ntwo")

    def test_refuses_a_key_that_is_not_a_key(self):
        for key in ("K=1", "", "K-1", "K 1"):
            with self.assertRaises(ef.Refused):
                ef.upsert("A=1\n", key, "v")

    def test_a_value_containing_the_sed_delimiter_is_written_verbatim(self):
        """The reason this is not a `sed -i s|^K=.*|K=V|` one-liner."""
        tricky = "p|pe&/\\$`\"' end"
        after = ef.upsert("A=1\nK=old\nB=2\n", "K", tricky)
        self.assertEqual(ef.read_key(after, "K"), tricky)
        self.assertIn("B=2\n", after)


class AtomicWriteTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(lambda: __import__("shutil").rmtree(self.tmp, ignore_errors=True))
        self.path = os.path.join(self.tmp, ".env")

    def test_writes_and_is_not_world_readable(self):
        ef.write_atomic(self.path, "K=v\n")
        with open(self.path, encoding="utf-8") as fh:
            self.assertEqual(fh.read(), "K=v\n")
        self.assertEqual(os.stat(self.path).st_mode & 0o077, 0)

    def test_leaves_no_temp_file_behind(self):
        ef.write_atomic(self.path, "A=1\n")
        ef.write_atomic(self.path, "A=2\n")
        self.assertEqual(os.listdir(self.tmp), [".env"])


if __name__ == "__main__":
    unittest.main()
