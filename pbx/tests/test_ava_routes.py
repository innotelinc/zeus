#!/usr/bin/env python3
"""Unit tests for pbx/ava_routes.py — DID routes converged onto the AVA router.

The behaviour that matters is what it does to a live FreePBX `incoming` table:
a platform DID ends up on `zeus-ai-router,s,1`, everything that is not a
platform DID is left byte-identical, and a row it cannot converge safely is
refused rather than approximated. The last one is the whole reason the tool
exists — the GUI edit it replaces was *easy*, so it happened for the wrong rows
too.

Run:  python3 -m unittest discover -s pbx/tests -v
"""
import json
import os
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import ava_routes as art  # noqa: E402

ROUTER = "zeus-ai-router,s,1"


def _plan(tmpdir: str, dids: list[str]) -> str:
    path = os.path.join(tmpdir, "plan.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump({"accounts": [{"did": d} for d in dids]}, fh)
    return path


def _routes(tmpdir: str, lines: list[str]) -> str:
    path = os.path.join(tmpdir, "routes.tsv")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
    return path


class _Proc:
    """Just enough of subprocess.CompletedProcess for the stubs below."""

    def __init__(self, stdout: str = "", stderr: str = "", returncode: int = 0):
        self.stdout = stdout
        self.stderr = stderr
        self.returncode = returncode


class ParseRoutesTest(unittest.TestCase):
    def test_reads_the_three_columns(self):
        rows = art.parse_routes("7745057135\tfrom-did-direct,8005,1\tJob Interview\n")
        self.assertEqual(rows[0].extension, "7745057135")
        self.assertEqual(rows[0].destination, "from-did-direct,8005,1")

    def test_description_and_blank_lines_are_tolerated(self):
        rows = art.parse_routes("7745057135\tcustomer\n\n7745057136\text-group,600,1\tRing\n")
        self.assertEqual([r.extension for r in rows], ["7745057135", "7745057136"])
        self.assertEqual(rows[1].description, "Ring")

    def test_a_select_star_dump_is_refused_not_misread(self):
        # Positional parsing of an all-columns dump would read the DID out of
        # whatever column came first, and then converge the wrong rows.
        with self.assertRaises(art.RouteError) as ctx:
            art.parse_routes("1\t2\t3\t4\t5\n")
        self.assertIn("columns", str(ctx.exception))


class BuildReportTest(unittest.TestCase):
    def test_did_on_the_router_is_in_sync(self):
        rows = art.parse_routes(f"7745057135\t{ROUTER}\tJob Interview\n")
        report = art.build_report(["7745057135"], rows)
        self.assertEqual(report.ok, ["7745057135"])
        self.assertEqual(report.changes, [])
        self.assertEqual(report.left_alone, [])

    def test_did_pointed_somewhere_else_is_a_change(self):
        rows = art.parse_routes("7745057135\tfrom-did-direct,8005,1\tJob Interview\n")
        report = art.build_report(["7745057135"], rows)
        self.assertEqual(len(report.changes), 1)
        change = report.changes[0]
        self.assertTrue(change.destination_moved)
        self.assertFalse(change.extension_recased)
        self.assertEqual(change.after_destination, ROUTER)

    def test_a_one_prefixed_did_is_recased_not_replaced(self):
        # FreePBX matches the dialed form, so this row never matches a call to
        # 7745057135 — the route exists and is dead. Both halves change at once.
        rows = art.parse_routes("17745057135\tfrom-did-direct,8005,1\tJob Interview\n")
        report = art.build_report(["7745057135"], rows)
        change = report.changes[0]
        self.assertTrue(change.extension_recased)
        self.assertEqual(change.before_extension, "17745057135")
        self.assertEqual(change.after_extension, "7745057135")

    def test_did_with_no_route_is_refused_not_created(self):
        report = art.build_report(["7745057135"], art.parse_routes(""))
        self.assertEqual(report.missing, ["7745057135"])
        self.assertEqual(report.changes, [])

    def test_two_routes_for_one_did_are_refused(self):
        rows = art.parse_routes(
            "7745057135\tfrom-did-direct,8005,1\tA\n"
            "17745057135\tfrom-did-direct,8006,1\tB\n"
        )
        report = art.build_report(["7745057135"], rows)
        self.assertEqual(report.duplicates, ["7745057135"])
        self.assertEqual(report.changes, [])

    def test_the_ring_group_did_is_left_alone_and_named(self):
        # P1's exit: 7745057136 stays on its ring group. It is reported by name
        # so that "left alone" is evidence rather than an assumption.
        rows = art.parse_routes(
            f"7745057135\t{ROUTER}\tJob Interview\n"
            "7745057136\text-group,600,1\tOperator\n"
        )
        report = art.build_report(["7745057135"], rows)
        self.assertEqual([r.extension for r in report.left_alone], ["7745057136"])
        self.assertEqual(report.changes, [])

    def test_dial_patterns_are_never_rewritten(self):
        # `_2XX` normalizes to "2"; treating it as a DID would collide with real
        # numbers and turn a deliberate range into one literal.
        rows = art.parse_routes("_2XX\tfrom-did-direct,8005,1\tRange\n")
        report = art.build_report(["7745057135"], rows)
        self.assertEqual(report.changes, [])
        self.assertEqual([r.extension for r in report.left_alone], ["_2XX"])

    def test_a_pattern_row_does_not_hide_a_missing_route(self):
        rows = art.parse_routes("_1774505XXXX\tfrom-did-direct,8005,1\tRange\n")
        report = art.build_report(["7745057135"], rows)
        self.assertEqual(report.missing, ["7745057135"])
        self.assertEqual(report.left_alone[0].extension, "_1774505XXXX")

    def test_empty_plan_is_refused_by_the_cli(self):
        with tempfile.TemporaryDirectory() as tmp:
            plan = _plan(tmp, [])
            routes = _routes(tmp, [f"7745057135\t{ROUTER}\tJob"])
            self.assertEqual(
                art.main(["--accounts-json", plan, "--routes-tsv", routes, "--check"]),
                1,
            )


class SqlTest(unittest.TestCase):
    def test_change_sql_keys_on_the_extension_it_found(self):
        rows = art.parse_routes("17745057135\tfrom-did-direct,8005,1\tJob\n")
        change = art.build_report(["7745057135"], rows).changes[0]
        sql = change.sql()
        self.assertIn("`extension`='7745057135'", sql)
        self.assertIn("`destination`='zeus-ai-router,s,1'", sql)
        self.assertIn("WHERE `extension`='17745057135'", sql)

    def test_revert_sql_restores_the_exact_pre_state(self):
        rows = art.parse_routes("17745057135\tfrom-did-direct,8005,1\tJob\n")
        change = art.build_report(["7745057135"], rows).changes[0]
        revert = change.revert_sql()
        self.assertIn("`extension`='17745057135'", revert)
        self.assertIn("`destination`='from-did-direct,8005,1'", revert)
        # Keyed on the extension the apply leaves behind, or the undo would
        # match nothing after the recasing.
        self.assertIn("WHERE `extension`='7745057135'", revert)

    def test_revert_script_is_a_transaction_with_the_way_to_run_it(self):
        rows = art.parse_routes("7745057135\tfrom-did-direct,8005,1\tJob\n")
        changes = art.build_report(["7745057135"], rows).changes
        script = art.render_revert(changes, "zeus-freepbx")
        self.assertTrue(script.startswith("--"))
        self.assertIn("START TRANSACTION;", script)
        self.assertIn("COMMIT;", script)
        self.assertIn("docker exec -i zeus-freepbx mysql", script)

    def test_quotes_are_escaped(self):
        self.assertEqual(art._sql("O'Brien"), "O''Brien")


class CliTest(unittest.TestCase):
    def _fixture(self, tmp: str, route_lines: list[str]) -> tuple[str, str]:
        return _plan(tmp, ["7745057135", "4132643964"]), _routes(tmp, route_lines)

    def test_check_reports_drift_and_writes_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            plan, routes = self._fixture(
                tmp,
                [
                    "7745057135\tfrom-did-direct,8005,1\tJob Interview",
                    "7745057136\text-group,600,1\tOperator",
                ],
            )
            with open(routes, encoding="utf-8") as fh:
                before = fh.read()
            rc = art.main(["--accounts-json", plan, "--routes-tsv", routes, "--check"])
            self.assertEqual(rc, 1)
            with open(routes, encoding="utf-8") as fh:
                self.assertEqual(fh.read(), before)

    def test_a_did_with_no_route_is_three_not_one(self):
        """1 means an apply converges it; 3 means only a person can.

        The caller acts on the difference: treating 3 as 1 makes the timer apply
        and reload a live phone system every 15 minutes to change no row, because
        a missing inbound route never clears itself.
        """
        with tempfile.TemporaryDirectory() as tmp:
            plan, routes = self._fixture(tmp, [])  # neither DID has a row
            rc = art.main(
                ["--accounts-json", plan, "--routes-tsv", routes, "--check", "--quiet"]
            )
            self.assertEqual(rc, 3)

    def test_a_convergeable_route_is_one_even_with_a_refusal_present(self):
        with tempfile.TemporaryDirectory() as tmp:
            plan, routes = self._fixture(
                tmp, ["7745057135\tfrom-did-direct,8005,1\tJob Interview"]
            )
            rc = art.main(
                ["--accounts-json", plan, "--routes-tsv", routes, "--check", "--quiet"]
            )
            self.assertEqual(rc, 1)

    def test_check_passes_when_both_dids_are_on_the_router(self):
        with tempfile.TemporaryDirectory() as tmp:
            plan, routes = self._fixture(
                tmp,
                [
                    f"7745057135\t{ROUTER}\tJob Interview",
                    f"4132643964\t{ROUTER}\tD Hunter",
                    "7745057136\text-group,600,1\tOperator",
                ],
            )
            rc = art.main(
                ["--accounts-json", plan, "--routes-tsv", routes, "--check", "--quiet"]
            )
            self.assertEqual(rc, 0)

    def test_portal_database_is_an_account_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = os.path.join(tmp, "portal.db")
            con = sqlite3.connect(db)
            con.executescript(
                "CREATE TABLE phone_numbers (id TEXT, user_id TEXT, did TEXT, "
                "status TEXT);"
            )
            con.execute("INSERT INTO phone_numbers VALUES ('n1','u1','7745057135','active')")
            con.commit()
            con.close()
            routes = _routes(tmp, [f"7745057135\t{ROUTER}\tJob"])
            self.assertEqual(
                art.main(["--db", db, "--routes-tsv", routes, "--check", "--quiet"]), 0
            )

    def test_offline_apply_writes_sql_and_never_a_revert_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            plan, routes = self._fixture(
                tmp, ["7745057135\tfrom-did-direct,8005,1\tJob Interview"]
            )
            sql_out = os.path.join(tmp, "apply.sql")
            rc = art.main(
                [
                    "--accounts-json", plan, "--routes-tsv", routes,
                    "--apply", "--sql-out", sql_out, "--quiet",
                ]
            )
            # 4132643964 has no route, so the run is honest about the gap even
            # after writing the half it can converge.
            self.assertEqual(rc, 1)
            with open(sql_out, encoding="utf-8") as fh:
                sql = fh.read()
            self.assertIn("UPDATE `incoming` SET `destination`='zeus-ai-router,s,1'", sql)
            self.assertIn("START TRANSACTION;", sql)
            self.assertFalse(os.path.exists(os.path.join(tmp, "routes.tsv.bak")))

    def test_offline_apply_without_sql_out_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            plan, routes = self._fixture(
                tmp, ["7745057135\tfrom-did-direct,8005,1\tJob Interview"]
            )
            with self.assertRaises(SystemExit):
                art.main(["--accounts-json", plan, "--routes-tsv", routes, "--apply"])

    def test_bad_plan_exits_one_and_unreadable_routes_exit_two(self):
        with tempfile.TemporaryDirectory() as tmp:
            plan = os.path.join(tmp, "plan.json")
            with open(plan, "w", encoding="utf-8") as fh:
                fh.write("{oops")
            routes = _routes(tmp, [f"7745057135\t{ROUTER}\tJob"])
            self.assertEqual(
                art.main(["--accounts-json", plan, "--routes-tsv", routes, "--check"]),
                1,
            )
            good = _plan(tmp, ["7745057135"])
            self.assertEqual(
                art.main(
                    ["--accounts-json", good, "--routes-tsv",
                     os.path.join(tmp, "missing.tsv"), "--check"]
                ),
                2,
            )


class CreationTest(unittest.TestCase):
    """`--create-missing`: the one way this tool adds a row, and only on request.

    The default refusal stands — a missing route is a `3` (a human), not a `1`
    (an apply) — because a timer must never invent a phone route. The opt-in
    exists so the same GUI step that leaves a new DID unrouted does not have to
    be the thing that wires it; it goes through FreePBX's own `addDID`, which
    fills the fifteen columns this tool does not model.
    """

    def test_revert_of_a_creation_is_a_delete_keyed_the_way_adddid_wrote_it(self):
        sql = art.Creation("7745057135").revert_sql()
        self.assertIn("DELETE FROM `incoming`", sql)
        self.assertIn("`extension`='7745057135'", sql)
        self.assertIn("`cidnum`=''", sql)

    def test_the_create_uses_the_framework_not_an_insert_of_ours(self):
        calls = []

        def fake(args, stdin=None):
            calls.append((args, stdin))
            return _Proc(
                stdout='[{"did":"7745057135","result":"created"},'
                '{"did":"4132643964","result":"exists"}]\n'
            )

        real = art._run
        try:
            art._run = fake
            created = art.create_missing("zeus-freepbx", ["7745057135", "4132643964"])
        finally:
            art._run = real
        # A row that existed all along is not reported as this tool's creation.
        self.assertEqual(created, ["7745057135"])
        argv, script = calls[0]
        self.assertIn("php", argv)
        self.assertIn("zeus-freepbx", argv)
        # The create path is FreePBX's own, and the destination is the constant.
        self.assertIn("addDID", script)
        self.assertIn(art.ROUTER, script)
        self.assertNotIn("INSERT INTO", script)

    def test_a_row_the_api_did_not_create_is_an_error_not_a_silent_pass(self):
        real = art._run
        try:
            art._run = lambda args, stdin=None: _Proc(
                stdout='[{"did":"7745057135","result":"failed"}]\n'
            )
            with self.assertRaises(art.RouteError) as ctx:
                art.create_missing("zeus-freepbx", ["7745057135"])
        finally:
            art._run = real
        self.assertIn("7745057135", str(ctx.exception))

    def test_an_api_that_does_not_answer_is_an_error(self):
        real = art._run
        try:
            art._run = lambda args, stdin=None: _Proc(
                stderr="PHP Fatal error: Uncaught Error\n", returncode=255
            )
            with self.assertRaises(art.RouteError) as ctx:
                art.create_missing("zeus-freepbx", ["7745057135"])
        finally:
            art._run = real
        self.assertIn("PHP Fatal error", str(ctx.exception))

    def test_revert_script_deletes_what_the_run_created(self):
        changes = art.build_report(
            ["7745057135"], art.parse_routes("7745057135\tfrom-did-direct,8005,1\tJob\n")
        ).changes
        script = art.render_revert(
            changes, "zeus-freepbx", [art.Creation("4132643964")]
        )
        self.assertIn("DELETE FROM `incoming`", script)
        self.assertIn("1 creation(s)", script)

    def test_create_missing_needs_apply(self):
        with tempfile.TemporaryDirectory() as tmp:
            plan = _plan(tmp, ["7745057135"])
            with self.assertRaises(SystemExit):
                art.main(["--accounts-json", plan, "--check", "--create-missing"])

    def test_create_missing_is_refused_offline(self):
        with tempfile.TemporaryDirectory() as tmp:
            plan, routes = _plan(tmp, ["7745057135"]), _routes(tmp, [])
            with self.assertRaises(SystemExit):
                art.main(
                    [
                        "--accounts-json", plan, "--routes-tsv", routes,
                        "--apply", "--sql-out", os.path.join(tmp, "a.sql"),
                        "--create-missing",
                    ]
                )


class CreateMissingCliTest(unittest.TestCase):
    """The apply path with the flag, driven through stubs instead of a PBX."""

    def _run_main(self, argv: list[str]):
        real = (art.resolve_container, art.read_live_routes, art.apply_sql, art.create_missing)
        created: list[str] = []
        try:
            art.resolve_container = lambda *a, **k: "zeus-freepbx"
            art.read_live_routes = lambda c: ""
            art.apply_sql = lambda c, sql: None

            def fake_create(c, dids):
                created.extend(dids)
                return list(dids)

            art.create_missing = fake_create
            return art.main(argv), created
        finally:
            art.resolve_container, art.read_live_routes, art.apply_sql, art.create_missing = real

    def test_apply_creates_the_route_and_goes_green(self):
        with tempfile.TemporaryDirectory() as tmp:
            plan = _plan(tmp, ["7745057135"])
            revert = os.path.join(tmp, "revert.sql")
            rc, created = self._run_main(
                ["--accounts-json", plan, "--apply", "--create-missing",
                 "--revert-out", revert, "--quiet"]
            )
            self.assertEqual(rc, 0)
            self.assertEqual(created, ["7745057135"])
            with open(revert, encoding="utf-8") as fh:
                self.assertIn("DELETE FROM `incoming`", fh.read())

    def test_without_the_flag_a_missing_route_is_still_a_human_s_to_add(self):
        with tempfile.TemporaryDirectory() as tmp:
            plan = _plan(tmp, ["7745057135"])
            revert = os.path.join(tmp, "revert.sql")
            rc, created = self._run_main(
                ["--accounts-json", plan, "--apply",
                 "--revert-out", revert, "--quiet"]
            )
            self.assertEqual(rc, 1)
            self.assertEqual(created, [])
            # Nothing was created, so the undo has nothing to delete either.
            self.assertFalse(os.path.exists(revert))


class LiveTargetTest(unittest.TestCase):
    def test_explicit_container_must_be_running(self):
        # Naming a container that is not up must read as "no PBX", never as the
        # other product's PBX: both can be present, and only one owns the DIDs.
        import subprocess

        real = subprocess.run
        try:
            subprocess.run = lambda *a, **k: type(  # type: ignore[assignment]
                "P", (), {"returncode": 0, "stdout": "false", "stderr": ""}
            )()
            self.assertEqual(art.resolve_container("pbx-freepbx", ("zeus-freepbx",)), "")
        finally:
            subprocess.run = real  # type: ignore[assignment]


if __name__ == "__main__":
    unittest.main()
