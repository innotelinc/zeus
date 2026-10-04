#!/usr/bin/env python3
"""Tests for pbx/ari_conf_guard.py.

The guard exists because FreePBX's own arimanager maintenance rewrote ari.conf
once and dropped its `[general]` include block, silently un-including
`ari_additional_custom.conf` (Capstone's `[dograh]` ARI user). ARI then answered
404 with every user section still present, so the only symptom was calls that
were never answered.

Run:  python3 -m unittest pbx.tests.test_ari_conf_guard -v
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
GUARD = REPO / "pbx" / "ari_conf_guard.py"

INTACT = """\
; FreePBX ARI config
[general]
enabled = yes
pretty = no
#include ari_general_additional.conf
#include ari_general_custom.conf
#include ari_additional.conf
#include ari_additional_custom.conf

[pbxportal]
type = user
password = secret
"""


def run(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(GUARD), *args],
        capture_output=True,
        text=True,
    )


class Guard(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="ari-guard-"))
        self.addCleanup(lambda: __import__("shutil").rmtree(self.tmp, ignore_errors=True))
        self.conf = self.tmp / "ari.conf"
        # The fragments the guard keys on.
        for name in ("ari_general_additional.conf", "ari_additional.conf",
                     "ari_additional_custom.conf"):
            (self.tmp / name).write_text("[general]\n", encoding="utf-8")

    def test_an_intact_general_block_passes(self):
        self.conf.write_text(INTACT, encoding="utf-8")
        proc = run("--ari-conf", str(self.conf))
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)

    def test_a_missing_general_block_is_drift(self):
        # The exact clobber: user sections survive, [general] is gone.
        self.conf.write_text("[pbxportal]\ntype = user\n", encoding="utf-8")
        proc = run("--ari-conf", str(self.conf))
        self.assertEqual(proc.returncode, 1)
        self.assertIn("[general]", proc.stderr)

    def test_a_fragment_without_an_include_is_drift(self):
        self.conf.write_text(
            "[general]\nenabled = yes\n#include ari_additional.conf\n", encoding="utf-8"
        )
        proc = run("--ari-conf", str(self.conf))
        self.assertEqual(proc.returncode, 1)
        self.assertIn("ari_additional_custom.conf", proc.stderr)

    def test_enabled_no_is_drift(self):
        self.conf.write_text(INTACT.replace("enabled = yes", "enabled = no"),
                             encoding="utf-8")
        proc = run("--ari-conf", str(self.conf))
        self.assertEqual(proc.returncode, 1)
        self.assertIn("disabled", proc.stderr)

    def test_missing_ari_conf_alongside_fragments_is_drift(self):
        proc = run("--ari-conf", str(self.tmp / "nope.conf"),
                   "--asterisk-dir", str(self.tmp))
        self.assertEqual(proc.returncode, 1)
        self.assertIn("missing", proc.stderr)

    def test_quiet_suppresses_the_success_line(self):
        self.conf.write_text(INTACT, encoding="utf-8")
        proc = run("--quiet", "--ari-conf", str(self.conf))
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(proc.stderr.strip(), "")


class Repair(unittest.TestCase):
    """`--repair` puts back only what the detector proved missing."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="ari-guard-repair-"))
        self.addCleanup(lambda: __import__("shutil").rmtree(self.tmp, ignore_errors=True))
        self.conf = self.tmp / "ari.conf"
        for name in ("ari_general_additional.conf", "ari_additional.conf",
                     "ari_additional_custom.conf"):
            (self.tmp / name).write_text("[general]\n", encoding="utf-8")

    def test_a_dropped_general_block_is_restored(self):
        # The exact clobber: user sections survive, [general] is gone.
        self.conf.write_text("[pbxportal]\ntype = user\n", encoding="utf-8")
        proc = run("--repair", "--ari-conf", str(self.conf))
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        text = self.conf.read_text(encoding="utf-8")
        self.assertIn("[general]", text)
        self.assertIn("#include ari_additional_custom.conf", text)
        self.assertIn("[pbxportal]", text, "the user section is preserved")
        # And the detector agrees it is fixed now.
        self.assertEqual(run("--quiet", "--ari-conf", str(self.conf)).returncode, 0)

    def test_a_missing_include_is_added_under_general(self):
        self.conf.write_text(
            "[general]\nenabled = yes\n#include ari_additional.conf\n", encoding="utf-8"
        )
        proc = run("--repair", "--ari-conf", str(self.conf))
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        text = self.conf.read_text(encoding="utf-8")
        self.assertIn("#include ari_additional_custom.conf", text)
        # Inserted under [general], ahead of the include that was already there.
        self.assertLess(
            text.index("#include ari_additional_custom.conf"),
            text.index("#include ari_additional.conf"),
        )
        self.assertEqual(run("--quiet", "--ari-conf", str(self.conf)).returncode, 0)

    def test_enabled_no_is_a_decision_and_is_left_alone(self):
        body = INTACT.replace("enabled = yes", "enabled = no")
        self.conf.write_text(body, encoding="utf-8")
        proc = run("--repair", "--ari-conf", str(self.conf))
        self.assertEqual(proc.returncode, 1)
        self.assertIn("refusing", proc.stderr)
        self.assertEqual(self.conf.read_text(encoding="utf-8"), body)

    def test_no_fragments_means_nothing_to_repair(self):
        conf = self.tmp / "scratch" / "ari.conf"
        conf.parent.mkdir()
        conf.write_text("[rehearsal]\ntype = user\n", encoding="utf-8")
        proc = run("--repair", "--quiet", "--ari-conf", str(conf))
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertEqual(conf.read_text(encoding="utf-8"), "[rehearsal]\ntype = user\n")

    def test_repair_writes_through_a_symlink(self):
        # ari.conf is the FreePBX module's own file, reached through a symlink:
        # repairing must rewrite the target, not replace the link with a file.
        target = self.tmp / "module-ari.conf"
        target.write_text("[pbxportal]\ntype = user\n", encoding="utf-8")
        self.conf.unlink(missing_ok=True)
        self.conf.symlink_to(target)
        proc = run("--repair", "--quiet", "--ari-conf", str(self.conf))
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertTrue(self.conf.is_symlink(), "the symlink survives")
        self.assertIn("[general]", target.read_text(encoding="utf-8"))


class NotApplicable(unittest.TestCase):
    """A scratch/hand-rolled ari.conf must not manufacture drift."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="ari-guard-none-"))
        self.addCleanup(lambda: __import__("shutil").rmtree(self.tmp, ignore_errors=True))

    def test_no_fragments_is_not_drift(self):
        conf = self.tmp / "ari.conf"
        conf.write_text("[rehearsal]\ntype = user\n", encoding="utf-8")
        proc = run("--quiet", "--ari-conf", str(conf))
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)

    def test_require_include_forces_the_check_even_without_a_sibling(self):
        conf = self.tmp / "ari.conf"
        conf.write_text("[rehearsal]\ntype = user\n", encoding="utf-8")
        proc = run("--ari-conf", str(conf), "--require-include", "ari_additional_custom.conf")
        self.assertEqual(proc.returncode, 1)


if __name__ == "__main__":
    unittest.main()
