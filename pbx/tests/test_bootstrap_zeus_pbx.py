#!/usr/bin/env python3
"""Rehearse pbx/bootstrap-zeus-pbx.sh off-host, the way P0's exit asks for it.

P0 of docs/ava-capstone-convergence.md ends with "sync runs clean on a 15-minute
cycle with a byte-identical PBX; `--check` passes". On a live box that is a
measurement; here it is a rehearsal, and it is the one worth running *before*
re-enabling `zeus-pbx-sync.timer`, because it answers the questions the timer's
first run would otherwise answer for you:

  * the apply is idempotent — a second run changes no byte;
  * the `--check` that follows it agrees, so "in sync" is reachable at all;
  * the two file-ownership rules that made the timer dangerous hold in the
    *rendered set*, not only in the script's comments: `manager_custom.conf`
    belongs to the entrypoint (FreePBX's own `ucp_events` and [pbxportal] users
    live in it) and `rtp_custom.conf` to the runtime entrypoint, so neither may
    be written from here;
  * `--check` writes nothing, even to a target that has no converge-owned file
    yet — a drift check runs immediately before a change, and P0's snapshot runs
    before that, so neither may alter what it is recording.

Everything below is a scratch directory and a throwaway `pbx.env`: no container,
no `/etc/asterisk`, nothing to clean up. The core-module patcher is pointed away
from any real PBX on purpose (`CORE_MODULES_DIR` at a path that does not exist,
`PBX_CONTAINER` at a name that is not running), so running this on the PBX host
itself is still safe.

Run:  python3 -m unittest discover -s pbx/tests -v
"""

from __future__ import annotations

import hashlib
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
BOOTSTRAP = REPO / "pbx" / "bootstrap-zeus-pbx.sh"

# Fragments this script owns a copy of, and the two it must never write here.
APPLIED = {
    "http_custom.conf",  # copied wholesale
    "ari.conf",  # converge-owned: merged per section
    "extensions_custom.conf",  # converge-owned, [from-internal-custom] is append-shared
    "ari_additional_custom.conf",  # converge-owned: AVA's ARI user
}
NEVER_APPLIED = {
    "manager_custom.conf",  # the entrypoint rewrites the AMI users on every boot
    "rtp_custom.conf",  # the runtime derives the RTP range from .env
}

ARI_PORT = "8188"


class Rehearsal(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="zeus-bootstrap-rehearsal-"))
        self.addCleanup(lambda: __import__("shutil").rmtree(self.tmp, ignore_errors=True))
        self.asterisk = self.tmp / "asterisk"
        self.asterisk.mkdir()

        pbx_env = self.tmp / "pbx.env"
        pbx_env.write_text(
            "FREEPBX_AMI_USER=rehearsal\n"
            "FREEPBX_AMI_SECRET=0123456789abcdef0123456789abcdef\n"
            "FREEPBX_ARI_USER=rehearsal-ari\n"
            "FREEPBX_ARI_SECRET=fedcba9876543210fedcba9876543210\n"
            "AVA_ARI_USER=zeus-ava\n"
            "AVA_ARI_SECRET=aaaabbbbccccddddaaaabbbbccccdddd\n"
            f"ARI_HTTP_PORT={ARI_PORT}\n",
            encoding="utf-8",
        )

        self.env = dict(os.environ)
        self.env.update(
            {
                "PBX_ENV_FILE": str(pbx_env),
                "PBX_TARGET": "local",
                "FREEPBX_ASTERISK_DIR": str(self.asterisk),
                # Keep the core-module patcher away from any real PBX.
                "CORE_MODULES_DIR": str(self.tmp / "no-core-modules-here"),
                "PBX_CONTAINER": "zeus-rehearsal-not-a-container",
                # No portal cache: the [zeus-ai-accounts] placeholder stands.
                "ZEUS_PORTAL_DB": str(self.tmp / "no-portal.db"),
            }
        )
        self.env.pop("PBX_SYNC_TOKEN", None)

    def run_bootstrap(self, *args: str) -> subprocess.CompletedProcess:
        proc = subprocess.run(
            ["bash", str(BOOTSTRAP), *args],
            env=self.env,
            capture_output=True,
            text=True,
        )
        # A failure is reported by the caller; make the output available either way.
        return proc

    def present(self) -> set[str]:
        return {p.name for p in self.asterisk.iterdir() if p.is_file()}

    def hashes(self) -> dict[str, str]:
        return {
            p.name: hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(self.asterisk.iterdir())
            if p.is_file()
        }


