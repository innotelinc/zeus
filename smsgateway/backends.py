"""SMS transports for the Linux gateway.

Three backends, picked by ``SMSGATEWAY_BACKEND``:

  modemmanager  a USB modem / LTE stick managed by ModemManager. Discovery and
                status use ``mmcli``; the message itself is created over D-Bus
                with ``dbus-send`` so the body is passed as one string (commas
                and quotes in the text are safe, unlike mmcli's comma-separated
                ``--messaging-create-sms``).
  serial        a raw AT port (``/dev/ttyUSB0``, ``/dev/ttyACM0``, a
                ``/dev/serial/by-id`` path, or an RS-232 phone). Text mode
                (``AT+CMGF=1``), GSM for ASCII and UCS2 for anything else.
  mock          records messages in memory — tests and demos only. Never
                selected by ``auto``.

``auto`` prefers ModemManager when it reports a modem, then probes serial
ports with ``AT``.
"""

from __future__ import annotations

import fcntl
import glob
import os
import re
import select
import shutil
import subprocess
import termios
import threading
import time
from contextlib import contextmanager
from typing import Any, Iterator

from .settings import Settings


class SMSError(Exception):
    """A send failed, or no usable modem is present."""


# --------------------------------------------------------------------------
# input normalisation
# --------------------------------------------------------------------------

def normalize_number(raw: object) -> str:
    """Strip formatting and require an E.164-ish number."""
    value = re.sub(r"[\s()\-.]", "", str(raw or "").strip())
    if not re.fullmatch(r"\+?\d{5,20}", value):
        raise SMSError(f"invalid recipient number: {raw!r}")
    return value


def normalize_text(raw: object) -> str:
    value = str(raw or "")
    if not value.strip():
        raise SMSError("SMS body must not be empty")
    if len(value) > 1600:
        raise SMSError("SMS body is too long (max 1600 characters)")
    return value


# --------------------------------------------------------------------------
# shared helpers
# --------------------------------------------------------------------------

def _run(argv: list[str], timeout: float) -> str:
    """Run a helper command and return its output, with useful failures.

    The argv is passed to execve directly — no shell — so a message body can
    never be interpreted as shell syntax. Errors name the program, never the
    message.
    """
    try:
        proc = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
    except FileNotFoundError as exc:
        raise SMSError(f"{argv[0]} is not installed") from exc
    except subprocess.TimeoutExpired as exc:
        raise SMSError(f"{argv[0]} timed out") from exc
    if proc.returncode != 0:
        lines = [line for line in (proc.stderr or proc.stdout).splitlines() if line.strip()]
        detail = lines[-1].strip() if lines else f"exit {proc.returncode}"
        raise SMSError(f"{argv[0]} failed: {detail}")
    return proc.stdout + proc.stderr


class MockBackend:
    """In-memory transport for tests and dry runs."""

    name = "mock"

    def __init__(self) -> None:
        self.sent: list[dict[str, str]] = []
        self._lock = threading.Lock()

    def available(self) -> bool:
        return True

    def describe(self) -> dict[str, Any]:
        return {"backend": self.name, "device": "memory", "sent": len(self.sent)}

    def send(self, number: object, text: object) -> dict[str, Any]:
        number = normalize_number(number)
        text = normalize_text(text)
        with self._lock:
            self.sent.append({"number": number, "text": text})
            reference = len(self.sent)
        return {"backend": self.name, "reference": reference}


# --------------------------------------------------------------------------
# ModemManager (USB modem / LTE stick)
# --------------------------------------------------------------------------

