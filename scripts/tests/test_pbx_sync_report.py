#!/usr/bin/env python3
"""Run the sync wrapper against a PBX that answers, and prove it stays green.

`scripts/zeus-pbx-sync.sh` is what `zeus-pbx-sync.timer` starts, and two of its
sections exist only to *report*: the DID ingress (`pbx/dograh_routes.py`) and the
extension secrets (`pbx/extension_secret.py`). Both name a disagreement a person
clears — a FreePBX `incoming` row, a portal `Repair` — so neither may fail the
unit. The regression this guards is a one-line edit that lets a non-zero tool
status become the wrapper's own: the timer then goes red every fifteen minutes
over work it cannot do, and an operator learns to ignore the unit.

The wrapper ends by calling `pbx/bootstrap-zeus-pbx.sh`, and every applying
section is gated behind a `docker exec … test -f`, so this runs the real script
against a throwaway repo with three stubs on `PATH`:

  * `python3` — answers the tools with drift (exit 1), so the *report* branches
    are the ones exercised, and records every call to a log;
  * `docker` — always fails, so the container-only sections (media address,
    portal access, outbound route) are skipped without a live PBX;
  * the bootstrap itself — `--check` exits 0, so the wrapper takes its in-sync
    path and never applies anything.

What is asserted is the caller-visible contract: the wrapper exits 0, the
journal carries each drift, and each tool was judged against the portal's own
database rather than wetware. A silent green tick is the other way this
regresses, so the in-sync line is asserted too.

Run:  python3 -m unittest discover -s scripts/tests -v
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
WRAPPER = REPO / "scripts" / "zeus-pbx-sync.sh"

# The wrapper's own wording for a reporting tool that answered non-zero, and for
# the end of a green tick. Both are the contract, so a change to either is a
# change this test is meant to notice.
DID_DRIFT = "DID ingress is not in sync"
SECRET_DRIFT = "stored SIP secret is missing"
IN_SYNC = "zeus-pbx-sync: in sync"


class WrapperKeepsReportingDriftGreen(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)
        self.log = self.root / "calls.log"
        self._build_repo()

    def _build_repo(self):
        (self.root / "scripts").mkdir()
        shutil.copy(WRAPPER, self.root / "scripts" / "zeus-pbx-sync.sh")

        pbx = self.root / "pbx"
        pbx.mkdir()
        # Existence is all the wrapper checks for these; the stub python3 answers.
        for name in ("dograh_routes.py", "extension_secret.py", "voicemail_mailbox.py"):
            (pbx / name).write_text("", encoding="utf-8")
        bootstrap = pbx / "bootstrap-zeus-pbx.sh"
        bootstrap.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        bootstrap.chmod(0o755)

        (self.root / "portal.db").write_text("", encoding="utf-8")

        bindir = self.root / "bin"
        bindir.mkdir()
        self._stub(
            bindir / "python3",
            "#!/bin/sh\n"
            'printf "%s\\n" "$*" >> "$ZEUS_STUB_LOG"\n'
            'case "$*" in\n'
            "  *dograh_routes.py*)\n"
            "    echo 'dograh-routes: 1 route(s) off dograh-inbound and 0 unrouted'\n"
            "    echo '  off the workflow: 7745057135 -> from-did-direct,7745057135,1' >&2\n"
            "    exit 1 ;;\n"
            "  *extension_secret.py*)\n"
            "    echo 'extension-secret: 1 extension(s) whose stored secret is missing'\n"
            "    exit 1 ;;\n"
            "  *) exit 0 ;;\n"
            "esac\n",
        )
        # No live PBX: every `docker exec … test -f` probe fails, so the
        # container-only sections are skipped.
        self._stub(bindir / "docker", "#!/bin/sh\nexit 1\n")

    def _stub(self, path, body):
        path.write_text(body, encoding="utf-8")
        path.chmod(0o755)

    def _run(self):
        env = dict(os.environ)
        env["PATH"] = f"{self.root / 'bin'}{os.pathsep}{env['PATH']}"
        env["PORTAL_DB"] = str(self.root / "portal.db")
        env["ZEUS_STUB_LOG"] = str(self.log)
        # Skip the `ip route get 1` lookup a host without these would make.
        env["PJSIP_MEDIA_ADDRESS"] = "203.0.113.10"
        return subprocess.run(
            ["bash", str(self.root / "scripts" / "zeus-pbx-sync.sh")],
            capture_output=True,
            text=True,
            env=env,
            timeout=60,
        )

    def _calls(self):
        return self.log.read_text(encoding="utf-8") if self.log.exists() else ""

    def test_read_only_drift_is_reported_and_the_unit_stays_green(self):
        done = self._run()
        output = done.stdout + done.stderr
        self.assertEqual(
            done.returncode,
            0,
            f"the unit went red over read-only drift:\n{output}",
        )
        # Each reporting tool's own finding reached the journal, not just a
        # wrapper line, so an operator can act on the row it names.
        self.assertIn(DID_DRIFT, output)
        self.assertIn("off the workflow", output)
        self.assertIn(SECRET_DRIFT, output)
        # And a green tick still says so — the other way this regresses is by
        # going quiet.
        self.assertIn(IN_SYNC, output)

    def test_every_tool_is_judged_against_the_portal_database(self):
        self._run()
        calls = self._calls()
        for invocation in (
            "pbx/dograh_routes.py --db",
            "pbx/extension_secret.py --db",
            "pbx/voicemail_mailbox.py plan --db",
        ):
            self.assertIn(
                invocation,
                calls,
                f"the wrapper never ran `{invocation} …`:\n{calls}",
            )


if __name__ == "__main__":
    unittest.main()