class Apply(Rehearsal):
    def test_a_first_apply_lands_exactly_the_fragments_it_owns(self):
        proc = self.run_bootstrap()
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertEqual(self.present(), APPLIED)

    def test_the_entrypoint_owned_fragments_are_never_written(self):
        """The regression this pins: a wholesale copy deleted live AMI users.

        `manager_custom.conf` carries FreePBX's `ucp_events` user and this
        estate's own `[pbxportal]` user, neither of which this repo renders — so
        an apply that copies it removes them, and the next container boot puts
        them back and the two writers flap for as long as the timer runs.
        """
        self.run_bootstrap()
        for name in NEVER_APPLIED:
            self.assertNotIn(name, self.present())

    def test_placeholders_are_rendered_before_the_file_lands(self):
        self.run_bootstrap()
        text = (self.asterisk / "http_custom.conf").read_text(encoding="utf-8")
        self.assertIn(f"bindport = {ARI_PORT}", text)
        for applied in APPLIED:
            body = (self.asterisk / applied).read_text(encoding="utf-8")
            for placeholder in ("__ARI_HTTP_PORT__", "__AMI_SECRET__", "__AVA_ARI_SECRET__"):
                self.assertNotIn(placeholder, body, f"{applied} carries {placeholder}")


class Idempotence(Rehearsal):
    def test_the_second_apply_changes_no_byte(self):
        self.run_bootstrap()
        first = self.hashes()
        proc = self.run_bootstrap()
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertEqual(self.hashes(), first, "the apply is not byte-idempotent")

    def test_the_check_agrees_with_what_was_just_applied(self):
        self.run_bootstrap()
        proc = self.run_bootstrap("--check")
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn("in sync", proc.stdout + proc.stderr)


class CheckIsReadOnly(Rehearsal):
    def test_a_bare_target_is_drift(self):
        proc = self.run_bootstrap("--check")
        self.assertEqual(proc.returncode, 1, proc.stdout + proc.stderr)
        self.assertIn("drift", proc.stdout + proc.stderr)

    def test_a_check_writes_nothing_to_a_bare_target(self):
        """A drift check and P0's snapshot both run before a change.

        `ari_additional_custom.conf` is this repo's to create, so on a fresh PBX
        the check used to leave an empty one behind while reporting drift — which
        is an audit trail that lies about the pre-state.
        """
        before = self.present()
        self.run_bootstrap("--check")
        self.assertEqual(self.present(), before)

    def test_a_missing_converge_owned_file_is_named_as_the_drift(self):
        proc = self.run_bootstrap("--check")
        self.assertIn("ari_additional_custom.conf", proc.stdout + proc.stderr)


