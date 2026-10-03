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
import asterisk_converge as ac  # noqa: E402
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
        self.assertIn("catch-all", [f.state for f in findings])

    def test_the_live_working_patterns_are_left_alone(self):
        # What the live box actually runs: both rules, plus an eleven-digit
        # pass-through of its own (`ZNXXNXXXXXX`). The rules are what matter, so
        # this is in sync and an apply rewrites no pattern — only the order.
        live = [or_.Pattern("", "NXXNXXXXXX", "1"),
                or_.Pattern("", "NXXXXXX", "1413"),
                or_.Pattern("", "ZNXXNXXXXXX", "")]
        route = _route(2, "PSTN", 1, patterns=live, trunks=[(TRUNK_ID, TRUNK)])
        voipms = _route(1, "voipms", 0, patterns=live, trunks=[(0, "voipms")])
        findings, plan = or_.judge(_state([voipms, route]), "PSTN")
        self.assertEqual([f.state for f in findings], ["shadowed"])
        self.assertEqual(plan.patterns, tuple(live))
        self.assertEqual(plan.order, (2, 1))

    def test_a_route_missing_the_country_code_rule_is_drift(self):
        # The failure this tool exists for: the route dials ten digits as-is.
        route = _route(1, "PSTN", 0,
                       patterns=[or_.Pattern("", "NXXXXXX", "1413"),
                                 or_.Pattern("", "ZNXXNXXXXXX", "")],
                       trunks=[(TRUNK_ID, TRUNK)])
        findings, plan = or_.judge(_state([route]), "PSTN")
        self.assertIn("patterns", [f.state for f in findings])
        # A missing rule is repaired with the legacy set.
        self.assertEqual(plan.patterns, or_.desired_patterns())

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


