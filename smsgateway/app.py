"""OpenSMS-compatible SMS gateway for Linux.

Speaks the API the Zeus/Capstone clients and the Android app already use:

    POST /sms/            Authorization: Bearer <key>
    {"number": "+1555…", "text": "hello"}   ->   {"stat": true}

A send that the modem refuses answers `200 {"stat": false, "error": "…"}` —
the same shape OpenSMS uses for `stat` — so the clients show the real reason
(no SIM, no signal, no modem) instead of a generic failure.

    GET /health           no auth; backend, SIM, signal, operator
    GET /                 no auth; service info

Stdlib only. Run it as a host service next to the USB modem:

    python3 -m smsgateway
    python3 -m smsgateway --check
    python3 -m smsgateway --send +15551234567 "test"
"""

from __future__ import annotations

import argparse
import hmac
import json
import logging
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

from .backends import Gateway, SMSError
from .settings import Settings

LOG = logging.getLogger("smsgateway")
MAX_BODY = 64 * 1024


class GatewayServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    settings: Settings
    gateway: Gateway


class Handler(BaseHTTPRequestHandler):
    server_version = "smsgateway/1.0"
    protocol_version = "HTTP/1.1"

    # ---- plumbing -------------------------------------------------------

    def log_message(self, fmt: str, *args: object) -> None:  # noqa: A003
        LOG.debug("%s - %s", self.address_string(), fmt % args)

    def _json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self) -> bool:
        settings = self.server.settings
        if settings.allow_anon:
            return True
        header = self.headers.get("Authorization", "")
        if not header.lower().startswith("bearer "):
            return False
        return hmac.compare_digest(header[7:].strip(), settings.api_key)

    def _unauthorized(self) -> None:
        # OpenSMS's own 401 body, so a misconfigured client reads the same thing.
        self._json(401, {"detail": "Invalid or expired API key"})

    # ---- routes ---------------------------------------------------------

    def do_GET(self) -> None:  # noqa: N802 - http.server API
        path = urlparse(self.path).path.rstrip("/") or "/"
        if path in ("/health", "/healthz"):
            health = self.server.gateway.health()
            self._json(200 if health.get("ok") else 503, health)
            return
        if path == "/":
            self._json(200, {
                "service": "smsgateway",
                "api": "OpenSMS-compatible",
                "endpoints": {"send": "POST /sms/", "health": "GET /health"},
            })
            return
        self._json(404, {"detail": "Not Found"})

    def do_POST(self) -> None:  # noqa: N802 - http.server API
        path = urlparse(self.path).path
        if path not in ("/sms", "/sms/"):
            self._json(404, {"detail": "Not Found"})
            return
        if not self._authorized():
            self._unauthorized()
            return

        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0:
            self._json(400, {"detail": "A JSON body is required"})
            return
        if length > MAX_BODY:
            self._json(413, {"detail": "Request body is too large"})
            return

        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            self._json(400, {"detail": "Invalid JSON"})
            return
        if not isinstance(payload, dict):
            self._json(400, {"detail": "A JSON object is required"})
            return

        number = payload.get("number")
        text = payload.get("text")
        if not isinstance(number, str) or not isinstance(text, str):
            self._json(400, {"detail": "'number' and 'text' are required strings"})
            return

        try:
            result = self.server.gateway.send(number, text)
        except SMSError as exc:
            LOG.warning("send failed: %s", exc)
            # 200 + stat:false matches OpenSMS; `error` is what our clients read.
            self._json(200, {"stat": False, "error": str(exc)})
            return

        LOG.info("sent via %s (%s chars)", result.get("backend"), len(text))
        self._json(200, {"stat": True})


def build_server(settings: Settings, gateway: Gateway | None = None) -> GatewayServer:
    server = GatewayServer((settings.host, settings.port), Handler)
    server.settings = settings
    server.gateway = gateway or Gateway(settings)
    return server


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="smsgateway",
        description="OpenSMS-compatible SMS API for a USB modem or AT-capable phone.",
    )
    parser.add_argument("--host", help="bind address (default SMSGATEWAY_HOST or 127.0.0.1)")
    parser.add_argument("--port", type=int, help="listen port (default SMSGATEWAY_PORT or 9292)")
    parser.add_argument("--backend", choices=("auto", "modemmanager", "serial", "mock"))
    parser.add_argument("--serial-device", dest="serial_device",
                        help="AT port, e.g. /dev/ttyUSB2 (default: auto-detect)")
    parser.add_argument("--check", action="store_true",
                        help="print the detected backend/health and exit")
    parser.add_argument("--send", nargs=2, metavar=("NUMBER", "TEXT"),
                        help="send one message through the detected backend and exit")
    parser.add_argument("--debug", action="store_true")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.debug else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        stream=sys.stderr,
    )

    settings = Settings.from_env().with_overrides(
        host=args.host, port=args.port, backend=args.backend,
        serial_device=args.serial_device,
    )
    gateway = Gateway(settings)

    if args.check:
        health = gateway.health()
        print(json.dumps(health, indent=2))
        return 0 if health.get("ok") else 1

    if args.send:
        try:
            result = gateway.send(args.send[0], args.send[1])
        except SMSError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 1
        print(json.dumps(result, indent=2))
        return 0

    if not settings.api_key and not settings.allow_anon:
        print(
            "refusing to start without SMSGATEWAY_API_KEY (or OPENSMS_API_KEY). "
            "Generate one with: openssl rand -hex 24",
            file=sys.stderr,
        )
        return 2

    server = build_server(settings, gateway)
    host, port = server.server_address[:2]
    health = gateway.health()
    LOG.info("listening on http://%s:%s — backend: %s", host, port,
             health.get("backend") or "none (no modem detected)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
