#!/usr/bin/env python3
"""The outbound route that makes a dialled number reach the PSTN.

`pbx/outbound_route.py` closes the gap the legacy migration left open: Zeus had
no writer for outbound routes, the live route led with a bare `X.`, and a
ten-digit call left the PBX without the `1` VoIP.ms terminates on. What is
pinned here is the decision, not the box:

  * **The legacy normalisation, restored exactly** — seven-digit -> `1413`,
    ten-digit -> `1`, eleven-digit and `011.` through as-is. A ten-digit call
    that is not given the country code is the reported bug.
  * **The trunk, and its order** — a route that does not use the VoIP.ms trunk
    has nowhere to send the call; one that tries a dead trunk first is the same
    symptom whether or not the good trunk is listed behind it.
  * **Priority** — FreePBX evaluates routes in sequence order, so a catch-all
    ahead of the route swallows the call before the normalisation is reached.
    The route is lifted above it, and *only* above it: every other route keeps
    its order, because reordering a live dial plan is the decision this tool
    exists to make explicit.
  * **Refusal** — no PBX, no trunk, no route table is exit 2, never a pass.

Run:  python3 -m unittest discover -s pbx/tests -v
"""
from __future__ import annotations

import contextlib
import io
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import outbound_route as or_  # noqa: E402

TRUNK_ID = 7
TRUNK = "voipms_pjsip"


def _route(route_id, name, seq, patterns=(), trunks=()):
    return or_.Route(route_id=route_id, name=name, seq=seq, patterns=tuple(patterns),
                     trunks=tuple(trunks))


def _state(routes, trunk_id=TRUNK_ID, trunk_name=TRUNK):
    return or_.State(routes=tuple(routes), trunk_id=trunk_id, trunk_name=trunk_name)


def _in_sync_state(extra_routes=()):
    """A PSTN route that is already correct, plus whatever else the box has."""
    pstn = _route(1, "PSTN", 0, patterns=or_.desired_patterns(),
                  trunks=[(TRUNK_ID, TRUNK)])
    return _state([pstn, *extra_routes])


class LegacyNormalisationTest(unittest.TestCase):
    def test_a_ten_digit_call_is_given_the_country_code(self):
        # The reported call: 4134210134 must leave as 14134210134.
        self.assertIn(("", "NXXNXXXXXX", "1"), or_.LEGACY_PATTERNS)

    def test_the_seven_digit_rule_carries_the_area_code(self):
        self.assertIn(("", "NXXXXXX", "1413"), or_.LEGACY_PATTERNS)

    def test_eleven_digits_and_international_pass_through(self):
        self.assertIn(("", "1NXXNXXXXXX", ""), or_.LEGACY_PATTERNS)
        self.assertIn(("", "011.", ""), or_.LEGACY_PATTERNS)

    def test_desired_patterns_is_the_legacy_set(self):
        self.assertEqual(
            {(p.prefix, p.match, p.prepend) for p in or_.desired_patterns()},
            set(or_.LEGACY_PATTERNS),
        )


class CatchAllTest(unittest.TestCase):
    def test_x_dot_is_a_catch_all_in_either_spelling(self):
        self.assertTrue(or_.is_catch_all(or_.Pattern("", "X.")))
        self.assertTrue(or_.is_catch_all(or_.Pattern("", "_x.")))

    def test_the_portal_dialplan_placeholder_is_a_catch_all(self):
        # `exten => _Z.` — Z is 1-9 and `.` is one-or-more, so it matches every
        # ordinary number a phone dials. This is the shape that broke outbound.
        self.assertTrue(or_.is_catch_all(or_.Pattern("", "Z.")))
        self.assertTrue(or_.is_catch_all(or_.Pattern("", "_z!")))

    def test_a_prefix_takes_it_out_of_catch_all(self):
        self.assertFalse(or_.is_catch_all(or_.Pattern("9", "X.")))

    def test_the_legacy_patterns_are_not_catch_alls(self):
        for pattern in or_.desired_patterns():
            self.assertFalse(or_.is_catch_all(pattern), pattern)


class TrunkQueryTest(unittest.TestCase):
    def test_the_trunk_table_key_is_trunkid(self):
        # The live box is FreePBX's own schema: `trunks.trunkid`, not
        # `trunk_id`. A `t.trunk_id` join is a hard SQL error there — the bug
        # that would have made this tool fail on the box it was written for.
        self.assertIn("t.trunkid = a.trunk_id", or_.TRUNKS_QUERY)
        self.assertNotIn("t.trunk_id", or_.TRUNKS_QUERY)