class InternalNumbersTest(unittest.TestCase):
    """A number the estate already answers inwards is answered locally, first.

    A route is a pattern (it cannot be told to *not* match a number), so an
    internal number can only be kept off the trunk, and off the inter-digit
    hold, by an exact destination written ahead of every route.
    """

    def test_a_pattern_row_is_not_a_number(self):
        # `_X.`/`_2XX` is not something a person dials — writing it as an exact
        # destination would put a wildcard in front of the routes.
        routes = or_.parse_incoming_numbers("_X.\tdograh-inbound,8003,1\n_2XX\text-group,329,1\n")
        self.assertEqual(routes, {})

    def test_a_country_code_is_stripped_to_the_dialled_form(self):
        routes = or_.parse_incoming_numbers("14132951200\tdograh-inbound,8003,1\n")
        self.assertEqual(routes, {"4132951200": "dograh-inbound,8003,1"})

    def test_a_blank_destination_is_dropped(self):
        self.assertEqual(or_.parse_incoming_numbers("4132951200\t\n"), {})

    def test_a_destination_that_could_inject_a_dialplan_line_is_dropped(self):
        self.assertEqual(
            or_.parse_incoming_numbers("4132951200\tdograh-inbound,8003,1;Hangup()\n"),
            {})

    def test_an_extension_backed_number_dials_ext_local(self):
        internal = or_.build_internal({"4132951200": "dograh-inbound,8003,1"},
                                      {"4132951200"})
        self.assertEqual(internal, (or_.InternalNumber("4132951200", "ext-local,4132951200,1"),))

    def test_a_number_without_an_extension_goes_to_its_inbound_destination(self):
        internal = or_.build_internal({"4132951200": "dograh-inbound,8003,1"}, set())
        self.assertEqual(internal, (or_.InternalNumber("4132951200", "dograh-inbound,8003,1"),))

    def test_the_rendered_lines_are_exact_and_never_a_wildcard(self):
        source = or_.render_internal_source(
            (or_.InternalNumber("4132951200", "dograh-inbound,8003,1"),))
        self.assertIn("[from-internal-custom]", source)
        self.assertIn("exten => 4132951200,1,NoOp", source)
        self.assertIn(" same => n,Goto(dograh-inbound,8003,1)", source)
        self.assertNotIn("exten => _", source)

    def test_no_internal_numbers_means_no_finding(self):
        self.assertEqual(or_.judge_internal(_state([])), [])

    def test_an_unreadable_conf_is_a_finding_not_a_pass(self):
        state = or_.State(routes=(), trunk_id=TRUNK_ID, trunk_name=TRUNK,
                          internal=(or_.InternalNumber("4132951200", "dograh-inbound,8003,1"),),
                          extensions_conf=None)
        findings = or_.judge_internal(state)
        self.assertEqual([f.state for f in findings], ["internal-numbers"])

    def test_the_segment_is_in_sync_once_written(self):
        internal = (or_.InternalNumber("4132951200", "dograh-inbound,8003,1"),)
        want = or_.merge_internal("[from-zeus-portal]\n", internal)
        state = or_.State(routes=(), trunk_id=TRUNK_ID, trunk_name=TRUNK,
                          internal=internal, extensions_conf=want)
        self.assertEqual(or_.judge_internal(state), [])

    def test_another_owners_segment_is_never_disturbed(self):
        # The one shared extensions_custom.conf: Zeus and Capstone write their
        # own marked segments, and this tool may only touch its own.
        target = ac.merge_into(
            "", "[from-internal-custom]\ninclude => from-zeus-portal\n",
            owner="zeus", append_shared={"from-internal-custom"})
        internal = (or_.InternalNumber("4132951200", "dograh-inbound,8003,1"),)
        merged = or_.merge_internal(target, internal)
        self.assertIn("; >>> begin zeus\ninclude => from-zeus-portal\n; >>> end zeus", merged)
        self.assertIn("; >>> begin internal", merged)
        # Byte-idempotent: a re-run changes nothing.
        self.assertEqual(or_.merge_internal(merged, internal), merged)

    def test_a_number_another_segment_already_answers_is_not_duplicated(self):
        # The measured case: 8000-8008 are rows in the same `incoming` table, but
        # Capstone's segment already dials them. A second `exten => 8000` is
        # silently half-dead (Asterisk keeps the first), so it must not be written.
        target = ac.merge_into(
            "", "[from-internal-custom]\ninclude => from-zeus-portal\n",
            owner="zeus", append_shared={"from-internal-custom"})
        target = ac.merge_into(
            target,
            "[from-internal-custom]\nexten => 8000,1,NoOp(Capstone agent)\n"
            " same => n,Goto(dograh-inbound,8000,1)\n",
            owner="capstone", append_shared={"from-internal-custom"})
        internal = (or_.InternalNumber("8000", "dograh-inbound,8000,1"),
                    or_.InternalNumber("4132951200", "ext-local,4132951200,1"))
        merged = or_.merge_internal(target, internal)
        self.assertEqual(merged.count("exten => 8000,1"), 1)
        self.assertIn("exten => 4132951200,1", merged)
        # Idempotent: our own segment is not counted as already-answering.
        self.assertEqual(or_.merge_internal(merged, internal), merged)

    def test_a_number_an_included_file_answers_is_not_duplicated(self):
        # `extensions_custom_dograh.conf` (an `#include`) dials 8008 in
        # [from-internal-custom]; our segment must not add a second definition.
        internal = (or_.InternalNumber("8008", "dograh-inbound,8008,1"),
                    or_.InternalNumber("4132951200", "ext-local,4132951200,1"))
        included = (
            "[dograh-inbound]\nexten => 8008,1,Stasis(app)\n\n"
            "[from-internal-custom]\nexten => 8008,1,NoOp()\n"
            " same => n,Goto(dograh-inbound,8008,1)\n")
        merged = or_.merge_internal("[from-internal-custom]\n", internal, included)
        self.assertNotIn("exten => 8008", merged)
        self.assertIn("exten => 4132951200", merged)

    def test_read_includes_regex_only_matches_include_lines(self):
        self.assertTrue(or_.INCLUDE_RE.match("#include extensions_custom_dograh.conf"))
        self.assertTrue(or_.INCLUDE_RE.match("  #include pjsip_x.conf  "))
        self.assertIsNone(or_.INCLUDE_RE.match("; #include commented-out.conf"))
        self.assertIsNone(or_.INCLUDE_RE.match("include => from-zeus-portal"))

    def test_our_own_segment_is_not_counted_as_reserved(self):
        written = or_.merge_internal(
            "[from-internal-custom]\n",
            (or_.InternalNumber("4132951200", "ext-local,4132951200,1"),))
        self.assertEqual(or_.reserved_numbers(written), set())


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