class ModemManagerBackend:
    name = "modemmanager"

    def __init__(self, mmcli: str = "mmcli", dbus_send: str = "dbus-send",
                 timeout: float = 30.0) -> None:
        self.mmcli = mmcli
        self.dbus_send = dbus_send
        self.timeout = timeout

    def modem_ids(self) -> list[int]:
        out = _run([self.mmcli, "-L"], self.timeout)
        return [int(match) for match in re.findall(r"/Modem/(\d+)", out)]

    def available(self) -> bool:
        try:
            return bool(self.modem_ids())
        except SMSError:
            return False

    def _modem_id(self) -> int:
        ids = self.modem_ids()
        if not ids:
            raise SMSError("ModemManager reports no modem — plug in a USB modem/phone and check `mmcli -L`")
        return ids[0]

    def describe(self) -> dict[str, Any]:
        modem_id = self._modem_id()
        out = _run([self.mmcli, "-m", str(modem_id)], self.timeout)
        state = re.search(r"\bstate:\s*(\S+)", out)
        signal = re.search(r"signal quality:\s*(\d+)%", out)
        operator = re.search(r"operator name:\s*(.+)", out)
        port = re.search(r"primary port:\s*(\S+)", out)
        return {
            "backend": self.name,
            "modem": modem_id,
            "state": state.group(1) if state else "",
            "signal": int(signal.group(1)) if signal else None,
            "operator": operator.group(1).strip() if operator else "",
            "port": port.group(1) if port else "",
        }

    def send(self, number: object, text: object) -> dict[str, Any]:
        number = normalize_number(number)
        text = normalize_text(text)
        modem_id = self._modem_id()
        modem_path = f"/org/freedesktop/ModemManager1/Modem/{modem_id}"

        if shutil.which(self.dbus_send):
            out = _run([
                self.dbus_send, "--system", "--print-reply",
                "--dest=org.freedesktop.ModemManager1", modem_path,
                "org.freedesktop.ModemManager1.Modem.Messaging.CreateTextMessage",
                f"string:{number}", f"string:{text}",
            ], self.timeout)
            match = re.search(r'object path "([^"]+)"', out)
            if not match:
                raise SMSError("ModemManager did not return an SMS object path")
            sms_path = match.group(1)
            _run([
                self.dbus_send, "--system", "--print-reply",
                "--dest=org.freedesktop.ModemManager1", sms_path,
                "org.freedesktop.ModemManager1.Sms.Send",
            ], self.timeout)
            return {"backend": self.name, "modem": modem_id, "sms": sms_path}

        # Fallback for hosts without dbus-send. The text is a single
        # comma-separated property here, so a comma in the body is truncated —
        # the documented reason dbus-send is preferred.
        out = _run([
            self.mmcli, "-m", str(modem_id),
            f"--messaging-create-sms=number={number},text={text}",
        ], self.timeout)
        match = re.search(r"(/org/freedesktop/ModemManager1/SMS/\d+)", out)
        if not match:
            raise SMSError("ModemManager did not create an SMS")
        sms_path = match.group(1)
        _run([self.mmcli, "-m", str(modem_id), f"--messaging-send={sms_path}"], self.timeout)
        return {"backend": self.name, "modem": modem_id, "sms": sms_path}


# --------------------------------------------------------------------------
# Raw serial AT (USB modem, RS-232 phone, anything exposing an AT port)
# --------------------------------------------------------------------------

def _configure_tty(fd: int, baud: int) -> None:
    iflag, oflag, cflag, lflag, ispeed, ospeed, cc = termios.tcgetattr(fd)
    iflag &= ~(termios.IGNBRK | termios.BRKINT | termios.PARMRK | termios.ISTRIP
               | termios.INLCR | termios.IGNCR | termios.ICRNL | termios.IXON)
    oflag &= ~termios.OPOST
    lflag &= ~(termios.ECHO | termios.ECHONL | termios.ICANON | termios.ISIG
               | termios.IEXTEN)
    cflag &= ~(termios.CSIZE | termios.PARENB)
    cflag |= termios.CS8 | termios.CREAD | termios.CLOCAL
    speed = getattr(termios, f"B{baud}", None)
    if speed is None:
        raise SMSError(f"unsupported serial baud rate: {baud}")
    termios.tcsetattr(fd, termios.TCSANOW, [iflag, oflag, cflag, lflag, speed, speed, cc])
    termios.tcflush(fd, termios.TCIOFLUSH)