class ParsingTest(unittest.TestCase):
    def test_a_route_with_no_sequence_row_is_still_parsed(self):
        rows = or_.parse_routes("1\tPSTN\t0\n2\tOTHER\t999999\n")
        self.assertEqual(rows, [(1, "PSTN", 0), (2, "OTHER", 999999)])

    def test_a_non_numeric_seq_sorts_last_rather_than_crashing(self):
        self.assertEqual(or_.parse_routes("1\tPSTN\t\n")[0][2], 10**9)

    def test_patterns_and_trunks_carry_through(self):
        patterns = or_.parse_patterns("1\t\tNXXNXXXXXX\t1\n")
        self.assertEqual(patterns[1], (or_.Pattern("", "NXXNXXXXXX", "1"),))
        trunks = or_.parse_trunks("1\t7\t0\tvoipms_pjsip\n")
        self.assertEqual(trunks[1], ((7, "voipms_pjsip"),))

    def test_build_routes_joins_the_three_tables(self):
        routes = or_.build_routes(
            or_.parse_routes("1\tPSTN\t0\n"),
            or_.parse_patterns("1\t\tX.\t\n"),
            or_.parse_trunks("1\t7\t0\tvoipms_pjsip\n"),
        )
        self.assertEqual(routes[0].patterns[0].match, "X.")
        self.assertEqual(routes[0].trunks, ((7, "voipms_pjsip"),))


class JudgeTest(unittest.TestCase):
    def test_a_correct_route_is_in_sync(self):
        findings, plan = or_.judge(_in_sync_state(), "PSTN")
        self.assertEqual(findings, [])
        self.assertFalse(plan.created)

    def test_a_missing_route_is_named_and_planned(self):
        findings, plan = or_.judge(_state([]), "PSTN")
        self.assertEqual([f.state for f in findings], ["no-route"])
        self.assertTrue(plan.created)

    def test_the_live_catch_all_route_is_pattern_drift(self):
        # What the estate actually had: one route, first pattern `X.`.
        route = _route(1, "PSTN", 0, patterns=[or_.Pattern("", "X.")],
                       trunks=[(TRUNK_ID, TRUNK)])
        findings, _ = or_.judge(_state([route]), "PSTN")
        self.assertIn("patterns", [f.state for f in findings])

    def test_a_route_without_the_trunk_is_named(self):
        route = _route(1, "PSTN", 0, patterns=or_.desired_patterns())
        findings, plan = or_.judge(_state([route]), "PSTN")
        self.assertIn("no-trunk", [f.state for f in findings])
        self.assertEqual(plan.trunk_ids, (TRUNK_ID,))

    def test_a_trunk_in_second_place_is_named(self):
        route = _route(1, "PSTN", 0, patterns=or_.desired_patterns(),
                       trunks=[(99, "voipms_iax"), (TRUNK_ID, TRUNK)])
        findings, plan = or_.judge(_state([route]), "PSTN")
        self.assertIn("trunk-order", [f.state for f in findings])
        # The dead trunk is kept, after the good one — never silently dropped.
        self.assertEqual(plan.trunk_ids, (TRUNK_ID, 99))

    def test_a_catch_all_ahead_of_the_route_is_shadowing(self):
        other = _route(2, "CATCHALL", 0, patterns=[or_.Pattern("", "X.")],
                       trunks=[(TRUNK_ID, TRUNK)])
        pstn = _route(1, "PSTN", 1, patterns=or_.desired_patterns(),
                      trunks=[(TRUNK_ID, TRUNK)])
        findings, plan = or_.judge(_state([other, pstn]), "PSTN")
        self.assertIn("shadowed", [f.state for f in findings])
        # PSTN moves above the catch-all, and the catch-all is not deleted.
        self.assertEqual(plan.order, (1, 2))

    def test_a_duplicate_route_ahead_is_shadowing_too(self):
        # The live box: three routes share the same dial patterns, and the one
        # that runs first answers the call — so `PSTN` never runs however
        # correct its own patterns are.
        voipms = _route(1, "voipms", 0, patterns=or_.desired_patterns(),
                        trunks=[(0, "voipms")])
        pstn = _route(2, "PSTN", 1, patterns=or_.desired_patterns(),
                      trunks=[(TRUNK_ID, TRUNK)])
        findings, plan = or_.judge(_state([voipms, pstn]), "PSTN")
        self.assertIn("shadowed", [f.state for f in findings])
        self.assertEqual(plan.order, (2, 1))

    def test_a_route_ahead_with_wider_patterns_is_shadowing(self):
        wider = _route(1, "WIDER", 0,
                       patterns=[or_.Pattern("", "X.")], trunks=[(TRUNK_ID, TRUNK)])
        pstn = _route(2, "PSTN", 1, patterns=or_.desired_patterns(),
                      trunks=[(TRUNK_ID, TRUNK)])
        findings, _ = or_.judge(_state([wider, pstn]), "PSTN")
        self.assertIn("shadowed", [f.state for f in findings])

    def test_a_route_ahead_that_is_not_a_catch_all_is_left_alone(self):
        # A specific route the operator put first keeps its priority.
        other = _route(2, "SPECIFIC", 0, patterns=[or_.Pattern("", "NXXNXXXXXX", "1")],
                       trunks=[(TRUNK_ID, TRUNK)])
        pstn = _route(1, "PSTN", 1, patterns=or_.desired_patterns(),
                      trunks=[(TRUNK_ID, TRUNK)])
        findings, plan = or_.judge(_state([other, pstn]), "PSTN")
        self.assertEqual(findings, [])
        self.assertEqual(plan.order, (2, 1))

    def test_reordering_keeps_every_other_route_in_place(self):
        a = _route(10, "FIRST", 0, patterns=[or_.Pattern("", "NXXNXXXXXX", "1")],
                   trunks=[(TRUNK_ID, TRUNK)])
        catch = _route(11, "CATCHALL", 1, patterns=[or_.Pattern("", "X.")],
                       trunks=[(TRUNK_ID, TRUNK)])
        pstn = _route(12, "PSTN", 2, patterns=or_.desired_patterns(),
                      trunks=[(TRUNK_ID, TRUNK)])
        last = _route(13, "LAST", 3, patterns=[or_.Pattern("", "011.", "")],
                      trunks=[(TRUNK_ID, TRUNK)])
        _, plan = or_.judge(_state([a, catch, pstn, last]), "PSTN")
        self.assertEqual(plan.order, (10, 12, 11, 13))


