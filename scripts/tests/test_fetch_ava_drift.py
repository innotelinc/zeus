#!/usr/bin/env python3
"""Unit tests for scripts/fetch-ava.sh — runtime-config provenance.

The script never overwrites the seeded runtime config: AVA's admin UI owns
that file once calls are being taken, so a template that gains a fix leaves
the deployed copy untouched, silently. The revision stamp written at seed time
is the only thing that makes that visible, so its contract is pinned here:

  * seeded from the current template      -> current, check passes
  * seeded from an older template         -> check FAILS and names --force,
                                             because a moved AudioSocket port
                                             or a missing transfer tool would
                                             otherwise reach a caller first
  * no stamp, content differs             -> reported as unverifiable, not
                                             failed: the file may hold admin
                                             edits and --force discards them
  * no stamp, content matches the template-> current (adopted by content)

--check is documented as "no network, no writes", so every case also asserts
the runtime config is byte-identical afterwards.

Run:  python3 -m unittest discover -s scripts/tests -v
"""
import hashlib
import os
import shutil
import subprocess
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
SCRIPT = os.path.join(REPO_ROOT, "scripts", "fetch-ava.sh")
TEMPLATE = os.path.join(REPO_ROOT, "config", "ava", "ai-agent.yaml")
STAMP_NAME = ".template-rev"

GIT_ID = ["-c", "user.email=test@example.invalid", "-c", "user.name=test"]
NOISE = {"stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL}


def _sha(blob: bytes) -> str:
    return hashlib.sha256(blob).hexdigest()


def _read(path: str) -> bytes:
    with open(path, "rb") as fh:
        return fh.read()


def _git(args, cwd, check=True):
    return subprocess.run(["git", *GIT_ID, *args], cwd=cwd, check=check, **NOISE)


class _DriftCase(unittest.TestCase):
    """Shared fixture: a throwaway AVA checkout whose origin can be fetched."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.src = self._make_checkout()
        self.runtime = os.path.join(self.tmp, "runtime")
        self.config = os.path.join(self.runtime, "project", "config", "ai-agent.yaml")
        self.stamp = os.path.join(self.runtime, "project", "config", STAMP_NAME)
        self.template = _read(TEMPLATE)

    def _make_checkout(self):
        origin = os.path.join(self.tmp, "origin.git")
        _git(["init", "--bare", "--quiet", origin], cwd=self.tmp)
        src = os.path.join(self.tmp, "ava")
        _git(["clone", "--quiet", origin, src], cwd=self.tmp)
        # AVA's own tree, just enough of it for the script's seeding step.
        with open(os.path.join(src, ".env.example"), "w", encoding="utf-8") as fh:
            fh.write("LOCAL_WS_AUTH_TOKEN=\n")
        _git(["add", "-A"], cwd=src)
        _git(["commit", "--quiet", "-m", "seed"], cwd=src)
        self.pin = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=src, check=True,
            capture_output=True, text=True,
        ).stdout.strip()
        return src

    def _seed_config(self, blob: bytes, stamp: str | None):
        os.makedirs(os.path.dirname(self.config), exist_ok=True)
        with open(self.config, "wb") as fh:
            fh.write(blob)
        if stamp is not None:
            with open(self.stamp, "w", encoding="utf-8") as fh:
                fh.write(f"{stamp}\n")

    def _check(self):
        before = _read(self.config)
        proc = subprocess.run(
            ["bash", SCRIPT, "--check"],
            cwd=self.tmp,
            env={
                **os.environ,
                "AVA_SRC": self.src,
                "AVA_RUNTIME_DIR": self.runtime,
                "AVA_PIN": self.pin,
            },
            capture_output=True,
            text=True,
        )
        self.assertEqual(_read(self.config), before,
                         "--check must not write the runtime config")
        return proc


class CurrentTemplateTest(_DriftCase):
    def test_stamp_at_the_current_revision_passes(self):
        self._seed_config(self.template, _sha(self.template))
        proc = self._check()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("from the current template", proc.stdout)

    def test_unstamped_copy_of_the_template_passes(self):
        """A file an operator copied over by hand is current, not unverifiable."""
        self._seed_config(self.template, None)
        proc = self._check()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("from the current template", proc.stdout)


class StaleStampTest(_DriftCase):
    def test_seed_from_an_older_template_fails_and_names_the_fix(self):
        stale = self.template.replace(b"port: 8097", b"port: 8090")
        self.assertNotEqual(stale, self.template, "fixture must differ from the template")
        self._seed_config(stale, _sha(b"an older revision of the template"))
        proc = self._check()
        self.assertEqual(proc.returncode, 1, proc.stdout)
        self.assertIn("older config/ava/ai-agent.yaml", proc.stderr)
        self.assertIn("--force", proc.stderr)
        self.assertIn("diff", proc.stderr)

    def test_locally_edited_seed_still_passes_while_the_template_is_current(self):
        """Admin edits are the admin UI's business — only provenance is judged."""
        edited = self.template.replace(
            b"initial_greeting: ", b"initial_greeting: Hello, this is the estate. # "
        )
        self.assertNotEqual(edited, self.template)
        self._seed_config(edited, _sha(self.template))
        proc = self._check()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("from the current template", proc.stdout)


class UnverifiableTest(_DriftCase):
    def test_unstamped_file_that_differs_warns_without_being_replaced(self):
        self._seed_config(self.template.replace(b"port: 8097", b"port: 8090"), None)
        proc = self._check()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        # A warning, not a failure: --force would discard admin edits, so the
        # file is never replaced on the strength of a missing stamp.
        self.assertIn("unverifiable", proc.stdout)
        self.assertIn("--force", proc.stdout)
        self.assertNotIn("from the current template", proc.stdout)


if __name__ == "__main__":
    unittest.main()
