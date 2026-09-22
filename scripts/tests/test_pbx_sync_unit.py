#!/usr/bin/env python3
"""Pin the wiring that puts the ARI credential gate in front of an apply.

P0 of docs/ava-capstone-convergence.md makes the voice plane's two silent
failures loud, and one of them is a credential: the engine authenticates to
Asterisk with AVA_ARI_SECRET, which `bootstrap-zeus-pbx.sh` renders into
`ari.conf` from `scripts/pbx.env` and `.env` hands to the container, with
nothing reconciling the two. To Asterisk a wrong password is just a failed
login, so the only symptom is calls that are never answered.

`scripts/zeus-pbx-sync.sh` is where the assertion lives. That makes the timer's
entry point load-bearing: `systemd/zeus-pbx-sync.service` called
`pbx/bootstrap-zeus-pbx.sh` directly, which re-applies fragments without ever
asking the credential question — so the gate existed, was documented in
docs/ava-runbook.md, and never ran on the path that actually re-applies.

These tests pin the wiring rather than the behaviour, because the failure mode
is a one-line edit (point ExecStart back at bootstrap) that nothing else would
notice: the unit's own comment becomes a lie and the gate goes quiet.

Run:  python3 -m unittest discover -s scripts/tests -v
"""

from __future__ import annotations

import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
UNIT = REPO / "systemd" / "zeus-pbx-sync.service"
WRAPPER = REPO / "scripts" / "zeus-pbx-sync.sh"


def _unit_directives(name: str) -> list[str]:
    """Every `name=value` line in the unit template, values in file order."""
    out = []
    for line in UNIT.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line.startswith(f"{name}="):
            out.append(line.split("=", 1)[1])
    return out


class TimerRunsTheWrapper(unittest.TestCase):
    def test_execstart_names_the_wrapper_not_bootstrap(self):
        """The gate only runs if the wrapper is what the timer starts."""
        execs = _unit_directives("ExecStart")
        self.assertEqual(len(execs), 1, f"expected one ExecStart, got {execs}")
        self.assertIn("zeus-pbx-sync.sh", execs[0])
        self.assertNotIn("bootstrap-zeus-pbx.sh", execs[0])

    def test_the_unit_still_hands_over_the_secrets_file(self):
        """bootstrap sources PBX_ENV_FILE for the AMI/ARI secrets it renders."""
        self.assertTrue(
            any("pbx.env" in value for value in _unit_directives("Environment")),
            "the unit must keep naming the secrets file the apply reads",
        )


class WrapperGatesBeforeItApplies(unittest.TestCase):
    def setUp(self):
        self.text = WRAPPER.read_text(encoding="utf-8")

    def test_the_credential_check_runs_before_bootstrap(self):
        gate = self.text.index("ava_ari_check.py")
        apply_ = self.text.index("BOOTSTRAP\" --check")
        self.assertLess(
            gate,
            apply_,
            "the ARI check must come first — applying over a credential the "
            "engine cannot use hides the disagreement instead of surfacing it",
        )

    def test_bootstrap_is_called_by_an_absolute_path(self):
        """A relative call makes the apply depend on the caller's CWD."""
        for line in self.text.splitlines():
            if "pbx/bootstrap-zeus-pbx.sh" in line:
                self.assertIn(
                    '"${REPO_ROOT}/pbx/bootstrap-zeus-pbx.sh"',
                    line,
                    f"bootstrap call is not repo-root anchored: {line}",
                )

    def test_an_unreachable_pbx_is_not_a_failed_run(self):
        """A slow PBX boot after a reboot must not fail the timer's unit."""
        tail = [line for line in self.text.splitlines() if line.strip()]
        self.assertEqual(tail[-1].strip(), "exit 0")
        self.assertIn("unreachable or apply failed", "\n".join(tail[-3:]))


if __name__ == "__main__":
    unittest.main()
