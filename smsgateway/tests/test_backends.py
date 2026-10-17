#!/usr/bin/env python3
"""Transport tests for smsgateway.

The serial backend is exercised against a PTY that behaves like an AT modem,
and the ModemManager backend against fake `mmcli`/`dbus-send` programs on
PATH — so the command shapes and the AT dialogue are tested without hardware.

Run:  python3 -m unittest discover -s smsgateway/tests -v
"""

import os
import select
import stat
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from smsgateway import backends
from smsgateway.backends import (
    Gateway,
    ModemManagerBackend,
    MockBackend,
    SMSError,
    SerialATBackend,
    normalize_number,
    normalize_text,
)
from smsgateway.settings import Settings


class NormalizeTest(unittest.TestCase):
    def test_number_is_stripped(self):
        self.assertEqual(normalize_number(" +1 (555) 123-4567 "), "+15551234567")

    def test_bad_numbers_are_refused(self):
        for value in ("", "abc", "12", "+155512345678901234567"):
            with self.assertRaises(SMSError):
                normalize_number(value)

    def test_text_is_required_and_bounded(self):
        with self.assertRaises(SMSError):
            normalize_text("   ")
        with self.assertRaises(SMSError):
            normalize_text("x" * 1601)
        self.assertEqual(normalize_text(" hi "), " hi ")


class MockBackendTest(unittest.TestCase):
    def test_records_and_normalises(self):
        backend = MockBackend()
        result = backend.send("+1 555 123 4567", "hello, world")
        self.assertEqual(result["reference"], 1)
        self.assertEqual(backend.sent, [{"number": "+15551234567", "text": "hello, world"}])


class FakeModem(threading.Thread):
    """A tiny AT modem: text mode, +CMGS reference 7, UCS2 passthrough."""

    def __init__(self, fd: int):
        super().__init__(daemon=True)
        self.fd = fd
        self.commands: list[str] = []
        self.numbers: list[str] = []
        self.bodies: list[str] = []
        self._expect_body = False
        self._halt = threading.Event()

    def shutdown(self):
        self._halt.set()
        self.join(2)

    def run(self):
        buffer = b""
        while not self._halt.is_set():
            try:
                readable, _, _ = select.select([self.fd], [], [], 0.05)
                if not readable:
                    continue
                chunk = os.read(self.fd, 4096)
            except OSError:
                return
            buffer += chunk
            while True:
                if self._expect_body:
                    if b"\x1a" not in buffer:
                        break
                    body, _, buffer = buffer.partition(b"\x1a")
                    self.bodies.append(body.decode("ascii", "replace"))
                    self._expect_body = False
                    os.write(self.fd, b"\r\n+CMGS: 7\r\n\r\nOK\r\n")
                    continue
                if b"\r" not in buffer:
                    break
                line, _, buffer = buffer.partition(b"\r")
                command = line.decode("ascii", "replace").strip()
                if not command:
                    continue
                self.commands.append(command)
                if command.startswith('AT+CMGS="'):
                    self.numbers.append(command.split('"')[1])
                    self._expect_body = True
                    os.write(self.fd, b"\r\n> ")
                elif command == "AT+CSQ":
                    os.write(self.fd, b"\r\n+CSQ: 21,99\r\n\r\nOK\r\n")
                elif command == "AT+CREG?":
                    os.write(self.fd, b"\r\n+CREG: 0,1\r\n\r\nOK\r\n")
                elif command == "AT+CPIN?":
                    os.write(self.fd, b"\r\n+CPIN: READY\r\n\r\nOK\r\n")
                else:
                    os.write(self.fd, b"\r\nOK\r\n")


class SerialBackendTest(unittest.TestCase):
    def setUp(self):
        self.master, self.slave = os.openpty()
        self.device = os.ttyname(self.slave)
        self.modem = FakeModem(self.master)
        self.modem.start()
        self.backend = SerialATBackend(self.device, timeout=5)

    def tearDown(self):
        self.modem.shutdown()
        os.close(self.slave)
        os.close(self.master)

    def test_ascii_send_speaks_the_at_dialogue(self):
        result = self.backend.send("+1 (555) 123-4567", "Hi, there")
        self.assertEqual(result["reference"], 7)
        self.assertEqual(self.modem.numbers, ["+15551234567"])
        self.assertEqual(self.modem.bodies, ["Hi, there"])
        self.assertIn("AT+CMGF=1", self.modem.commands)
        self.assertIn('AT+CSCS="GSM"', self.modem.commands)

    def test_non_ascii_uses_ucs2(self):
        self.backend.send("+15551234567", "héllo")
        self.assertIn('AT+CSCS="UCS2"', self.modem.commands)
        self.assertEqual(self.modem.bodies, ["006800E9006C006C006F"])

    def test_describe_reads_sim_signal_and_registration(self):
        info = self.backend.describe()
        self.assertEqual(info["sim"], "READY")
        self.assertEqual(info["signal"], "21")
        self.assertEqual(info["registration"], "1")

    def test_probe_detects_the_modem(self):
        self.assertTrue(backends.probe_at(self.device, timeout=2))

    def test_missing_device_is_a_clear_error(self):
        backend = SerialATBackend("/dev/definitely-not-a-modem", timeout=1)
        with self.assertRaises(SMSError) as ctx:
            backend.send("+15551234567", "x")
        self.assertIn("cannot open", str(ctx.exception))


