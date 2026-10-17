#!/usr/bin/env python3
"""HTTP-surface tests for smsgateway.

Runs the real stdlib server on an ephemeral port with a stub gateway — no
modem, no serial device, no network beyond loopback.

Run:  python3 -m unittest discover -s smsgateway/tests -v
"""

import json
import threading
import unittest
import urllib.error
import urllib.request

from smsgateway import app
from smsgateway.backends import SMSError
from smsgateway.settings import Settings

KEY = "osms_test_key"


class StubGateway:
    def __init__(self, fail: str | None = None):
        self.fail = fail
        self.sent: list[tuple[str, str]] = []

    def send(self, number, text):
        if self.fail:
            raise SMSError(self.fail)
        self.sent.append((number, text))
        return {"backend": "stub"}

    def health(self):
        return {"ok": True, "backend": "stub", "device": "memory"}


class ApiHarness(unittest.TestCase):
    """Server + helpers; no test methods, so subclasses own the collection."""

    fail: str | None = None

    def setUp(self):
        self.gateway = StubGateway(self.fail)
        self.server = app.build_server(
            Settings(host="127.0.0.1", port=0, api_key=KEY), self.gateway)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)

    def post(self, payload, path="/sms/", key=KEY):
        headers = {"Content-Type": "application/json"}
        if key is not None:
            headers["Authorization"] = f"Bearer {key}"
        req = urllib.request.Request(
            self.base + path, data=json.dumps(payload).encode(), method="POST",
            headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                return resp.status, json.loads(resp.read())
        except urllib.error.HTTPError as exc:
            return exc.code, json.loads(exc.read() or b"{}")

    def get(self, path):
        try:
            with urllib.request.urlopen(self.base + path, timeout=5) as resp:
                return resp.status, json.loads(resp.read())
        except urllib.error.HTTPError as exc:
            return exc.code, json.loads(exc.read() or b"{}")

class ApiTest(ApiHarness):
    def test_send_round_trip(self):
        status, body = self.post({"number": "+15551234567", "text": "hello, world"})
        self.assertEqual(status, 200)
        self.assertEqual(body, {"stat": True})
        self.assertEqual(self.gateway.sent, [("+15551234567", "hello, world")])

    def test_route_without_trailing_slash(self):
        status, body = self.post({"number": "+15551234567", "text": "x"}, path="/sms")
        self.assertEqual(status, 200)
        self.assertEqual(body, {"stat": True})

    def test_auth_is_required(self):
        for key in (None, "wrong"):
            status, body = self.post({"number": "+15551234567", "text": "x"}, key=key)
            self.assertEqual(status, 401)
            self.assertEqual(body["detail"], "Invalid or expired API key")

    def test_missing_fields_are_rejected(self):
        for payload in ({}, {"number": "+15551234567"}, {"text": "hi"},
                        {"number": 5, "text": "hi"}):
            status, _ = self.post(payload)
            self.assertEqual(status, 400, payload)

    def test_invalid_json_is_rejected(self):
        req = urllib.request.Request(
            self.base + "/sms/", data=b"{not json", method="POST",
            headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(req, timeout=5)
        self.assertEqual(ctx.exception.code, 400)

    def test_health_needs_no_auth(self):
        status, body = self.get("/health")
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        self.assertEqual(body["backend"], "stub")

    def test_root_and_unknown_paths(self):
        self.assertEqual(self.get("/")[0], 200)
        self.assertEqual(self.get("/nope")[0], 404)
        self.assertEqual(self.post({"number": "1", "text": "x"}, path="/other")[0], 404)


class SendFailureTest(ApiHarness):
    fail = "no signal"

    def test_failure_is_200_stat_false_with_detail(self):
        status, body = self.post({"number": "+15551234567", "text": "x"})
        self.assertEqual(status, 200)
        self.assertEqual(body["stat"], False)
        self.assertEqual(body["error"], "no signal")
        self.assertEqual(self.gateway.sent, [])


class NoBackendTest(unittest.TestCase):
    """An unplugged gateway is honest: 200 stat:false and a health 503."""

    def setUp(self):
        self.server = app.build_server(
            Settings(host="127.0.0.1", port=0, api_key=KEY, backend="serial",
                     serial_device="/dev/definitely-not-a-modem"),
        )
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)

    def test_send_explains_the_missing_modem(self):
        req = urllib.request.Request(
            self.base + "/sms/", data=b'{"number":"+15551234567","text":"x"}',
            method="POST",
            headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            body = json.loads(resp.read())
        self.assertEqual(resp.status, 200)
        self.assertEqual(body["stat"], False)
        self.assertIn("cannot open", body["error"])

    def test_health_is_503(self):
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(self.base + "/health", timeout=5)
        self.assertEqual(ctx.exception.code, 503)
        body = json.loads(ctx.exception.read())
        self.assertFalse(body["ok"])


if __name__ == "__main__":
    unittest.main()