class SerialATBackend:
    """Speak AT+CMGF text mode to a serial modem."""

    name = "serial"

    def __init__(self, device: str, baud: int = 115200, timeout: float = 30.0) -> None:
        self.device = device
        self.baud = baud
        self.timeout = timeout
        self._lock = threading.Lock()

    def available(self) -> bool:
        return bool(self.device) and os.path.exists(self.device)

    @contextmanager
    def _session(self) -> Iterator[int]:
        if not self.device:
            raise SMSError("no serial device configured (SMSGATEWAY_SERIAL_DEVICE)")
        try:
            fd = os.open(self.device, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
        except OSError as exc:
            raise SMSError(f"cannot open {self.device}: {exc.strerror or exc}") from exc
        try:
            _configure_tty(fd, self.baud)
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise SMSError(f"{self.device} is busy (another sender holds it)") from exc
            yield fd
        finally:
            try:
                fcntl.flock(fd, fcntl.LOCK_UN)
            except OSError:
                pass
            os.close(fd)

    def _write(self, fd: int, data: bytes) -> None:
        while data:
            _, writable, _ = select.select([], [fd], [], self.timeout)
            if not writable:
                raise SMSError("serial write timed out")
            try:
                written = os.write(fd, data)
            except BlockingIOError:
                continue
            data = data[written:]

    def _read(self, fd: int, needles: tuple[str, ...], timeout: float,
              require_all: bool = False) -> str:
        buffer = b""
        deadline = time.monotonic() + max(timeout, 0.1)
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            readable, _, _ = select.select([fd], [], [], remaining)
            if not readable:
                continue
            try:
                chunk = os.read(fd, 4096)
            except BlockingIOError:
                continue
            if not chunk:
                break
            buffer += chunk
            text = buffer.decode("ascii", "replace")
            if "+CMS ERROR" in text or re.search(r"(^|[\r\n])ERROR([\r\n]|$)", text):
                raise SMSError(f"modem error: {text.strip()[-160:]}")
            found = all(needle in text for needle in needles) if require_all \
                else any(needle in text for needle in needles)
            if found:
                return text
        wanted = " + ".join(needles)
        raise SMSError(f"modem timed out waiting for {wanted}")

    def _cmd(self, fd: int, command: str, needles: tuple[str, ...] = ("OK",),
             timeout: float | None = None) -> str:
        self._write(fd, (command + "\r").encode("ascii"))
        return self._read(fd, needles, self.timeout if timeout is None else timeout)

    def describe(self) -> dict[str, Any]:
        with self._lock, self._session() as fd:
            self._cmd(fd, "AT", timeout=min(self.timeout, 3))
            info: dict[str, Any] = {"backend": self.name, "device": self.device}
            for label, command, pattern in (
                ("sim", "AT+CPIN?", r"\+CPIN:\s*(\S+)"),
                ("signal", "AT+CSQ", r"\+CSQ:\s*(\d+)"),
                ("registration", "AT+CREG?", r"\+CREG:\s*\d+\s*,\s*(\d+)"),
            ):
                try:
                    out = self._cmd(fd, command, timeout=min(self.timeout, 5))
                except SMSError:
                    continue
                match = re.search(pattern, out)
                if match:
                    info[label] = match.group(1)
            return info

    def send(self, number: object, text: object) -> dict[str, Any]:
        number = normalize_number(number)
        text = normalize_text(text)
        with self._lock, self._session() as fd:
            self._cmd(fd, "AT", timeout=min(self.timeout, 3))
            self._cmd(fd, "ATE0", timeout=min(self.timeout, 3))
            self._cmd(fd, "AT+CMGF=1", timeout=min(self.timeout, 5))

            # GSM-7 for ASCII; UCS2 for anything else (é, emoji, CJK…).
            if text.isascii():
                self._cmd(fd, 'AT+CSCS="GSM"', timeout=min(self.timeout, 5))
                payload = text
            else:
                self._cmd(fd, 'AT+CSCS="UCS2"', timeout=min(self.timeout, 5))
                payload = text.encode("utf-16-be").hex().upper()

            self._cmd(fd, f'AT+CMGS="{number}"', needles=(">",),
                      timeout=min(self.timeout, 10))
            self._write(fd, payload.encode("ascii") + b"\x1a")
            out = self._read(fd, ("+CMGS:", "OK"), self.timeout, require_all=True)
            match = re.search(r"\+CMGS:\s*(\d+)", out)
            return {
                "backend": self.name,
                "device": self.device,
                "reference": int(match.group(1)) if match else None,
            }


# --------------------------------------------------------------------------
# detection
# --------------------------------------------------------------------------

SERIAL_GLOBS = ("/dev/ttyUSB*", "/dev/ttyACM*", "/dev/ttyAMA*", "/dev/serial/by-id/*")


def serial_devices() -> list[str]:
    found: list[str] = []
    for pattern in SERIAL_GLOBS:
        for path in sorted(glob.glob(pattern)):
            real = os.path.realpath(path)
            if real not in found:
                found.append(real)
    return found


def probe_at(device: str, baud: int = 115200, timeout: float = 2.0) -> bool:
    backend = SerialATBackend(device, baud=baud, timeout=timeout)
    try:
        with backend._session() as fd:
            backend._cmd(fd, "AT", timeout=min(timeout, 2))
        return True
    except (SMSError, OSError):
        return False


def detect_backend(settings: Settings) -> Any:
    """The backend this host can use right now, or None."""
    if settings.backend == "mock":
        return MockBackend()

    if settings.backend == "modemmanager":
        return ModemManagerBackend(settings.mmcli, settings.dbus_send, settings.timeout)

    if settings.backend == "serial":
        device = settings.serial_device or (serial_devices()[0] if serial_devices() else "")
        return SerialATBackend(device, settings.baud, settings.timeout) if device else None

    # auto: a modem ModemManager already owns, then a raw AT probe.
    if shutil.which(settings.mmcli):
        mm = ModemManagerBackend(settings.mmcli, settings.dbus_send, settings.timeout)
        if mm.available():
            return mm
    candidates = [settings.serial_device] if settings.serial_device else serial_devices()
    for device in candidates:
        if probe_at(device, settings.baud):
            return SerialATBackend(device, settings.baud, settings.timeout)
    return None


class Gateway:
    """Lazy backend detection + one entry point for the HTTP layer."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._backend: Any = None
        self._lock = threading.Lock()

    def backend(self, refresh: bool = False) -> Any:
        with self._lock:
            if refresh:
                self._backend = None
            if self._backend is None or not self._backend.available():
                self._backend = detect_backend(self.settings)
            return self._backend

    def send(self, number: object, text: object) -> dict[str, Any]:
        # Validate before detection: a bad number is the caller's mistake and
        # must be reported as such whether or not a modem is plugged in.
        number = normalize_number(number)
        text = normalize_text(text)
        backend = self.backend()
        if backend is None:
            raise SMSError(
                "no SMS modem found — plug in a USB modem/AT-capable phone, "
                "install ModemManager (`mmcli -L`), or set SMSGATEWAY_SERIAL_DEVICE"
            )
        try:
            return backend.send(number, text)
        except SMSError:
            # A vanished device must be re-detected on the next attempt.
            if not backend.available():
                with self._lock:
                    self._backend = None
            raise

    def health(self) -> dict[str, Any]:
        backend = self.backend()
        if backend is None:
            return {
                "ok": False,
                "backend": None,
                "detail": "no SMS modem found — see smsgateway/README.md",
            }
        try:
            return {"ok": True, **backend.describe()}
        except SMSError as exc:
            return {"ok": False, "backend": backend.name, "detail": str(exc)}