class Routes(Rehearsal):
    """P1's other half: the DID inbound routes, judged off-host.

    Rendering `[zeus-ai-accounts]` does not put a single call on the router — the
    inbound route for each DID is a row in FreePBX's `incoming` table, and a
    route pointing elsewhere answers calls as the wrong thing while looking
    configured. The apply path now converges them, and the check path fails on
    them, which is the wiring these tests pin.

    `ZEUS_ROUTES_TSV` is what makes that judgeable with no PBX: the bootstrap
    hands the dumped route table to `pbx/ava_routes.py`, which is the same
    judgement it makes live against the same plan.
    """

    def portal_db(self, *dids: str) -> str:
        """A portal cache holding `dids` as active numbers (ava_routing's source)."""
        path = self.tmp / "pbx.db"
        con = sqlite3.connect(path)
        con.execute("CREATE TABLE phone_numbers (user_id TEXT, did TEXT, status TEXT)")
        con.execute("CREATE TABLE account_addons (user_id TEXT, addon TEXT, entitled INTEGER)")
        con.execute("CREATE TABLE voice_agents (user_id TEXT, agent_slug TEXT)")
        for n, did in enumerate(dids, start=1):
            con.execute("INSERT INTO phone_numbers VALUES (?, ?, 'active')", (f"u{n}", did))
        con.commit()
        con.close()
        return str(path)

    def routes_tsv(self, rows: list[tuple[str, str]]) -> str:
        """A route table in the shape p0-snapshot dumps: extension, destination."""
        path = self.tmp / "incoming.tsv"
        path.write_text(
            "".join(f"{ext}\t{dest}\tdescription\n" for ext, dest in rows),
            encoding="utf-8",
        )
        return str(path)

    def test_a_did_off_the_router_is_drift(self):
        self.env["ZEUS_PORTAL_DB"] = self.portal_db("17745057135", "4132643964")
        self.run_bootstrap()
        self.env["ZEUS_ROUTES_TSV"] = self.routes_tsv(
            [
                ("7745057135", "zeus-ai-router,s,1"),
                ("4132643964", "from-did-direct,8003,1"),  # still Capstone's front door
            ]
        )
        proc = self.run_bootstrap("--check")
        self.assertEqual(proc.returncode, 1, proc.stdout + proc.stderr)
        self.assertIn("drift: DID inbound routes", proc.stdout + proc.stderr)

    def test_every_did_on_the_router_is_in_sync(self):
        self.env["ZEUS_PORTAL_DB"] = self.portal_db("17745057135", "4132643964")
        self.run_bootstrap()
        self.env["ZEUS_ROUTES_TSV"] = self.routes_tsv(
            [
                ("7745057135", "zeus-ai-router,s,1"),
                ("4132643964", "zeus-ai-router,s,1"),
            ]
        )
        proc = self.run_bootstrap("--check")
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn("in sync", proc.stdout + proc.stderr)

    def test_a_number_the_plan_does_not_name_is_left_alone(self):
        """The ring group is not this repo's to move, and must not read as drift."""
        self.env["ZEUS_PORTAL_DB"] = self.portal_db("17745057135")
        self.run_bootstrap()
        self.env["ZEUS_ROUTES_TSV"] = self.routes_tsv(
            [
                ("7745057135", "zeus-ai-router,s,1"),
                ("7745057136", "ext-group,329,1"),
            ]
        )
        proc = self.run_bootstrap("--check")
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn("left alone 7745057136", proc.stderr)

    def test_a_route_only_drift_reaches_the_apply_path(self):
        """The case the timer's wrapper hits, and the one an apply can miss.

        The fragments can be in sync while a DID points elsewhere. A wrapper run
        is `--check`, then the apply when that fails — so an apply that judged
        only the fragments answered "already in sync" and converged nothing,
        and since the fix is a route row it would never have cleared itself.
        """
        self.env["ZEUS_PORTAL_DB"] = self.portal_db("17745057135")
        self.run_bootstrap()  # fragments now in sync
        self.env["ZEUS_ROUTES_TSV"] = self.routes_tsv(
            [("7745057135", "from-did-direct,8005,1")]
        )
        proc = self.run_bootstrap()
        out = proc.stdout + proc.stderr
        self.assertEqual(proc.returncode, 0, out)
        # the script's own summary, not asterisk-converge's per-file wording
        self.assertNotIn("zeus-pbx: already in sync", out)
        self.assertIn("applied (local)", out)

    def test_a_did_with_no_route_does_not_send_an_apply(self):
        """A gap only a person can close is not a reason to write anything.

        The tool reports it as 3 rather than 1 for exactly this caller: an apply
        for it rewrites no row and still reloads a live phone system, so a
        15-minute timer would do that forever — while `--check` keeps failing
        either way, so the gap is never quiet.
        """
        self.env["ZEUS_PORTAL_DB"] = self.portal_db("17745057135")
        self.run_bootstrap()
        before = self.hashes()
        self.env["ZEUS_ROUTES_TSV"] = self.routes_tsv(
            [("8000", "dograh-inbound,8000,1")]  # the plan names no row for it
        )
        proc = self.run_bootstrap()
        out = proc.stdout + proc.stderr
        self.assertEqual(proc.returncode, 1, out)
        self.assertIn("need a human", out)
        self.assertNotIn("applied (local)", out)
        self.assertEqual(self.hashes(), before)

    def test_the_check_keeps_failing_on_that_gap(self):
        self.env["ZEUS_PORTAL_DB"] = self.portal_db("17745057135")
        self.run_bootstrap()
        self.env["ZEUS_ROUTES_TSV"] = self.routes_tsv([("8000", "dograh-inbound,8000,1")])
        proc = self.run_bootstrap("--check")
        out = proc.stdout + proc.stderr
        self.assertEqual(proc.returncode, 1, out)
        self.assertIn("needs an inbound route added in FreePBX", out)

    def test_a_gap_does_not_stop_a_route_that_can_be_converged(self):
        """The live state on `.30`: three DIDs a tool can move, four a person must."""
        self.env["ZEUS_PORTAL_DB"] = self.portal_db("17745057135", "4132643964")
        self.run_bootstrap()
        self.env["ZEUS_ROUTES_TSV"] = self.routes_tsv(
            [("7745057135", "from-did-direct,8005,1")]
        )
        proc = self.run_bootstrap()
        out = proc.stdout + proc.stderr
        self.assertEqual(proc.returncode, 0, out)
        self.assertIn("applied (local)", out)
        self.assertIn("refuse", out)

    def test_no_plan_means_the_routes_are_not_judged(self):
        """A missing plan is not a healthy ingress and must not read as one.

        `setUp` points ZEUS_PORTAL_DB at a path that is not there, so this is a
        host with no portal and no cache: the fragments can still be in sync
        while nothing knows where a call should land.
        """
        self.run_bootstrap()
        proc = self.run_bootstrap("--check")
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn("DID routes not judged", proc.stderr)