FAKE_MMCLI = """#!/bin/sh
case "$*" in
  "-L") echo "    /org/freedesktop/ModemManager1/Modem/0 [Fake] EC200U";;
  "-m 0") cat <<'EOF'
  -------------------------
  General  | primary port: ttyUSB2
           |      drivers: qmi_wwan
  -------------------------
  Status   |           state: registered
           |  signal quality: 63% (recent)
  -------------------------
  3GPP     |   operator name: FakeTel
EOF
  ;;
  *) echo "unexpected mmcli: $*" >&2; exit 1;;
esac
"""

FAKE_DBUS = """#!/bin/sh
printf '<%s>\\n' "$@" >> "$FAKE_DBUS_LOG"
case "$*" in
  *CreateTextMessage*)
    printf 'method return time=1.0 sender=:1.1 -> destination=:1.2 serial=3 reply_serial=2\\n'
    printf '   object path "/org/freedesktop/ModemManager1/SMS/42"\\n';;
  *Sms.Send*)
    printf 'method return time=1.0 sender=:1.1 -> destination=:1.2 serial=4 reply_serial=2\\n';;
  *) echo "unexpected dbus-send: $*" >&2; exit 1;;
esac
"""


class ModemManagerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.bin = Path(self.tmp.name) / "bin"
        self.bin.mkdir()
        for name, body in (("mmcli", FAKE_MMCLI), ("dbus-send", FAKE_DBUS)):
            path = self.bin / name
            path.write_text(body)
            path.chmod(path.stat().st_mode | stat.S_IXUSR)
        self.log = Path(self.tmp.name) / "dbus.log"
        patcher = mock.patch.dict(
            os.environ, {"PATH": f"{self.bin}{os.pathsep}{os.environ['PATH']}",
                         "FAKE_DBUS_LOG": str(self.log)})
        patcher.start()
        self.addCleanup(patcher.stop)

    def backend(self):
        return ModemManagerBackend(timeout=5)

    def test_discovery_and_status(self):
        backend = self.backend()
        self.assertEqual(backend.modem_ids(), [0])
        info = backend.describe()
        self.assertEqual(info["modem"], 0)
        self.assertEqual(info["state"], "registered")
        self.assertEqual(info["signal"], 63)
        self.assertEqual(info["operator"], "FakeTel")
        self.assertEqual(info["port"], "ttyUSB2")

    def test_send_preserves_commas_in_one_string_argument(self):
        result = self.backend().send("+1 (555) 123-4567", "Hi, there")
        self.assertEqual(result["sms"], "/org/freedesktop/ModemManager1/SMS/42")

        logged = self.log.read_text()
        self.assertIn("<string:+15551234567>", logged)
        self.assertIn("<string:Hi, there>", logged)
        # The SMS object path is what Sms.Send was called on.
        self.assertIn("</org/freedesktop/ModemManager1/SMS/42>", logged)

    def test_no_modem_is_a_clear_error(self):
        backend = self.backend()
        with mock.patch.object(backend, "modem_ids", return_value=[]):
            with self.assertRaises(SMSError) as ctx:
                backend.send("+15551234567", "x")
        self.assertIn("no modem", str(ctx.exception))


class DetectionTest(unittest.TestCase):
    def test_mock_is_explicit_only(self):
        self.assertIsInstance(backends.detect_backend(Settings(backend="mock")), MockBackend)

    def test_auto_without_any_modem_is_none(self):
        with mock.patch.object(backends.shutil, "which", return_value=None), \
             mock.patch.object(backends, "serial_devices", return_value=[]):
            self.assertIsNone(backends.detect_backend(Settings(backend="auto")))

    def test_auto_prefers_modemmanager(self):
        with mock.patch.object(backends.shutil, "which", return_value="/usr/bin/mmcli"), \
             mock.patch.object(ModemManagerBackend, "available", return_value=True):
            self.assertIsInstance(backends.detect_backend(Settings(backend="auto")),
                                  ModemManagerBackend)

    def test_gateway_reports_missing_hardware(self):
        gateway = Gateway(Settings(backend="serial", serial_device="/dev/nope"))
        with self.assertRaises(SMSError) as ctx:
            gateway.send("+15551234567", "x")
        self.assertIn("cannot open", str(ctx.exception))
        self.assertFalse(gateway.health()["ok"])

    def test_bad_number_is_reported_before_missing_hardware(self):
        gateway = Gateway(Settings(backend="serial", serial_device="/dev/nope"))
        with self.assertRaises(SMSError) as ctx:
            gateway.send("not-a-number", "x")
        self.assertIn("invalid recipient number", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
