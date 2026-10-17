# smsgateway — OpenSMS-compatible SMS API for a local modem

`SMSGATEWAY` is the Linux half of what the OpenSMS Android app does: it exposes

```
POST /sms/    Authorization: Bearer <key>
              {"number": "+15551234567", "text": "hello"}
              -> 200 {"stat": true}
              -> 200 {"stat": false, "error": "no SIM"}

GET  /health   no auth — backend, SIM, signal, operator
GET  /         no auth — service info
```

so Zeus (`OPENSMS_URL`), Capstone (`scripts/opensms_client.py`) and the Android
app are interchangeable endpoints. The transport underneath is a USB LTE modem,
an AT-capable phone, or an RS-232 modem instead of Android's `SmsManager`.

No third-party packages: Python 3.10+ standard library only.

## Install

```bash
scripts/install-smsgateway.sh --apt        # installs ModemManager, dbus, usb-modeswitch
```

The script writes `/etc/zeus-smsgateway.env` (0600) with a generated key,
installs `systemd/zeus-smsgateway.service` (or starts the process with `nohup`
where systemd is not PID 1), and writes `OPENSMS_URL` / `OPENSMS_API_KEY` into
this repo's `.env` and `../capstone/.env`.

Restart the consumers afterwards:

```bash
scripts/compose-vault.sh -f docker-compose.full.yml up -d --no-deps portal
cd ../capstone && docker compose up -d --force-recreate dashboard-api
```

## Plug in the phone / modem

1. Plug the device in and check what Linux sees:

   ```bash
   lsusb
   mmcli -L                 # a ModemManager-managed modem appears here
   ls /dev/ttyUSB* /dev/ttyACM*
   ```

2. If ModemManager sees it, nothing else is needed — `auto` picks it.

3. If it only exposes an AT port, point the gateway at it:

   ```bash
   SMSGATEWAY_BACKEND=serial
   SMSGATEWAY_SERIAL_DEVICE=/dev/serial/by-id/usb-...
   ```

4. Check it end to end:

   ```bash
   python3 -m smsgateway --check
   python3 -m smsgateway --send +15551234567 "test from zeus"
   curl -s localhost:9292/health | python3 -m json.tool
   ```

The gateway runs as a host service on purpose: it owns `/dev/ttyUSB*` and the
host's ModemManager D-Bus socket. Containers reach it on the bridge address
(`http://172.17.0.1:9292`); the portal runs with `network_mode: host`, so it
uses `http://127.0.0.1:9292`.

### Which devices work

| Device | Path | Notes |
| --- | --- | --- |
| USB LTE stick / dongle (Huawei, Quectel, Sierra…) | ModemManager → `mmcli` + `dbus-send` | Works out of the box; `usb_modeswitch` flips the storage-mode device into modem mode |
| Modem with only a serial AT port | `SMSGATEWAY_BACKEND=serial` | Needs the `dialout` group |
| Android phone over USB | ModemManager, *if* the phone exposes a modem composition | Most phones only expose MTP/ADB — the stock OpenSMS app (Android gateway) is the supported path for a phone |
| Android phone over USB tethering | not this gateway | Tethering gives a network interface, not an AT port |

An Android phone that only supports MTP/ADB will not appear in `mmcli -L`; keep
using the OpenSMS app on that phone, or use a USB LTE stick. The API is the
same either way, so nothing else changes.

## Configuration

`/etc/zeus-smsgateway.env` (the service's `EnvironmentFile`):

| Variable | Default | Meaning |
| --- | --- | --- |
| `SMSGATEWAY_HOST` | `127.0.0.1` | bind address; the installer sets `0.0.0.0` so containers can reach it |
| `SMSGATEWAY_PORT` | `9292` | the port the clients already expect |
| `SMSGATEWAY_API_KEY` | falls back to `OPENSMS_API_KEY` | Bearer key; the service refuses to start without one |
| `SMSGATEWAY_ALLOW_ANON` | `0` | testing only — disables auth |
| `SMSGATEWAY_BACKEND` | `auto` | `auto`, `modemmanager`, `serial`, `mock` |
| `SMSGATEWAY_SERIAL_DEVICE` | auto-detect | AT port for the serial backend |
| `SMSGATEWAY_BAUD` | `115200` | serial baud |
| `SMSGATEWAY_TIMEOUT` | `30` | per-command timeout (seconds) |
| `SMSGATEWAY_MMCLI`, `SMSGATEWAY_DBUS_SEND` | `mmcli`, `dbus-send` | helper paths |

`mock` records messages in memory and is never chosen by `auto`; it exists for
tests and demos.

## Backends

- **modemmanager** — discovery/status through `mmcli`; the message is created
  over D-Bus with `dbus-send` so the body is one string argument (commas and
  quotes survive; `mmcli --messaging-create-sms` cuts the text at the first
  comma). Falls back to `mmcli` when `dbus-send` is missing.
- **serial** — `AT+CMGF=1` text mode, `AT+CSCS="GSM"` for ASCII and UCS2 for
  anything else. `flock`s the device, so two sends cannot interleave.
- **auto** — ModemManager when it reports a modem, then an `AT` probe on
  `/dev/ttyUSB*`, `/dev/ttyACM*`, `/dev/ttyAMA*`, `/dev/serial/by-id/*`.

A failed send answers `200 {"stat": false, "error": "…"}` — deliberately the
same shape OpenSMS uses, so both clients show the modem's real reason
(`no SIM`, `no signal`, `cannot open /dev/ttyUSB2`) instead of a generic error.

## Tests

```bash
python3 -m unittest discover -s smsgateway/tests -t . -v
```

26 tests, no hardware: the serial backend talks to a PTY that behaves like an
AT modem, and the ModemManager backend runs against fake `mmcli`/`dbus-send`
programs (including the comma-in-body case).

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `/health` returns 503 `no SMS modem found` | `mmcli -L`, `lsusb`, `journalctl -u zeus-smsgateway` |
| `cannot open /dev/ttyUSB2` | the service user needs the `dialout` group |
| `modem timed out waiting for OK` | wrong port (try `/dev/ttyUSB2` for Quectel), or the port is held by ModemManager — set `SMSGATEWAY_BACKEND=serial` after `systemctl stop ModemManager`, or use the modemmanager backend |
| `+CMS ERROR: 500` | no SIM or no network registration (`mmcli -m 0`) |
| `401` from the gateway | `SMSGATEWAY_API_KEY` differs from the client's `OPENSMS_API_KEY`; re-run the installer |
| sends work but Zeus still hides *Local* | the portal was not recreated after `.env` changed |