class DropRouteTest(unittest.TestCase):
    """Consolidating duplicates: an operator names them, nothing is automatic."""

    def test_nothing_named_renders_no_sql(self):
        self.assertEqual(or_.render_drop_sql(()), "")

    def test_a_named_route_and_its_children_are_deleted(self):
        sql = or_.render_drop_sql((1,))
        self.assertIn("DELETE FROM outbound_route_patterns WHERE route_id IN (1)", sql)
        self.assertIn("DELETE FROM outbound_route_trunks WHERE route_id IN (1)", sql)
        self.assertIn("DELETE FROM outbound_route_sequence WHERE route_id IN (1)", sql)
        self.assertIn("DELETE FROM outbound_routes WHERE route_id IN (1)", sql)

    def test_the_ids_are_sorted_and_deduplicated(self):
        sql = or_.render_drop_sql((3, 1, 3))
        self.assertIn("route_id IN (1, 3)", sql)


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

    def _live_duplicate_state(self):
        # The live box after the route was fixed: PSTN first, a duplicate
        # `voipms` behind it. It is in sync for the route, but the duplicate
        # still exists and an operator may name it.
        pstn = _route(2, "PSTN", 0, patterns=or_.desired_patterns(),
                      trunks=[(TRUNK_ID, TRUNK)])
        voipms = _route(1, "voipms", 1, patterns=or_.desired_patterns(),
                        trunks=[(0, "voipms")])
        return _state([pstn, voipms])

    def test_a_duplicate_named_for_removal_is_a_finding_and_a_check_writes_nothing(self):
        def boom(*_a, **_k):
            raise AssertionError("a check must not write")
        rc, _, err = self._run(["--local", "--check", "--drop-route", "voipms"],
                               [self._live_duplicate_state()], mysql=boom)
        self.assertEqual(rc, 1)
        self.assertIn("duplicate-route", err)
        self.assertIn("voipms", err)

    def test_an_unnamed_duplicate_is_left_alone(self):
        # The default: a convergence never deletes somebody else's route.
        def boom(*_a, **_k):
            raise AssertionError("an in-sync route must not be written")
        rc, out, _ = self._run(["--local", "--check"], [self._live_duplicate_state()],
                               mysql=boom)
        self.assertEqual(rc, 0)
        self.assertIn("normalises", out)

    def test_apply_drops_the_named_duplicate_then_converges(self):
        pstn = _route(2, "PSTN", 0, patterns=or_.desired_patterns(),
                      trunks=[(TRUNK_ID, TRUNK)])
        seen = []
        rc, out, err = self._run(
            ["--local", "--apply", "--drop-route", "voipms"],
            [self._live_duplicate_state(), _state([pstn]), _state([pstn])],
            mysql=lambda sql, **_k: seen.append(sql) or "",
        )
        self.assertEqual(rc, 0, err)
        self.assertTrue(any("DELETE FROM outbound_routes WHERE route_id IN (1)" in s
                            for s in seen), seen)
        self.assertIn("removed duplicate route(s) voipms", out)

    def _internal_state(self, conf):
        internal = (or_.InternalNumber("4132951200", "dograh-inbound,8003,1"),)
        pstn = _route(1, "PSTN", 0, patterns=or_.desired_patterns(),
                      trunks=[(TRUNK_ID, TRUNK)])
        return or_.State(routes=(pstn,), trunk_id=TRUNK_ID, trunk_name=TRUNK,
                         internal=internal, extensions_conf=conf)

    def test_internal_number_drift_is_a_finding_and_a_check_writes_nothing(self):
        def boom(*_a, **_k):
            raise AssertionError("a check must not write")
        rc, _, err = self._run(
            ["--local", "--check"],
            [self._internal_state("[from-zeus-portal]\n")], mysql=boom)
        self.assertEqual(rc, 1)
        self.assertIn("internal-numbers", err)

    def test_apply_writes_the_internal_segment_ahead_of_the_routes(self):
        internal = (or_.InternalNumber("4132951200", "dograh-inbound,8003,1"),)
        before = self._internal_state("[from-zeus-portal]\n")
        after = or_.State(routes=before.routes, trunk_id=TRUNK_ID, trunk_name=TRUNK,
                          internal=internal,
                          extensions_conf=or_.merge_internal(before.extensions_conf, internal))
        written = []
        with mock.patch.object(
                or_, "write_pbx_file",
                side_effect=lambda path, text, **k: written.append((path, text))):
            rc, out, err = self._run(["--local", "--apply"], [before, after])
        self.assertEqual(rc, 0, err)
        self.assertEqual(written[0][0], or_.EXTENSIONS_CONF_PATH)
        self.assertIn("exten => 4132951200,1,NoOp", written[0][1])
        self.assertIn("answered ahead", out)

    def test_an_unwritable_conf_refuses_rather_than_claiming_convergence(self):
        before = self._internal_state(None)
        rc, _, err = self._run(["--local", "--apply"], [before])
        self.assertEqual(rc, 2)
        self.assertIn("extensions_custom.conf could not be read", err)

    def test_a_named_duplicate_that_survives_is_a_failure(self):
        rc, _, err = self._run(
            ["--local", "--apply", "--drop-route", "voipms"],
            [self._live_duplicate_state(), self._live_duplicate_state(),
             self._live_duplicate_state()],
        )
        self.assertEqual(rc, 1)
        self.assertIn("did not converge", err)
