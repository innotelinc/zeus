"""Linux SMS gateway configuration.

The service speaks the OpenSMS API (`POST /sms/`, Bearer key, `{"stat": true}`)
so Zeus, Capstone and the Android app are interchangeable endpoints. The
transport underneath is a USB modem / AT-capable phone instead of Android's
SmsManager.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, replace

BACKENDS = ("auto", "modemmanager", "serial", "mock")


def _truthy(value: str | None) -> bool:
    return str(value or "").strip().lower() in ("1", "true", "yes", "on")


def _int(value: str | None, default: int) -> int:
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return default


def _float(value: str | None, default: float) -> float:
    try:
        return float(str(value).strip())
    except (TypeError, ValueError):
        return default


@dataclass(frozen=True)
class Settings:
    host: str = "127.0.0.1"
    port: int = 9292
    api_key: str = ""
    backend: str = "auto"
    serial_device: str = ""
    baud: int = 115200
    timeout: float = 30.0
    allow_anon: bool = False
    mmcli: str = "mmcli"
    dbus_send: str = "dbus-send"

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> "Settings":
        e = os.environ if env is None else env

        def get(*names: str, default: str = "") -> str:
            for name in names:
                value = e.get(name)
                if value:
                    return value
            return default

        backend = (get("SMSGATEWAY_BACKEND", default="auto") or "auto").strip().lower()
        if backend not in BACKENDS:
            backend = "auto"

        return cls(
            host=get("SMSGATEWAY_HOST", default="127.0.0.1").strip(),
            port=_int(get("SMSGATEWAY_PORT", default="9292"), 9292),
            # The service can share the key the Zeus/Capstone clients already use.
            api_key=get("SMSGATEWAY_API_KEY", "OPENSMS_API_KEY").strip(),
            backend=backend,
            serial_device=get("SMSGATEWAY_SERIAL_DEVICE").strip(),
            baud=_int(get("SMSGATEWAY_BAUD", default="115200"), 115200),
            timeout=_float(get("SMSGATEWAY_TIMEOUT", default="30"), 30.0),
            allow_anon=_truthy(get("SMSGATEWAY_ALLOW_ANON")),
            mmcli=get("SMSGATEWAY_MMCLI", default="mmcli").strip(),
            dbus_send=get("SMSGATEWAY_DBUS_SEND", default="dbus-send").strip(),
        )

    def with_overrides(self, **values: object) -> "Settings":
        clean = {k: v for k, v in values.items() if v is not None and v != ""}
        return replace(self, **clean) if clean else self
