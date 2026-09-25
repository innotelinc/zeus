#!/usr/bin/env python3
"""pbx/d7_assert.py — D7's three claims about the live stack, as a check.

D7 is "one observability spine". It is three assertions, and every one of them
has already been false on this estate without anything raising its voice:

  * **The call is recorded.** CDR/CEL was dead for nine days. `odbc.ini` named a
    `MySQL` driver that is not installed — the connector registers as
    `MariaDB Unicode` — so on every hangup Asterisk logged

        res_odbc.c: Error SQLConnect=-1 errno=2002 ... Can't connect to local server
        cdr_adaptive_odbc.c: No such connection 'asteriskcdrdb' ... Check res_odbc.conf

    and wrote nothing. The PBX looked healthy from every other angle: trunks up,
    extensions registered, calls answered. Only the *absence* of rows said
    otherwise, and nothing was watching for an absence.

  * **The agent is on the PBX.** Dograh registers as an ARI application
    (`dograh_<suffix>`). An engine that is running but has not registered looks
    exactly like one that is answering calls — until a call arrives and nobody
    picks up.

  * **Reasoning comes from one gateway.** The pipeline asks the estate gateway,
    never a cloud API directly. A gateway that 502s a model returns an HTML
    *page*, so
    the pipeline dies on its first turn with nothing naming the cause (the
    symptom was "Gateway responded 502", discovered from a call, not a check).
    The voicemail summary path asks the same gateway on its **own** model pin
    (`VOICEMAIL_SUMMARY_MODEL`), so both pins are asserted here: a route that
    has cooled down is invisible until it is the only one a feature has.

`odbc show` proves the CDR path is *wired*; only a call proves it *writes*. So
the CDR check can make one: `--call` originates a Local channel at `12@default`,
which matches FreePBX's `_X.` catch-all, plays the voicemail goodbye prompt and
hangs up. Nothing leaves the box — no trunk, no phone, no agent — and a session
that completes leaves its rows behind. Two of them, in fact: a Local channel is
a pair and each half is its own CDR, so the assertion is "at least one new row
appeared", which is precisely the property that was broken.

Exit status — three states, because "cannot check" is not "checked and fine":

    0 — every requested assertion holds
    1 — an assertion is false
    2 — nothing could run (no docker, no PBX container, no .env): not evidence

Run:
    python3 pbx/d7_assert.py --live
    python3 pbx/d7_assert.py --live --call          # also proves CDR writes
    python3 pbx/d7_assert.py --live --only gateway

Unit tests own the parsing and the decision table (pbx/tests/test_d7_assert.py);
this file owns talking to the stack.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "scripts"))
from env_file import read_key  # noqa: E402

# Capstone's app is `dograh_<suffix>`, and the suffix is not stable: it is the
# container identity, so it changes on recreate. Only the prefix is meaningful.
AGENT_APP_PREFIX = "dograh_"
# The DSN res_odbc.conf registers for CDR. Its *name* is the thing the log named
# when this broke, so it is the thing the check looks for.
CDR_DSN = "asteriskcdrdb"
# A Local channel into FreePBX's `_X.` catch-all in [default]: it answers, plays
# the goodbye prompt, and hangs up. Deliberately not an extension, a DID, or an
# inbound route — a probe that could reach a real agent is not a probe.
CALL_TARGET = "12@default"
GATEWAY_BASE_KEY = "OMNIROUTE_BASE_URL"
# The estate's canonical gateway door, used when the env names no override.
GATEWAY_BASE_DEFAULT = "http://192.168.1.46:20129/v1"
GATEWAY_TOKEN_KEY = "OMNIROUTE_API_KEY"
# The voicemail summary path pins its model in the portal's env (see
# src/app/api/voicemail/summary/route.ts). It is the only model pin this repo
# still holds: the call path belongs to Dograh, which owns its own config on the
# voice host and which this check cannot see. An unlisted pin is a feature that
# answers 502 and says nothing until someone clicks the ✨ button.
GATEWAY_SUMMARY_MODEL_KEY = "VOICEMAIL_SUMMARY_MODEL"
# What a missing model costs. Named because "does not offer the configured
# model" does not say which feature just went dark.
SUMMARY_CONSEQUENCE = "voicemail summaries would stop answering"

CHECKS = ("ari", "cdr", "gateway")


# ── findings ────────────────────────────────────────────────────────────────
@dataclass(frozen=True)
class Finding:
    """One assertion. `ok is None` means it could not be evaluated here."""

    ok: bool | None
    detail: str


@dataclass(frozen=True)
class Watermark:
    """How many CDR rows exist and how recent the newest one is."""

    rows: int
    newest: str


# ── parsing (pure, so the shapes can be tested without a PBX) ───────────────
def parse_ari_apps(text: str) -> set[str]:
    """ARI applications from `asterisk -rx "ari show apps"`.

    The command prints a title row and a rule before the names, and answers
    "No applications registered." when there are none. An ARI app name cannot
    contain whitespace, so the first token of a line is the name.
    """
    apps: set[str] = set()
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or set(stripped) <= set("=-"):
            continue
        if stripped.lower().startswith("application name"):
            continue
        if "no applications" in stripped.lower():
            continue
        apps.add(stripped.split()[0])
    return apps


def parse_odbc(text: str) -> dict[str, dict]:
    """DSNs from `asterisk -rx "odbc show"` → {name: {dsn, connections}}."""
    dsns: dict[str, dict] = {}
    current: str | None = None
    for line in text.splitlines():
        match = re.match(r"\s*Name:\s*(\S+)", line)
        if match:
            current = match.group(1)
            dsns[current] = {"dsn": "", "connections": 0}
            continue
        if current is None:
            continue
        match = re.match(r"\s*DSN:\s*(\S+)", line)
        if match:
            dsns[current]["dsn"] = match.group(1)
            continue
        match = re.match(r"\s*Number of active connections:\s*(\d+)", line)
        if match:
            dsns[current]["connections"] = int(match.group(1))
    return dsns


def parse_models(payload: object) -> set[str]:
    """Model ids from an OpenAI-shaped catalogue.

    The estate gateway answers `{"object": "list", "data": [{"id": ...}]}`;
    a bare list of ids or of objects is accepted too, since a check that can
    only parse one shape reports a bad shape as a missing model.
    """
    ids: set[str] = set()

    def take(item: object) -> None:
        if isinstance(item, str):
            ids.add(item)
        elif isinstance(item, dict) and isinstance(item.get("id"), str):
            ids.add(item["id"])

    if isinstance(payload, dict):
        for key in ("data", "models"):
            value = payload.get(key)
            if isinstance(value, list):
                for item in value:
                    take(item)
    elif isinstance(payload, list):
        for item in payload:
            take(item)
    return ids


def parse_watermark(text: str) -> Watermark | None:
    """The `count(*), max(calldate)` row the CDR query returns."""
    for line in text.splitlines():
        # Not line.strip(): an empty table answers "0\t" and the trailing tab is
        # the second column, so stripping it first loses the field and the row
        # parses as an error instead of as "no rows yet".
        parts = line.rstrip("\n").split("\t")
        if not parts[0].strip().isdigit():
            continue
        return Watermark(rows=int(parts[0]), newest=parts[1].strip() if len(parts) > 1 else "")
    return None


# ── verdicts (pure) ─────────────────────────────────────────────────────────
def verdict_ari(
    apps: set[str],
    agent_prefix: str = AGENT_APP_PREFIX,
) -> list[Finding]:
    listed = ", ".join(sorted(apps)) or "none"
    agents = sorted(app for app in apps if app.startswith(agent_prefix))
    return [
        Finding(
            bool(agents),
            f"Dograh's Stasis app is registered ({', '.join(agents)})"
            if agents
            else f"no {agent_prefix}* Stasis app is registered (registered: {listed}) "
            f"— nothing is listening for a call, so an inbound DID would go unanswered",
        ),
    ]


def verdict_odbc(dsns: dict[str, dict], name: str = CDR_DSN) -> list[Finding]:
    entry = dsns.get(name)
    if entry is None:
        listed = ", ".join(sorted(dsns)) or "none"
        return [
            Finding(
                False,
                f"no ODBC DSN named {name} is registered (registered: {listed}) — "
                f"res_odbc.conf/cdr_adaptive_odbc.conf name a connection Asterisk "
                f"does not have, which is how CDR silently wrote nothing for nine days",
            )
        ]
    connections = int(entry.get("connections", 0))
    return [
        Finding(
            connections >= 1,
            f"ODBC DSN {name} (dsn {entry.get('dsn') or '?'}) has {connections} active "
            f"connection(s)"
            if connections >= 1
            else f"ODBC DSN {name} exists (dsn {entry.get('dsn') or '?'}) but has no active "
            f"connection — writes will fail until it connects",
        )
    ]


def verdict_cdr(before: Watermark, after: Watermark) -> list[Finding]:
    grew = after.rows > before.rows and after.newest != before.newest
    return [
        Finding(
            grew,
            f"a test call left {after.rows - before.rows} new CDR row(s); newest is now "
            f"{after.newest} (was {before.newest})"
            if grew
            else f"the test call left NO new CDR row ({before.rows} rows, newest "
            f"{before.newest} — unchanged) — CDR is not being written",
        )
    ]


def verdict_gateway(
    status: int,
    payload: object,
    url: str,
    *,
    summary_model: str = "",
) -> list[Finding]:
    """One finding per configured pin — today that is the summary path only.

    The summary pin is asserted when it is configured; an unset one falls back
    to `OLLAMA_MODEL`, which this check cannot see.
    """
    if status != 200:
        return [
            Finding(
                False,
                f"the gateway answered HTTP {status} for {url}/models — a non-200 here is "
                f"what the engine reports as an unusable gateway on the first turn",
            )
        ]
    ids = parse_models(payload)
    if not ids:
        return [Finding(False, f"the gateway answered 200 for {url}/models but listed no models")]

    wanted: list[tuple[str, str]] = []
    if summary_model:
        wanted.append((summary_model, SUMMARY_CONSEQUENCE))
    if not wanted:
        return [Finding(True, f"the gateway answered 200 for {url}/models with {len(ids)} model(s)")]

    return [
        Finding(
            pinned in ids,
            f"the gateway lists the configured model {pinned} ({len(ids)} model(s) offered)"
            if pinned in ids
            else f"the gateway answered 200 but does not offer the configured model {pinned} "
            f"({len(ids)} model(s) offered) — {consequence}",
        )
        for pinned, consequence in wanted
    ]


# ── the live stack ──────────────────────────────────────────────────────────
def _run(cmd: list[str], timeout: float = 30.0) -> tuple[int, str]:
    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout, check=False
        )
    except FileNotFoundError:
        return 127, f"{cmd[0]}: not found"
    except subprocess.TimeoutExpired:
        return 124, f"{' '.join(cmd)}: timed out after {timeout:g}s"
    return proc.returncode, (proc.stdout or "") + (proc.stderr or "")


def find_pbx_container(explicit: str = "") -> str:
    """The FreePBX container, or "" when there is not exactly one to use.

    An explicit name wins outright: guessing past a typo would silently check
    some other host's PBX and report it as this one's.
    """
    if explicit:
        return explicit
    code, out = _run(
        [
            "docker",
            "ps",
            "--filter",
            "label=com.docker.compose.service=freepbx",
            "--format",
            "{{.Names}}",
        ]
    )
    if code != 0:
        return ""
    names = [n for n in out.split() if n]
    if len(names) == 1:
        return names[0]
    return "zeus-freepbx" if not names else ""


def asterisk(container: str, command: str, timeout: float = 30.0) -> tuple[int, str]:
    return _run(["docker", "exec", container, "asterisk", "-rx", command], timeout)


def cdr_watermark(container: str) -> Watermark | None:
    code, out = _run(
        [
            "docker",
            "exec",
            container,
            "mysql",
            "-N",
            "-B",
            CDR_DSN,
            "-e",
            "select count(*), ifnull(max(calldate), '') from cdr",
        ]
    )
    if code != 0:
        return None
    return parse_watermark(out)


def originate(container: str, target: str) -> tuple[bool, str]:
    code, out = asterisk(
        container, f"channel originate Local/{target} application Wait 1"
    )
    return code == 0, out.strip()


def check_cdr(container: str, do_call: bool, wait: float) -> list[Finding]:
    before = cdr_watermark(container)
    if before is None:
        return [Finding(None, f"cannot read the CDR table in {container}")]
    findings = [Finding(True, f"CDR holds {before.rows} row(s); newest is {before.newest}")]
    if not do_call:
        findings.append(
            Finding(
                None,
                "no test call made — pass --call to prove CDR actually writes "
                "(a wired-but-broken backend looks identical without one)",
            )
        )
        return findings

    placed, output = originate(container, CALL_TARGET)
    if not placed:
        findings.append(Finding(False, f"could not originate the test call: {output}"))
        return findings

    deadline = time.monotonic() + wait
    after = before
    while time.monotonic() < deadline:
        time.sleep(2)
        current = cdr_watermark(container)
        if current is None:
            break
        after = current
        if after.rows > before.rows and after.newest != before.newest:
            break
    findings.extend(verdict_cdr(before, after))
    return findings


def check_ari(container: str) -> list[Finding]:
    code, out = asterisk(container, "ari show apps")
    if code != 0:
        return [Finding(None, f"cannot ask {container} for its ARI apps: {out.strip()}")]
    return verdict_ari(parse_ari_apps(out))


def check_odbc(container: str) -> list[Finding]:
    code, out = asterisk(container, "odbc show")
    if code != 0:
        return [Finding(None, f"cannot ask {container} for its ODBC state: {out.strip()}")]
    return verdict_odbc(parse_odbc(out))


def probe_gateway(url: str, token: str, timeout: float = 10.0) -> tuple[int, object]:
    """GET {url}/models. Returns (status, payload); payload is None if unparsable.

    The catalogue is public on this gateway while completions are not, so a
    401/403 with the token is retried without it: an unauthenticated 200 still
    answers the question this check asks (does the gateway serve this model).
    """
    endpoint = url.rstrip("/") + "/models"

    def fetch(with_token: bool) -> tuple[int, bytes]:
        request = urllib.request.Request(endpoint)
        if with_token and token:
            request.add_header("Authorization", f"Bearer {token}")
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return response.status, response.read()
        except urllib.error.HTTPError as exc:
            return exc.code, b""
        except Exception:  # noqa: BLE001 — unreachable host, DNS, TLS: all "no answer"
            return 0, b""

    status, body = fetch(bool(token))
    if status in (401, 403) and token:
        status, body = fetch(False)
    if not body:
        return status, None
    try:
        return status, json.loads(body)
    except json.JSONDecodeError:
        return status, None


def check_gateway(url: str, token: str, summary_model: str = "") -> list[Finding]:
    status, payload = probe_gateway(url, token)
    if status == 0:
        return [Finding(False, f"the gateway did not answer at {url}/models")]
    if status == 200 and payload is None:
        return [
            Finding(
                False,
                f"the gateway answered 200 for {url}/models with a body this check cannot "
                f"parse — a proxy or error page, not the model catalogue",
            )
        ]
    return verdict_gateway(status, payload, url.rstrip("/"), summary_model=summary_model)


# ── CLI ─────────────────────────────────────────────────────────────────────
def _emit(finding: Finding, quiet: bool) -> None:
    if quiet:
        return
    marker = "[ok]" if finding.ok else ("[!!]" if finding.ok is False else "[--]")
    print(f"{marker} {finding.detail}")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        description="D7 assertions against the live stack",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__.split("Run:")[-1].strip("\n"),
    )
    parser.add_argument("--live", action="store_true", help="run against the stack")
    parser.add_argument("--only", action="append", default=[], choices=list(CHECKS))
    parser.add_argument("--pbx", default="", help="FreePBX container (default: autodetect)")
    parser.add_argument("--env", default=os.path.join(ROOT, ".env"))
    parser.add_argument("--call", action="store_true", help="place the CDR test call")
    parser.add_argument("--wait", type=float, default=20.0, help="seconds to wait for the CDR row")
    parser.add_argument("--gateway-url", default="",
                        help="override OMNIROUTE_BASE_URL")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args(argv[1:])

    if not args.live:
        print(
            "d7-assert: --live is required for the stack checks; the decision logic is "
            "covered by pbx/tests/test_d7_assert.py",
            file=sys.stderr,
        )
        return 2

    wanted = args.only or list(CHECKS)
    # Every path that cannot evaluate something appends a Finding(ok=None), so
    # the un-evaluated set is read back off the findings at the end rather than
    # tracked in a parallel list. A second list is exactly how the exit-2
    # summary came to say "no checks selected" while reporting a real reason
    # above it: one path forgot to append to both.
    findings: list[Finding] = []

    if "ari" in wanted or "cdr" in wanted:
        container = find_pbx_container(args.pbx)
        if not container:
            reason = (
                f"no such container: {args.pbx}"
                if args.pbx
                else "no FreePBX container found (docker absent, or none running)"
            )
            for name in ("ari", "cdr"):
                if name in wanted:
                    findings.append(Finding(None, f"{name}: {reason}"))
        else:
            if "ari" in wanted:
                findings.extend(check_ari(container))
            if "cdr" in wanted:
                findings.extend(check_odbc(container))
                findings.extend(check_cdr(container, args.call, args.wait))

    if "gateway" in wanted:
        text = ""
        if os.path.exists(args.env):
            with open(args.env, "r", encoding="utf-8") as handle:
                text = handle.read()
        if not text:
            # A missing .env is not "no gateway configured": on the voice host it
            # is the deployment being absent, and probing the default door
            # instead would report a green gateway over a host with no config.
            findings.append(Finding(None, f"gateway: no {args.env}"))
        else:
            base = args.gateway_url or read_key(text, GATEWAY_BASE_KEY) or GATEWAY_BASE_DEFAULT
            token = read_key(text, GATEWAY_TOKEN_KEY) or ""
            summary_model = read_key(text, GATEWAY_SUMMARY_MODEL_KEY) or ""
            findings.extend(check_gateway(base, token, summary_model=summary_model))

    for finding in findings:
        _emit(finding, args.quiet)

    failures = [f for f in findings if f.ok is False]
    evaluated = [f for f in findings if f.ok is not None]
    unresolved = [f.detail for f in findings if f.ok is None]
    if failures:
        print(f"d7-assert: FAIL — {len(failures)} assertion(s) do not hold", file=sys.stderr)
        return 1
    if not evaluated:
        print(
            "d7-assert: cannot run here — nothing was evaluated "
            f"({'; '.join(unresolved) or 'no checks selected'})",
            file=sys.stderr,
        )
        return 2
    # Say what was NOT evaluated. "PASS" over a skipped check is how a green
    # smoke run stops meaning anything.
    caveat = f" (not evaluated: {'; '.join(unresolved)})" if unresolved else ""
    print(f"d7-assert: PASS — {len(evaluated)} assertion(s) hold{caveat}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
