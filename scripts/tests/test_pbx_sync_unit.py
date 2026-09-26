#!/usr/bin/env python3
"""Pin the wiring between the timer's unit and the wrapper it runs.

P0 of docs/voice-convergence.md makes the voice plane's silent failures loud.
One of them was a credential: the AVA engine authenticated to Asterisk with a
secret `bootstrap-zeus-pbx.sh` rendered into `ari.conf` from `scripts/pbx.env`,
while `.env` handed the container its own copy and nothing reconciled the two —
and to Asterisk a wrong password is just a failed login, so the only symptom was
calls that were never answered. That gate went with the engine.

`scripts/zeus-pbx-sync.sh` is still where an assertion in front of the apply
belongs, and that still makes the timer's entry point load-bearing:
`systemd/zeus-pbx-sync.service` called `pbx/bootstrap-zeus-pbx.sh` directly
once, so a gate could exist, be documented, and never run on the path that
actually re-applies.

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

    def test_it_has_no_ava_credential_gate(self):
        """The ARI-credential gate went with the AVA engine.

        `pbx/ava_ari_check.py` is deleted, so a wrapper that still called it would
        fail the unit before the apply on every tick — and the failure would read
        as a credential disagreement rather than as a missing file.
        """
        self.assertNotIn("ava_ari_check", self.text)

    def test_bootstrap_is_called_by_an_absolute_path(self):
        """A relative call makes the apply depend on the caller's CWD."""
        for line in self.text.splitlines():
            if "pbx/bootstrap-zeus-pbx.sh" in line:
                self.assertIn(
                    '"${REPO_ROOT}/pbx/bootstrap-zeus-pbx.sh"',
                    line,
                    f"bootstrap call is not repo-root anchored: {line}",
                )

    def test_it_reconciles_the_media_address_every_tick(self):
        """The boot entrypoint converges it; a rebuilt box needs the timer to.

        A box whose image predates the entrypoint change, or a media file whose
        `#include` someone removed, looks healthy everywhere else — the endpoint
        answers, it just hands the phone the container's own (unreachable)
        address, and one-way audio is the only symptom. Unlike a DID route this
        value is auto-derivable and the tool is idempotent, so the timer both
        checks it and applies it on drift (that is what re-derives it after a
        boot with no 45-90 minute image rebuild).
        """
        self.assertIn("media_address.py", self.text)
        self.assertIn("pjsip_media_custom.conf", self.text)
        self.assertIn("media_run --check", self.text)
        self.assertIn("media_run --apply", self.text)
        # Run inside the PBX container, against its own device table.
        self.assertIn("--devices-tsv -", self.text)
        self.assertIn("--asterisk-dir /etc/asterisk", self.text)

    def test_it_reconciles_the_outbound_route_every_tick(self):
        """The route that normalises a dialled number, checked and re-applied.

        A rebuilt box, or a GUI edit, puts a bare `X.` catch-all back in front of
        the normalisation: outbound calls stop completing while the trunk stays
        registered. This is derivable and idempotent, so like the media address
        the timer both judges it and applies on drift.
        """
        self.assertIn("outbound_route.py", self.text)
        self.assertIn("--check --local", self.text)
        self.assertIn("--apply --local", self.text)

    def test_an_unreachable_pbx_is_not_a_failed_run(self):
        """A slow PBX boot after a reboot must not fail the timer's unit."""
        tail = [line for line in self.text.splitlines() if line.strip()]
        self.assertEqual(tail[-1].strip(), "exit 0")
        self.assertIn("not applied", "\n".join(tail[-4:]))
        self.assertIn("unreachable", "\n".join(tail[-4:]))

    def test_the_apply_s_output_reaches_the_journal(self):
        """Exiting 0 must not also mean staying quiet.

        The apply exits non-zero for a cause that never clears itself — a
        platform DID with no inbound route is a person's job in FreePBX — so the
        journal has to carry what it said, or a gap this estate knows about
        looks exactly like a healthy sync.
        """
        self.assertIn('out="$("$BOOTSTRAP" 2>&1)"', self.text)
        self.assertIn('printf \'%s\\n\' "$out"', self.text)


if __name__ == "__main__":
    unittest.main()
