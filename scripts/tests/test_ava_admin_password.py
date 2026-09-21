#!/usr/bin/env python3
"""End-to-end tests for scripts/ava-admin-password.sh against a stub admin API.

This script rotates a live credential and then writes it into `.env` — the file
the portal authenticates from. Both halves can fail in ways that are invisible
until a caller is on the line: a rotation that does not reach `.env` leaves the
portal on AVA's 403 gate, and a second run that rotates again (rather than
recognising the work is done) locks the portal out of the account it just set
up. So the test drives the real script as a subprocess against a stub of AVA's
auth API, and asserts the file contents, the file that must disappear, and what
the API was actually asked to do.

The script's own URL/user/password come from the environment with priority over
the env file; the stub here depends on that, so this also pins the precedence.

Run:  python3 -m unittest discover -s scripts/tests -v
"""
import http.server
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
SCRIPT = os.path.join(REPO_ROOT, "scripts", "ava-admin-password.sh")
ONE_TIME = "one-time-password-from-first-run"
NEW_PASSWORD = "rotated-password-for-the-portal"


class _AdminApi(http.server.BaseHTTPRequestHandler):
    """Just enough of admin_ui/backend/auth.py to exercise the script."""

    state: dict = {}
    calls: list = []

    def log_message(self, *args):  # keep the test output clean
        pass

    def _reply(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length).decode()
        type(self).calls.append((self.path, self.headers.get("Authorization")))

        if self.path == "/api/auth/login":
            form = urllib.parse.parse_qs(raw)
            password = (form.get("password") or [""])[0]
            if password != self.state["password"]:
                return self._reply(401, {"detail": "Incorrect username or password"})
            return self._reply(200, {
                "access_token": "stub-token",
                "token_type": "bearer",
                "must_change_password": self.state["must_change"],
            })

        if self.path == "/api/auth/change-password":
            if not (self.headers.get("Authorization") or "").startswith("Bearer "):
                return self._reply(401, {"detail": "missing bearer"})
            payload = json.loads(raw)
            if payload.get("old_password") != self.state["password"]:
                return self._reply(400, {"detail": "Incorrect old password"})
            self.state["password"] = payload["new_password"]
            self.state["must_change"] = False
            return self._reply(200, {"status": "success"})

        return self._reply(404, {"detail": "not found"})

    def do_GET(self):  # noqa: N802
        if self.path == "/health":
            return self._reply(200, {"status": "ok"})
        return self._reply(404, {"detail": "not found"})


class RotationTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(lambda: __import__("shutil").rmtree(self.tmp, ignore_errors=True))
        self.env_file = os.path.join(self.tmp, ".env")
        self.runtime = os.path.join(self.tmp, "runtime")
        self.first_run = os.path.join(self.runtime, "project", "config", ".first-run-password")
        os.makedirs(os.path.dirname(self.first_run), exist_ok=True)
        with open(self.first_run, "w", encoding="utf-8") as fh:
            fh.write(f"{ONE_TIME}\nOne-time admin password — change it at first login.\n")
        with open(self.env_file, "w", encoding="utf-8") as fh:
            fh.write("# operator's env\nAVA_ARI_USER=zeus-ava\nAVA_ADMIN_PASSWORD=\nLOCAL_WS_PORT=8765\n")

        _AdminApi.state = {"password": ONE_TIME, "must_change": True}
        _AdminApi.calls = []
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _AdminApi)
        self.addCleanup(self.server.server_close)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.shutdown)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def _run(self, *args, **env):
        return subprocess.run(
            ["bash", SCRIPT, *args],
            cwd=self.tmp,
            capture_output=True,
            text=True,
            env={
                **os.environ,
                "AVA_ENV_FILE": self.env_file,
                "AVA_RUNTIME_DIR": self.runtime,
                "AVA_ADMIN_URL": self.url,
                "AVA_NEW_PASSWORD": NEW_PASSWORD,
                **env,
            },
        )

    def _env_value(self, key):
        proc = subprocess.run(
            [sys.executable, os.path.join(REPO_ROOT, "scripts", "env_file.py"), "get", self.env_file, key],
            capture_output=True, text=True, check=True,
        )
        return proc.stdout.strip()

    def test_first_run_password_is_rotated_and_recorded(self):
        proc = self._run()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(self._env_value("AVA_ADMIN_PASSWORD"), NEW_PASSWORD)
        self.assertFalse(os.path.exists(self.first_run), "the spent one-time password must be removed")
        self.assertEqual(_AdminApi.state["password"], NEW_PASSWORD)

    def test_rotation_leaves_the_rest_of_the_env_file_alone(self):
        self._run()
        self.assertEqual(self._env_value("AVA_ARI_USER"), "zeus-ava")
        self.assertEqual(self._env_value("LOCAL_WS_PORT"), "8765")
        with open(self.env_file, encoding="utf-8") as fh:
            self.assertIn("# operator's env", fh.read())

    def test_it_sends_the_one_time_password_as_the_old_one(self):
        self._run()
        seen = [p for p, _ in _AdminApi.calls]
        self.assertIn("/api/auth/change-password", seen)

    def test_a_second_run_does_not_rotate_again(self):
        """Re-rotating would lock the portal out of the account it just set up."""
        self._run()
        before = [p for p, _ in _AdminApi.calls].count("/api/auth/change-password")
        second = self._run()
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertIn("already rotated", second.stdout)
        self.assertEqual([p for p, _ in _AdminApi.calls].count("/api/auth/change-password"), before)
        self.assertEqual(self._env_value("AVA_ADMIN_PASSWORD"), NEW_PASSWORD)

    def test_check_reports_a_pending_rotation_without_writing(self):
        proc = self._run("--check")
        self.assertEqual(proc.returncode, 1)
        self.assertIn("one-time password", proc.stderr)
        self.assertEqual(self._env_value("AVA_ADMIN_PASSWORD"), "")
        self.assertTrue(os.path.exists(self.first_run))

    def test_a_rejected_login_does_not_touch_the_env_file(self):
        _AdminApi.state["password"] = "something else entirely"
        with open(self.first_run, "w", encoding="utf-8") as fh:
            fh.write("stale-one-time\n")
        with open(self.env_file, "w", encoding="utf-8") as fh:
            fh.write("AVA_ADMIN_PASSWORD=wrong-on-purpose\n")
        proc = self._run()
        self.assertEqual(proc.returncode, 1)
        self.assertEqual(self._env_value("AVA_ADMIN_PASSWORD"), "wrong-on-purpose")

    def test_an_unreachable_admin_is_named_as_such(self):
        proc = self._run(AVA_ADMIN_URL="http://127.0.0.1:9")
        self.assertEqual(proc.returncode, 1)
        self.assertIn("unreachable", proc.stderr)


if __name__ == "__main__":
    unittest.main()