class RoutesAreWiredIntoTheRun(unittest.TestCase):
    """The order the steps run in, which a refactor is free to get wrong.

    Routes are rows FreePBX builds its dialplan from, so the write has to land
    *before* the reload or the change is invisible until the next one; and the
    check has to feed the drift flag, or `--check` passes on a PBX whose DIDs
    still reach whatever answered before.
    """

    @classmethod
    def setUpClass(cls):
        cls.text = BOOTSTRAP.read_text(encoding="utf-8")

    def test_the_route_write_happens_before_the_reload(self):
        self.assertIn("converge_routes\n  reload_pbx", self.text)

    def test_the_check_feeds_the_drift_flag(self):
        self.assertIn("judge_routes || drift=1", self.text)

    def test_the_apply_path_judges_the_routes_too(self):
        # Not only under --check: the wrapper applies after a failed check, so an
        # apply that judged nothing would report "already in sync" on a PBX whose
        # DIDs all point elsewhere.
        self.assertIn("judge_routes || ROUTES_RC=$?", self.text)

    def test_a_route_gap_is_not_folded_into_the_apply_decision(self):
        """3 means "a person", 1 means "an apply": conflating them reloads a
        live phone system every timer tick to change no row."""
        self.assertIn("1) drift=1 ;;\n  3) route_gap=1 ;;", self.text)
        # and the gap case says so instead of reporting a clean run
        self.assertIn("fragments in sync; DID routes need a human", self.text)

    def test_the_converger_is_called_by_an_absolute_path(self):
        self.assertIn('python3 "$ROUTES_PY"', self.text)
        self.assertIn('ROUTES_PY="${SCRIPT_DIR}/ava_routes.py"', self.text)

    def test_the_undo_is_written_before_the_apply(self):
        """An apply with no way back is the thing P0's snapshots exist for."""
        self.assertIn('--revert-out "$ROUTE_REVERT_OUT"', self.text)


if __name__ == "__main__":
    unittest.main()
