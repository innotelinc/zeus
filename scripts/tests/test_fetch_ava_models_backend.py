#!/usr/bin/env python3
"""Unit tests for scripts/fetch-ava-models.sh — which voice it stages.

The script stages the TTS artifacts for the backend the *server* runs. The two
disagreeing is silent until a call: a Kokoro server with no `kokoro/` tree
reaches for HuggingFace on its first turn, and a turn that downloads its voice
is a turn the caller hears as silence. So the backend comes from
`LOCAL_TTS_BACKEND` in `.env` — the same read `deploy-ava-voice.sh` makes in its
model check, so the check and the fetch cannot look at different backends —
with piper as the fallback for an install that predates the switch, where the
old hard-coded default is still the right answer.

Network is faked with a `curl` placed on PATH that records the URL it was asked
for and writes one byte in its place. The assertions are therefore about the
*URLs this script chose*, which is the decision under test, rather than about a
download that a test should not be making:

  * `.env` says kokoro  -> the Kokoro model, its config and the voice `.env`
                           names, and never piper's .onnx
  * `.env` says piper   -> the piper .onnx and the .json beside it, never Kokoro
  * `.env` says nothing -> piper, unchanged for the installs that never chose
  * `--tts` given       -> the flag wins over `.env` (a one-off fetch)

Run:  python3 -m unittest discover -s scripts/tests -v
"""
import os
import shutil
import stat
import subprocess
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
SCRIPT = os.path.join(REPO_ROOT, "scripts", "fetch-ava-models.sh")
VOSK_NAME = "vosk-model-small-en-us-0.15"

# Records the URL of every call and satisfies the `-o` the script passes. The
# flags that take a value have to be consumed as such, or `--retry 3` would be
# logged as a URL named "3".
FAKE_CURL = """#!/usr/bin/env bash
set -euo pipefail
dest=""
url=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o) dest="$2"; shift 2 ;;
    --retry|--retry-delay|--connect-timeout|--max-time) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
printf '%s\\n' "$url" >> "${FAKE_CURL_LOG:?}"
if [[ -n "$dest" ]]; then printf 'x' > "$dest"; fi
exit 0
"""


class _BackendCase(unittest.TestCase):
    """A throwaway models dir and a fake curl, one run per case."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)

        self.models = os.path.join(self.tmp, "models")
        # The STT half is skipped when its README is present, so a run with no
        # --force touches only the TTS artifacts — the part under test.
        vosk = os.path.join(self.models, "stt", VOSK_NAME)
        os.makedirs(vosk)
        with open(os.path.join(vosk, "README"), "w", encoding="utf-8") as fh:
            fh.write("staged by the fixture\n")

        self.bin = os.path.join(self.tmp, "bin")
        os.makedirs(self.bin)
        curl = os.path.join(self.bin, "curl")
        with open(curl, "w", encoding="utf-8") as fh:
            fh.write(FAKE_CURL)
        os.chmod(curl, os.stat(curl).st_mode | stat.S_IXUSR | stat.S_IXGRP)

        self.log = os.path.join(self.tmp, "curl.log")
        self.env_file = os.path.join(self.tmp, "ava.env")

    def _write_env(self, **keys):
        with open(self.env_file, "w", encoding="utf-8") as fh:
            for key, value in keys.items():
                fh.write(f"{key}={value}\n")

    def run_script(self, *args):
        """Run the fetcher with the fake curl first on PATH; return its URLs."""
        env = dict(os.environ)
        env["PATH"] = self.bin + os.pathsep + env["PATH"]
        env["FAKE_CURL_LOG"] = self.log
        env["AVA_ENV_FILE"] = self.env_file
        proc = subprocess.run(
            ["bash", SCRIPT, "--models-dir", self.models, *args],
            cwd=REPO_ROOT,
            env=env,
            capture_output=True,
            text=True,
        )
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        try:
            with open(self.log, "r", encoding="utf-8") as fh:
                return [line.strip() for line in fh if line.strip()]
        except FileNotFoundError:
            return []


class TestFetchedVoiceFollowsTheBackend(_BackendCase):
    def test_kokoro_backend_stages_kokoro_and_the_named_voice(self):
        self._write_env(LOCAL_TTS_BACKEND="kokoro", LOCAL_TTS_VOICE="am_michael")
        urls = self.run_script()

        self.assertTrue(urls, "expected the Kokoro artifacts to be fetched")
        for url in urls:
            self.assertIn("hexgrad/Kokoro-82M", url)
        self.assertIn(
            "https://huggingface.co/hexgrad/Kokoro-82M/resolve/main/kokoro-v1_0.pth",
            urls,
        )
        # The voice is the one .env names, not the script's own default: staging
        # af_heart for a server configured with am_michael is the same silence.
        self.assertIn(
            "https://huggingface.co/hexgrad/Kokoro-82M/resolve/main/voices/am_michael.pt",
            urls,
        )
        self.assertFalse([u for u in urls if "piper-voices" in u])

    def test_piper_backend_stages_piper_and_never_kokoro(self):
        self._write_env(LOCAL_TTS_BACKEND="piper")
        urls = self.run_script()

        self.assertEqual(len(urls), 2, urls)
        for url in urls:
            self.assertIn("piper-voices", url)
        self.assertTrue(any(url.endswith("en_US-lessac-medium.onnx") for url in urls))
        self.assertTrue(any(url.endswith("en_US-lessac-medium.onnx.json") for url in urls))
        self.assertFalse([u for u in urls if "Kokoro" in u])

    def test_no_backend_in_env_keeps_the_piper_default(self):
        # A deployment that predates the switch: no LOCAL_TTS_BACKEND at all,
        # which is also the case when the file is missing entirely.
        urls = self.run_script()

        self.assertEqual(len(urls), 2, urls)
        self.assertTrue(all("piper-voices" in url for url in urls))

    def test_flag_overrides_the_env_file(self):
        self._write_env(LOCAL_TTS_BACKEND="kokoro")
        urls = self.run_script("--tts", "piper")

        self.assertTrue(all("piper-voices" in url for url in urls), urls)
        self.assertFalse([u for u in urls if "Kokoro" in u])


class TestBackendIsRejectedWhenUnknown(_BackendCase):
    def test_an_unknown_backend_is_refused_rather_than_silently_staged(self):
        env = dict(os.environ)
        env["AVA_ENV_FILE"] = self.env_file
        self._write_env(LOCAL_TTS_BACKEND="melotts")
        proc = subprocess.run(
            ["bash", SCRIPT, "--models-dir", self.models],
            cwd=REPO_ROOT,
            env=env,
            capture_output=True,
            text=True,
        )
        self.assertEqual(proc.returncode, 2, proc.stdout + proc.stderr)
        self.assertIn("must be piper or kokoro", proc.stderr)
        self.assertIn("melotts", proc.stderr)
        # It came from the env file, so the refusal has to say so rather than
        # naming a --tts flag nobody passed.
        self.assertIn("LOCAL_TTS_BACKEND", proc.stderr)


if __name__ == "__main__":
    unittest.main()