class RenderSqlTest(unittest.TestCase):
    def test_the_apply_replaces_patterns_trunks_and_the_whole_sequence(self):
        plan = or_.Plan(route_id=1, name="PSTN", patterns=or_.desired_patterns(),
                        trunk_ids=(7,), order=(1, 2), created=False)
        sql = or_.render_apply_sql(plan)
        self.assertIn("DELETE FROM outbound_route_patterns WHERE route_id = 1", sql)
        self.assertIn("'NXXNXXXXXX'", sql)
        self.assertIn("'1'", sql)
        self.assertIn("DELETE FROM outbound_route_trunks WHERE route_id = 1", sql)
        self.assertIn("VALUES (1, 7, 0)", sql)
        self.assertIn("DELETE FROM outbound_route_sequence", sql)
        self.assertIn("INSERT INTO outbound_route_sequence (route_id, seq) VALUES (1, 0)", sql)
        self.assertIn("(2, 1)", sql)

    def test_a_quote_in_a_name_cannot_break_out(self):
        self.assertEqual(or_.quote("O'Brien"), "'O''Brien'")


class MainTest(unittest.TestCase):
    """Exit codes and the write path, with the PBX faked out."""

    def _run(self, args, states, mysql=None):
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.object(or_, "load_state", side_effect=list(states)), \
             mock.patch.object(or_, "mysql", side_effect=mysql or (lambda *a, **k: "")), \
             mock.patch.object(or_, "reload_pbx", return_value=None):
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                rc = or_.main(args)
        return rc, out.getvalue(), err.getvalue()

    def test_an_in_sync_route_is_a_pass_and_writes_nothing(self):
        def boom(*_a, **_k):
            raise AssertionError("an in-sync route must not be written")
        rc, out, _ = self._run(["--local", "--check"], [_in_sync_state()], mysql=boom)
        self.assertEqual(rc, 0)
        self.assertIn("normalises", out)

    def test_drift_without_apply_is_one_and_writes_nothing(self):
        def boom(*_a, **_k):
            raise AssertionError("a check must not write")
        route = _route(1, "PSTN", 0, patterns=[or_.Pattern("", "X.")],
                       trunks=[(TRUNK_ID, TRUNK)])
        rc, _, err = self._run(["--local", "--check"], [_state([route])], mysql=boom)
        self.assertEqual(rc, 1)
        self.assertIn("patterns", err)

    def test_apply_creates_the_route_and_converges(self):
        def fake_mysql(sql, **_k):
            if "LAST_INSERT_ID" in sql:
                return "1\n"
            return ""
        rc, out, err = self._run(["--local", "--apply"], [_state([]), _in_sync_state()],
                                 mysql=fake_mysql)
        self.assertEqual(rc, 0, err)
        self.assertIn("converged", out)

    def test_an_apply_that_did_not_take_is_a_failure(self):
        route = _route(1, "PSTN", 0, patterns=[or_.Pattern("", "X.")],
                       trunks=[(TRUNK_ID, TRUNK)])
        rc, _, err = self._run(["--local", "--apply"],
                               [_state([route]), _state([route])])
        self.assertEqual(rc, 1)
        self.assertIn("did not converge", err)

    def test_no_trunk_is_cannot_tell_not_a_pass(self):
        rc, _, err = self._run(["--local", "--check"], [_state([], trunk_id=None)])
        self.assertEqual(rc, 2)
        self.assertIn("no trunk named", err)

    def test_no_container_is_cannot_tell(self):
        with mock.patch.object(or_.pbx_db, "resolve_container", return_value=""):
            out, err = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                rc = or_.main(["--check"])
        self.assertEqual(rc, 2)
        self.assertIn("no FreePBX container", err.getvalue())
