#!/usr/bin/env python3
"""The voice deploy preflight, run in CI against a staged tree.

`scripts/deploy-ava-voice.sh --check` is what stands between an operator and a
half-configured voice plane: it is the only place that looks at all four inputs
at once (the credentials, the two halves of the ARI secret, the pinned checkout
with its seeded config, and the speech models). Its value is entirely in
refusing, so the refusals are what this file tests — with one case proving the
whole thing passes on a tree that is actually ready.

This is also the CI gate for config drift: it runs on every `scripts/tests`
step, stages a tree from the tracked template, and fails if the deploy path and
the template stop agreeing.

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
SCRIPT = os.path.join(REPO_ROOT, "scripts", "deploy-ava-voice.sh")
TEMPLATE = os.path.join(REPO_ROOT, "config", "ava", "ai-agent.yaml")
ARI_SECRET = "shared-ari-secret-between-the-two-files"

ENGINE_ENV = """\
# staged for the deploy preflight
AVA_ADMIN_JWT_SECRET=0123456789abcdef0123456789abcdef
AVA_ARI_SECRET={ari}
OMNIROUTE_API_KEY=staged-gateway-key
AVA_ADMIN_URL=http://127.0.0.1:8770
AVA_ADMIN_PASSWORD=rotated-already
LOCAL_STT_MODEL_PATH={stt}
LOCAL_TTS_MODEL_PATH={tts}
LAN_IP={lan}
"""


def _sha(path):
    with open(path, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()


def _git(args, cwd):
    return subprocess.run(
        ["git", "-c", "user.email=t@example.invalid", "-c", "user.name=t", *args],
        cwd=cwd, check=True, capture_output=True, text=True,
    )


class PreflightTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.env_file = os.path.join(self.tmp, ".env")
        self.pbx_env = os.path.join(self.tmp, "pbx.env")
        self.runtime = os.path.join(self.tmp, "runtime")
        self.config = os.path.join(self.runtime, "project", "config", "ai-agent.yaml")
        os.makedirs(os.path.dirname(self.config), exist_ok=True)
        shutil.copy(TEMPLATE, self.config)
        with open(os.path.join(os.path.dirname(self.config), ".template-rev"), "w", encoding="utf-8") as fh:
            fh.write(f"{_sha(TEMPLATE)}\n")
        # A speech model path that exists, and one that does not, so the
        # refusal path is exercised rather than assumed.
        self.stt = os.path.join(self.runtime, "models", "stt", "vosk-model-small-en-us-0.15")
        os.makedirs(self.stt, exist_ok=True)
        self.tts = os.path.join(self.runtime, "models", "tts", "en_US-lessac-medium.onnx")
        os.makedirs(os.path.dirname(self.tts), exist_ok=True)
        open(self.tts, "wb").close()

        self.lan = subprocess.run(
            "ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.*src \\([0-9.]*\\).*/\\1/p' | head -1",
            shell=True, capture_output=True, text=True,
        ).stdout.strip()

        self.write_env()
        self.write_pbx_env()
        self.src, self.pin = self._make_checkout()

    def write_env(self, **overrides):
        text = ENGINE_ENV.format(ari=overrides.pop("ari", ARI_SECRET), stt=self.stt,
                                 tts=self.tts, lan=self.lan)
        for key, value in overrides.items():
            if value is None:
                text = "\n".join(l for l in text.splitlines() if not l.startswith(f"{key}=")) + "\n"
            else:
                text += f"{key}={value}\n"
        with open(self.env_file, "w", encoding="utf-8") as fh:
            fh.write(text)

    def write_pbx_env(self, secret=ARI_SECRET):
        with open(self.pbx_env, "w", encoding="utf-8") as fh:
            fh.write(f"AVA_ARI_USER=zeus-ava\nAVA_ARI_SECRET={secret}\n")

    def _make_checkout(self):
        """A pinned AVA checkout, offline: the preflight compares HEAD to the pin."""
        origin = os.path.join(self.tmp, "origin.git")
        _git(["init", "--bare", "--quiet", origin], cwd=self.tmp)
        src = os.path.join(self.tmp, "ava")
        _git(["clone", "--quiet", origin, src], cwd=self.tmp)
        open(os.path.join(src, ".env.example"), "w", encoding="utf-8").close()
        _git(["add", "-A"], cwd=src)
        _git(["commit", "--quiet", "-m", "seed"], cwd=src)
        head = _git(["rev-parse", "HEAD"], cwd=src).stdout.strip()
        return src, head

    def _run(self, *args):
        return subprocess.run(
            ["bash", SCRIPT, *args],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            env={
                **os.environ,
                "AVA_ENV_FILE": self.env_file,
                "AVA_RUNTIME_DIR": self.runtime,
                "AVA_SRC": self.src,
                "AVA_PIN": self.pin,
                "PBX_ENV_FILE": self.pbx_env,
                "AVA_ADMIN_PASSWORD": "",  # do not let the ambient shell leak in
            },
        )

    def test_a_ready_tree_passes(self):
        proc = self._run("--check")
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn("OMNIROUTE_API_KEY are set", proc.stdout)
        self.assertIn("agrees across", proc.stdout)
        self.assertIn("models present", proc.stdout)
        self.assertIn("nothing was changed", proc.stdout)

    def test_a_missing_gateway_key_is_refused(self):
        self.write_env(OMNIROUTE_API_KEY=None)
        proc = self._run("--check")
        self.assertEqual(proc.returncode, 1)
        self.assertIn("OMNIROUTE_API_KEY", proc.stderr)

    def test_a_missing_jwt_secret_is_refused(self):
        self.write_env(AVA_ADMIN_JWT_SECRET=None)
        proc = self._run("--check")
        self.assertEqual(proc.returncode, 1)
        self.assertIn("AVA_ADMIN_JWT_SECRET", proc.stderr)

    def test_a_disagreeing_ari_secret_is_refused(self):
        self.write_pbx_env(secret="a-different-ari-secret")
        proc = self._run("--check")
        self.assertEqual(proc.returncode, 1)
        self.assertIn("differs", proc.stderr)

    def test_a_missing_speech_model_is_refused(self):
        os.unlink(self.tts)
        proc = self._run("--check")
        self.assertEqual(proc.returncode, 1)
        self.assertIn("missing speech model", proc.stderr)

    def test_a_stale_seeded_config_is_refused(self):
        """The template moved on after this config was seeded — do not deploy it."""
        with open(self.config, "w", encoding="utf-8") as fh:
            fh.write("audiosocket:\n  port: 8090      # an older template revision\n")
        with open(os.path.join(os.path.dirname(self.config), ".template-rev"), "w", encoding="utf-8") as fh:
            fh.write("0" * 64 + "\n")
        proc = self._run("--check")
        self.assertEqual(proc.returncode, 1)
        self.assertIn("older", proc.stderr)

    def test_check_changes_nothing(self):
        before = _sha(self.config)
        self._run("--check")
        self.assertEqual(_sha(self.config), before)
        self.assertFalse(os.path.exists(os.path.join(self.tmp, ".pbx-stage")))
        self.assertNotIn("voice profile started", self._run("--check").stdout)


if __name__ == "__main__":
    unittest.main()
