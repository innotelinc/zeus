#!/usr/bin/env python3
"""The credential scanner must stay clean *without* going blind.

The whole-tree scan has to come back clean on this repository, and the one thing
that made it red was a deliberately committed private-key fixture
(`scripts/fixtures/cerulean-api-fixture.key`, generated for the Cerulean
trust-plane test). A leaked PEM and a fixture PEM are byte-identical at the
header, so the exemption cannot be inferred from the path — it is listed
explicitly in the scanner's ALLOWLIST, together with the single rule it
silences. These tests pin that shape:

  * the named fixture scans clean;
  * the same bytes at any *other* path still trip — the exemption is per-file,
    not per-shape;
  * a *different* rule still fires on the allowlisted file — so a provider key
    committed into the fixture is still caught;
  * the exemption survives the revision-prefixed labels used by `--history`;
  * every entry names a file that exists, so a rename cannot leave a stale (and
    therefore silently widened) exemption behind.

Run:  python3 -m unittest discover -s pbx/tests -v
"""
import importlib.util
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, "..", ".."))
SCANNER = os.path.join(ROOT, "scripts", "secret-scan.py")

# The module name has a hyphen, so it cannot be imported by name.
_spec = importlib.util.spec_from_file_location("secret_scan", SCANNER)
sc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sc)

FIXTURE = "scripts/fixtures/cerulean-api-fixture.key"

# Assembled at run time on purpose. This file is itself scanned, and a literal
# PEM header or `sk-...` string is credential-shaped — assembling it keeps the
# test honest (it still contains the shape at run time) without tripping the
# gate it is testing.
PROVIDER_KEY = "sk-" + "a" * 24 + "\n"


def _fixture_text():
    with open(os.path.join(ROOT, FIXTURE), encoding="utf-8") as fh:
        return fh.read()


def _rules(findings):
    return {rule for _label, _line, rule, _masked in findings}


class TheFixtureIsClean(unittest.TestCase):
    def test_the_allowlisted_fixture_has_no_findings(self):
        self.assertEqual(sc.scan_text(FIXTURE, _fixture_text()), [])

    def test_the_allowlisted_fixture_is_a_real_private_key(self):
        """The exemption is for what actually tripped, not for a file that no
        longer looks like a key — a stale entry would otherwise hide a rename.

        Checked through the scanner's own rule, so the literal PEM header stays
        out of this file (which is scanned).
        """
        rule = dict(sc.SHAPES)["private-key-block"]
        self.assertIsNotNone(rule.search(_fixture_text()))


class TheExemptionIsNarrow(unittest.TestCase):
    def test_the_same_bytes_elsewhere_still_trip(self):
        findings = sc.scan_text("some/other/fixture.key", _fixture_text())
        self.assertIn("private-key-block", _rules(findings))

    def test_a_different_rule_still_fires_on_the_allowlisted_file(self):
        findings = sc.scan_text(FIXTURE, _fixture_text() + PROVIDER_KEY)
        rules = _rules(findings)
        self.assertNotIn("private-key-block", rules, "the entry did not apply")
        self.assertIn(
            "provider-api-key",
            rules,
            "the allowlist must silence only the one named rule",
        )

    def test_is_allowlisted_matches_the_bare_and_history_labels(self):
        self.assertTrue(sc.is_allowlisted(FIXTURE, "private-key-block"))
        self.assertTrue(
            sc.is_allowlisted(f"0caf908:{FIXTURE}", "private-key-block")
        )

    def test_is_allowlisted_does_not_match_another_rule_or_path(self):
        self.assertFalse(sc.is_allowlisted(FIXTURE, "provider-api-key"))
        self.assertFalse(
            sc.is_allowlisted("scripts/fixtures/other.key", "private-key-block")
        )
        self.assertFalse(
            sc.is_allowlisted(
                f"0caf908:scripts/fixtures/cerulean-api-fixture.key.bak",
                "private-key-block",
            )
        )


class EveryEntryNamesARealFile(unittest.TestCase):
    def test_the_allowlist_does_not_accumulate_stale_paths(self):
        self.assertTrue(sc.ALLOWLIST, "the allowlist is empty?")
        for path, rules in sc.ALLOWLIST.items():
            self.assertTrue(rules, f"{path} silences nothing")
            self.assertTrue(
                os.path.isfile(os.path.join(ROOT, path)),
                f"{path} is allowlisted but does not exist — remove the entry",
            )


if __name__ == "__main__":
    unittest.main()
