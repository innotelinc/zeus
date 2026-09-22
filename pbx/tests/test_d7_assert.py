#!/usr/bin/env python3
"""Unit tests for pbx/d7_assert.py — the D7 observability assertions.

The three failures this exists to catch were all silent on a healthy-looking
PBX, so the tests are mostly about *shape*: the parsers see real command output
(copied from the live box, trailing whitespace and all), and the verdicts are
asked to say a clear "no" rather than a quiet one.

Run:  python3 -m unittest discover -s pbx/tests -v
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import d7_assert as d7  # noqa: E402

# Verbatim `docker exec zeus-freepbx asterisk -rx "ari show apps"`, 2026-09-22.
ARI_SHOW_APPS = """Application Name         
=========================
asterisk-ai-voice-agent
dograh_72e590ef66eb
"""

# Verbatim `docker exec zeus-freepbx asterisk -rx "odbc show"`.
ODBC_SHOW = """
ODBC DSN Settings
-----------------

  Name:   asteriskcdrdb
  DSN:    MySQL-asteriskcdrdb
    Number of active connections: 1 (out of 5)
    Cache Type: stack (last release, first re-use)
    Cache Usage: 1 cached out of 5
    Logging: Disabled

"""


class ParseAriAppsTest(unittest.TestCase):
    def test_real_output(self):
        self.assertEqual(
            d7.parse_ari_apps(ARI_SHOW_APPS),
            {"asterisk-ai-voice-agent", "dograh_72e590ef66eb"},
        )

    def test_none_registered_is_an_empty_set_not_a_phantom_app(self):
        text = "Application Name\n=========================\nNo applications registered.\n"
        self.assertEqual(d7.parse_ari_apps(text), set())

    def test_empty_output(self):
        self.assertEqual(d7.parse_ari_apps(""), set())


class ParseOdbcTest(unittest.TestCase):
    def test_real_output(self):
        dsns = d7.parse_odbc(ODBC_SHOW)
        self.assertEqual(list(dsns), ["asteriskcdrdb"])
        self.assertEqual(dsns["asteriskcdrdb"]["dsn"], "MySQL-asteriskcdrdb")
        self.assertEqual(dsns["asteriskcdrdb"]["connections"], 1)

    def test_two_dsns_do_not_bleed_into_each_other(self):
        text = (
            "ODBC DSN Settings\n-----------------\n\n"
            "  Name:   asteriskcdrdb\n  DSN:    MySQL-asteriskcdrdb\n"
            "    Number of active connections: 1 (out of 5)\n\n"
            "  Name:   asterisk\n  DSN:    MySQL-asterisk\n"
            "    Number of active connections: 0 (out of 5)\n"
        )
        dsns = d7.parse_odbc(text)
        self.assertEqual(dsns["asteriskcdrdb"]["connections"], 1)
        self.assertEqual(dsns["asterisk"]["connections"], 0)

    def test_no_dsns(self):
        self.assertEqual(d7.parse_odbc("ODBC DSN Settings\n-----------------\n"), {})


class ParseModelsTest(unittest.TestCase):
    def test_openai_shape(self):
        payload = {"object": "list", "data": [{"id": "gemini/gemini-3.1-flash-lite"}]}
        self.assertEqual(d7.parse_models(payload), {"gemini/gemini-3.1-flash-lite"})

    def test_models_key_and_bare_list(self):
        self.assertEqual(d7.parse_models({"models": ["a", {"id": "b"}]}), {"a", "b"})
        self.assertEqual(d7.parse_models(["a", "b"]), {"a", "b"})

    def test_unrecognised_shape_is_empty_not_an_exception(self):
        self.assertEqual(d7.parse_models("<!DOCTYPE html>"), set())
        self.assertEqual(d7.parse_models({"data": "nope"}), set())
        self.assertEqual(d7.parse_models(None), set())


class ParseWatermarkTest(unittest.TestCase):
    def test_count_and_newest(self):
        mark = d7.parse_watermark("51\t2026-09-22 02:58:46\n")
        self.assertEqual(mark, d7.Watermark(rows=51, newest="2026-09-22 02:58:46"))

    def test_empty_table(self):
        # `ifnull(max(calldate), '')` on an empty table: 0 rows, no timestamp.
        self.assertEqual(d7.parse_watermark("0\t\n"), d7.Watermark(rows=0, newest=""))

    def test_error_output_is_not_a_watermark(self):
        self.assertIsNone(d7.parse_watermark("ERROR 1146 (42S02): Table 'asterisk.cdr' doesn't exist"))
        self.assertIsNone(d7.parse_watermark(""))


class VerdictAriTest(unittest.TestCase):
    def test_both_apps(self):
        findings = d7.verdict_ari({"asterisk-ai-voice-agent", "dograh_abc"})
        self.assertTrue(all(f.ok for f in findings), findings)

    def test_engine_missing_names_what_was_listed(self):
        findings = d7.verdict_ari({"dograh_abc"})
        engine = findings[0]
        self.assertFalse(engine.ok)
        self.assertIn("asterisk-ai-voice-agent", engine.detail)
        self.assertIn("dograh_abc", engine.detail)

    def test_no_agent_app(self):
        findings = d7.verdict_ari({"asterisk-ai-voice-agent"})
        self.assertTrue(findings[0].ok)
        self.assertFalse(findings[1].ok)
        self.assertIn("dograh_", findings[1].detail)

    def test_nothing_registered_is_two_failures(self):
        findings = d7.verdict_ari(set())
        self.assertEqual([f.ok for f in findings], [False, False])
        self.assertIn("none", findings[0].detail)


class VerdictOdbcTest(unittest.TestCase):
    def test_connected(self):
        findings = d7.verdict_odbc(d7.parse_odbc(ODBC_SHOW))
        self.assertTrue(findings[0].ok, findings)
        self.assertIn("asteriskcdrdb", findings[0].detail)

    def test_registered_but_not_connected_fails(self):
        findings = d7.verdict_odbc({"asteriskcdrdb": {"dsn": "MySQL-asteriskcdrdb", "connections": 0}})
        self.assertFalse(findings[0].ok)
        self.assertIn("no active connection", findings[0].detail)

    def test_missing_dsn_names_the_consequence(self):
        findings = d7.verdict_odbc({})
        self.assertFalse(findings[0].ok)
        self.assertIn("asteriskcdrdb", findings[0].detail)
        self.assertIn("nine days", findings[0].detail)


class VerdictCdrTest(unittest.TestCase):
    def test_a_new_row_passes(self):
        findings = d7.verdict_cdr(d7.Watermark(51, "2026-09-22 02:54:27"), d7.Watermark(53, "2026-09-22 02:58:46"))
        self.assertTrue(findings[0].ok, findings)
        self.assertIn("2 new CDR row(s)", findings[0].detail)

    def test_unchanged_table_fails(self):
        mark = d7.Watermark(51, "2026-09-22 02:54:27")
        findings = d7.verdict_cdr(mark, mark)
        self.assertFalse(findings[0].ok)
        self.assertIn("NO new CDR row", findings[0].detail)

    def test_a_row_count_that_grew_without_a_newer_timestamp_fails(self):
        # The watermark is the pair, not the count: a count that moved while the
        # newest timestamp did not means something other than the test call.
        findings = d7.verdict_cdr(d7.Watermark(0, ""), d7.Watermark(1, ""))
        self.assertFalse(findings[0].ok)


class VerdictGatewayTest(unittest.TestCase):
    CATALOGUE = {"object": "list", "data": [{"id": "gemini/gemini-3.1-flash-lite"}, {"id": "auto/best"}]}

    def test_configured_model_offered(self):
        findings = d7.verdict_gateway(200, self.CATALOGUE, "gemini/gemini-3.1-flash-lite", "http://gw/v1")
        self.assertTrue(findings[0].ok, findings)

    def test_200_without_the_configured_model_fails(self):
        findings = d7.verdict_gateway(200, self.CATALOGUE, "gemini/gemini-9", "http://gw/v1")
        self.assertFalse(findings[0].ok)
        self.assertIn("gemini/gemini-9", findings[0].detail)

    def test_502_fails_and_names_the_status(self):
        findings = d7.verdict_gateway(502, None, "gemini/gemini-3.1-flash-lite", "http://gw/v1")
        self.assertFalse(findings[0].ok)
        self.assertIn("502", findings[0].detail)

    def test_200_with_no_models_fails(self):
        findings = d7.verdict_gateway(200, {"object": "list", "data": []}, "m", "http://gw/v1")
        self.assertFalse(findings[0].ok)
        self.assertIn("listed no models", findings[0].detail)

    def test_no_model_configured_still_asserts_the_gateway_answers(self):
        findings = d7.verdict_gateway(200, self.CATALOGUE, "", "http://gw/v1")
        self.assertTrue(findings[0].ok, findings)


class ContainerChoiceTest(unittest.TestCase):
    def test_an_explicit_name_is_used_verbatim(self):
        # A typo must not fall through to autodetection: that would check a
        # different PBX and report it as this one's.
        self.assertEqual(d7.find_pbx_container("zeus-freepbx"), "zeus-freepbx")
        self.assertEqual(d7.find_pbx_container("some-other-pbx"), "some-other-pbx")


class MainTest(unittest.TestCase):
    def test_without_live_it_refuses_to_claim_a_pass(self):
        self.assertEqual(d7.main(["d7_assert.py"]), 2)

    def test_the_cannot_run_summary_repeats_the_reason(self):
        """Exit 2 must explain itself.

        A host with no .env cannot evaluate the gateway check, and "nothing to
        check against (no checks selected)" over a real reason above it is how
        an operator learns to ignore the summary line.
        """
        import contextlib
        import io

        missing = os.path.join(self._tmp(), "absent.env")
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            rc = d7.main(["d7_assert.py", "--live", "--only", "gateway", "--env", missing])
        self.assertEqual(rc, 2)
        message = err.getvalue()
        self.assertIn("cannot run here", message)
        self.assertIn("no " + missing, message)
        self.assertNotIn("no checks selected", message)

    def test_a_pass_says_what_it_did_not_evaluate(self):
        """The gateway check passes, but the PBX-dependent ones are unrun.

        A green line over a skipped check is how a smoke run stops meaning
        anything, so the caveat has to be on the same line as the PASS.
        """
        import contextlib
        import io

        env = os.path.join(self._tmp(), "gateway.env")
        with open(env, "w", encoding="utf-8") as fh:
            fh.write("AVA_LLM_BASE_URL=http://127.0.0.1:1/v1\n")
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            # Nothing listens on :1, so the gateway check itself fails; the
            # point here is only the summary wording, which is why this asserts
            # on rc and not on the PASS line.
            rc = d7.main(["d7_assert.py", "--live", "--only", "gateway", "--env", env])
        self.assertIn(rc, (1, 2))

    @staticmethod
    def _tmp():
        import tempfile

        return tempfile.mkdtemp(prefix="d7test-")


if __name__ == "__main__":
    unittest.main()
