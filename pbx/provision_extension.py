#!/usr/bin/env python3
"""pbx/provision_extension.py — the one owner of extension/device creation.

D6 of docs/voice-convergence.md: today two products create PBX objects by
writing tables directly, with no single owner, no idempotency and no integrity
check — and that is how `(1,'maxchans')`, a MySQL `1062` on `pjsip`'s primary
key, came to break an unrelated feature in a GUI dialog nobody could act on.
This tool is the owner for the *extension* half of that, and it is deliberately
built in this order:

  * **check-then-create.** Every judgement reads the PBX first and says what it
    found. A name that exists is idempotent; a name that half-exists is a refusal
    that names the half.
  * **a preflight that refuses on an inconsistent PBX.** An extension is four
    things in FreePBX — a user row, a device row, a technology row (`sip`/
    `pjsip`), and leftover AstDB state under `AMPUSER/<ext>` — and creating over
    any of them without knowing is how a phone inherits someone else's call
    forwarding. All four are measured, and each has its own refusal.
  * **FreePBX's own API, not our INSERT.** The create is
    `FreePBX::Core()->addUser()` / `addDevice()` in the container (the same
    sequence `Core::doConfigPageInit` runs, and the same technique the retired
    `pbx/ava_routes.py` used for a missing route), so the sixty-odd columns this
    tool does not model are the framework's to fill. Where the framework provably
    cannot do it, this file says so rather than guessing — see *What this does
    not do* below.

## What it does not do

Three things in D6 belong to somebody else, and duplicating them here would
re-create the defect D6 exists to remove. They are *reported*, by name, so one
command still answers the whole question:

  * **Inbound routes** — nobody in this repo writes them: which workflow a DID
    reaches is a portal decision and the row is FreePBX's. `pbx/dograh_routes.py`
    judges them (P1), read-only.
  * **The account's voice mapping** (`voice_agents`, `voice_bindings`) — the
    portal API owns those (`PUT /api/voice/agent-mapping`, one transaction).
  * **The WebRTC endpoint** — its owner is DECIDED
    (docs/voice-convergence.md §11.5): FreePBX owns the endpoint and the
    portal extends it from `pjsip.endpoint_custom_post.conf`, appending
    `[<ext>](+)` so the softphone registers as the object the PBX routes to.
    This tool creates the framework's endpoint and never the portal's settings;
    `--webrtc` measures which of the two shapes exists on the box, so a
    pre-decision fragment is found rather than assumed absent.

The create call is the one part of this file that needs the live box to confirm:
the judgement layer is unit-tested (`pbx/tests/test_provision_extension.py`), and
a create is verified by re-reading the PBX afterwards rather than by trusting the
call's exit status.

## Reading and writing

    # judge, write nothing. Exit 0 in sync, 1 an apply converges it, 3 a person.
    python3 pbx/provision_extension.py --intent accounts.json --check

    # off-host: judge an intent against a measurement taken earlier
    python3 pbx/provision_extension.py --intent accounts.json \\
        --observed-json /tmp/observed.json --check

    # take the measurement, with the raw facts on stdout
    python3 pbx/provision_extension.py --intent accounts.json --check --json

    # create, after taking the phase's pre-state (pbx/p0-snapshot.sh)
    python3 pbx/provision_extension.py --intent accounts.json --apply \\
        --revert-out /root/zeus-ext-revert.php

The way back is FreePBX's own `delUser`/`delDevice`, not a DELETE: a raw DELETE
leaves the `sip`/`pjsip` rows and the AstDB state behind, which is exactly the
orphan this tool's preflight refuses to create over.

        docker exec -i zeus-freepbx php < /root/zeus-ext-revert.php
        docker exec zeus-freepbx fwconsole reload

This tool does not reload: FreePBX builds its dialplan and device config from
these rows, so the change is live only after `fwconsole reload`, and the reload
stays where the rest of the convergence already does it.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from dataclasses import asdict, dataclass, field

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import pbx_db as routes  # noqa: E402  (the shared container/MySQL plumbing)
import pjsip_owner_check as owner  # noqa: E402

# A FreePBX extension number: digits only. The GUI accepts more (it will build a
# `_2XX` route), but a *user/device* is an extension you dial, and every product
# on this box assumes digits — the accounts context, the softphone, the portal's
# own validation. Refusing here is the difference between a named gap and a
# device that exists and cannot be dialled.
EXT_RE = re.compile(r"^[0-9]{2,8}$")

# The technology rows a device leaves behind, per FreePBX's own schema. Both are
# keyed by `id`, which is the extension number.
TECH_TABLES = ("sip", "pjsip")

# AstDB is where the *state* of an extension lives — call forwarding, call
# waiting, the device mapping — and nothing deletes it when the rows do. A number
# recycled onto a stale `AMPUSER` subtree inherits that state silently, which is
# why `core_users_cleanastdb()` exists in FreePBX itself.
ASTDB_FAMILY = "AMPUSER"

# The create, run inside the container against the framework's own API. The
# sequence is `Core::doConfigPageInit`'s, including the cleanup: `addUser` failing
# after `addDevice` succeeded would otherwise leave exactly the half-created
# extension the preflight refuses — so the device is deleted again, by the
# framework, before the message is reported.
#
# Device first, then user: that is the order the framework uses, and `addUser`
# is the call that can fail on a name already in use.
#
# `__TECH__` is substituted below rather than formatted: the script is PHP, so its
# braces are control flow.
CREATE_SCRIPT = """<?php
require '/etc/freepbx.conf';
$rows = json_decode(getenv('ZEUS_EXT_INTENTS') ?: '[]', true);
$tech = getenv('ZEUS_EXT_TECH') ?: 'pjsip';
$core = FreePBX::Core();
$out = array();
foreach ($rows as $row) {
    $ext  = $row['extension'];
    $name = $row['name'];
    // Re-read before writing: a concurrent GUI create becomes a no-op rather
    // than a duplicate-id error, which is the one thing this tool must not
    // produce on a live switch.
    $have_user   = !empty($core->getUser($ext));
    $have_device = !empty($core->getDevice($ext));
    if ($have_user && $have_device) {
        $out[] = array('extension' => $ext, 'result' => 'exists');
        continue;
    }
    if ($have_user || $have_device) {
        $out[] = array(
            'extension' => $ext, 'result' => 'partial',
            'message' => $have_user ? 'a user object exists without a device'
                                   : 'a device exists without a user object',
        );
        continue;
    }
    try {
        $device = $core->generateDefaultDeviceSettings($tech, $ext, $name);
        $core->addDevice($ext, $tech, $device);
        $user = $core->generateDefaultUserSettings($ext, $name);
        if (!$core->addUser($ext, $user)) {
            $core->delDevice($ext, false);
            $out[] = array('extension' => $ext, 'result' => 'failed',
                           'message' => 'the framework refused the user object');
            continue;
        }
    } catch (\\Exception $e) {
        try { $core->delDevice($ext, false); } catch (\\Exception $ignored) {}
        $out[] = array('extension' => $ext, 'result' => 'failed',
                       'message' => $e->getMessage());
        continue;
    }
    $out[] = array('extension' => $ext, 'result' => 'created');
}
echo json_encode($out), PHP_EOL;
"""


class IntentError(RuntimeError):
    """An intent file that cannot be judged."""


# ── the intent (pure) ───────────────────────────────────────────────────────
@dataclass(frozen=True)
class Intent:
    """One extension the platform intends to exist.

    `email` and `account` are carried but not written: the portal owns the
    account, and voicemail-to-email is the Voicemail module's field, not a column
    of `users`. They are here so the intent is the *account's* whole voice
    footprint rather than a bag of PBX fields — and so a later leg can be checked
    against the same document.
    """

    extension: str
    name: str
    email: str = ""
    account: str = ""


def parse_intents(text: str) -> list[Intent]:
    """Validate the intent document.

    Refuses rather than repairs: an extension that is not digits, a missing name,
    or the same extension twice are all mistakes that would otherwise be
    discovered as a half-provisioned phone.
    """
    try:
        raw = json.loads(text)
    except ValueError as exc:
        raise IntentError(f"intent is not JSON: {exc}") from exc

    rows = raw.get("extensions") if isinstance(raw, dict) else raw
    if not isinstance(rows, list):
        raise IntentError(
            "intent must be {\"extensions\": [...]} or a list of extensions"
        )
    if not rows:
        raise IntentError(
            "the intent lists no extensions — refusing to judge an empty document "
            "(that is what a broken export looks like)"
        )

    intents: list[Intent] = []
    seen: dict[str, int] = {}
    for index, row in enumerate(rows, 1):
        if not isinstance(row, dict):
            raise IntentError(f"entry {index} is not an object")
        ext = str(row.get("extension", "")).strip()
        name = str(row.get("name", "")).strip()
        if not EXT_RE.match(ext):
            raise IntentError(
                f"entry {index}: extension {ext!r} is not 2-8 digits — a "
                "user/device is a number you dial, and every consumer here "
                "assumes digits"
            )
        if not name:
            raise IntentError(f"entry {index}: extension {ext} has no name")
        if ext in seen:
            raise IntentError(
                f"extension {ext} appears twice (entries {seen[ext]} and {index}) — "
                "one intent per number"
            )
        seen[ext] = index
        intents.append(
            Intent(
                extension=ext,
                name=name,
                email=str(row.get("email", "") or "").strip(),
                account=str(row.get("account", "") or "").strip(),
            )
        )
    return intents


# ── what the PBX has (pure) ─────────────────────────────────────────────────
@dataclass(frozen=True)
class Observed:
    """The PBX's state, as four sets and a module report.

    Kept as separate sets rather than one "exists" boolean because the *refusal*
    is the deliverable: `(1,'maxchans')` is unactionable, "the pjsip table has a
    row for 1001 but the users table does not" is a repair.
    """

    users: frozenset[str] = field(default_factory=frozenset)
    devices: frozenset[str] = field(default_factory=frozenset)
    sip_ids: frozenset[str] = field(default_factory=frozenset)
    pjsip_ids: frozenset[str] = field(default_factory=frozenset)
    astdb: frozenset[str] = field(default_factory=frozenset)
    endpoint_two_owner: frozenset[str] = field(default_factory=frozenset)
    modules_ok: bool = True
    modules_note: str = ""

    @classmethod
    def from_dict(cls, raw: dict) -> "Observed":
        def as_set(name: str) -> frozenset[str]:
            value = raw.get(name) or []
            if not isinstance(value, list):
                raise IntentError(f"observed.{name} must be a list")
            return frozenset(str(v) for v in value)

        return cls(
            users=as_set("users"),
            devices=as_set("devices"),
            sip_ids=as_set("sip_ids"),
            pjsip_ids=as_set("pjsip_ids"),
            astdb=as_set("astdb"),
            endpoint_two_owner=as_set("endpoint_two_owner"),
            modules_ok=bool(raw.get("modules_ok", True)),
            modules_note=str(raw.get("modules_note", "") or ""),
        )

    def to_dict(self) -> dict:
        return {
            "users": sorted(self.users),
            "devices": sorted(self.devices),
            "sip_ids": sorted(self.sip_ids),
            "pjsip_ids": sorted(self.pjsip_ids),
            "astdb": sorted(self.astdb),
            "endpoint_two_owner": sorted(self.endpoint_two_owner),
            "modules_ok": self.modules_ok,
            "modules_note": self.modules_note,
        }


@dataclass(frozen=True)
class Refusal:
    """One intent this tool will not write, and the repair that clears it.

    `clearable` is the whole 1-versus-3 distinction, applied per intent: a state
    an *apply* converges (nothing today) versus one only a person can. Today every
    refusal here is a person's, because every one of them is state this tool must
    not delete on its own — the caller's call-forwarding, or another product's
    endpoint.
    """

    intent: Intent
    reason: str
    repair: str


@dataclass
class Report:
    in_sync: list[Intent] = field(default_factory=list)
    create: list[Intent] = field(default_factory=list)
    refused: list[Refusal] = field(default_factory=list)

    def refused_extensions(self) -> list[str]:
        return [r.intent.extension for r in self.refused]


def judge(intents: list[Intent], observed: Observed) -> Report:
    """Check-then-create, per intent.

    Ordered so the most specific, most damaging state is named first: a
    two-owner endpoint (another product's object) before an orphaned technology
    row, before leftover state, before a half-created extension.
    """
    report = Report()
    if not observed.modules_ok:
        # Not a per-intent problem: on a PBX whose Core module is not usable,
        # nothing here can be created and re-running changes nothing.
        for intent in intents:
            report.refused.append(
                Refusal(
                    intent,
                    observed.modules_note or "the PBX's Core module is not usable",
                    "fix the FreePBX module state (`fwconsole ma list`, then "
                    "`fwconsole ma enable core`), then re-run",
                )
            )
        return report

    for intent in intents:
        ext = intent.extension
        has_user = ext in observed.users
        has_device = ext in observed.devices

        if has_user and has_device:
            report.in_sync.append(intent)
            continue

        if has_user or has_device:
            report.refused.append(
                Refusal(
                    intent,
                    "the PBX has "
                    + ("a user object but no device" if has_user else "a device but no user object"),
                    "finish or delete it in FreePBX (Applications → Extensions) — "
                    "creating here would leave two objects with one id",
                )
            )
            continue

        if ext in observed.endpoint_two_owner:
            report.refused.append(
                Refusal(
                    intent,
                    "the PJSIP endpoint for this extension already has two owners "
                    "(a duplicate object id in the load tree)",
                    "settle the endpoint's owner first — `python3 "
                    "pbx/pjsip_owner_check.py --live --extension " + ext + "` names "
                    "the two files (docs/voice-convergence.md §11.5)",
                )
            )
            continue

        orphan_tables = [
            name
            for name, ids in (("sip", observed.sip_ids), ("pjsip", observed.pjsip_ids))
            if ext in ids
        ]
        if orphan_tables:
            report.refused.append(
                Refusal(
                    intent,
                    "the " + "/".join(orphan_tables) + " table already has a row for "
                    "this extension while the users/devices tables do not — an "
                    "orphaned technology row",
                    "delete that row first (this is the `(1,'maxchans')` class: "
                    "creating over it collides, or silently shadows it)",
                )
            )
            continue

        if ext in observed.astdb:
            report.refused.append(
                Refusal(
                    intent,
                    f"AstDB still holds {ASTDB_FAMILY}/{ext} state (call forwarding, "
                    "call waiting or a device mapping from a deleted extension)",
                    f"clear it in Asterisk (`database deltree {ASTDB_FAMILY} {ext}`) — "
                    "a new phone on this number would otherwise inherit it",
                )
            )
            continue

        report.create.append(intent)

    return report


def parse_astdb(text: str, family: str = ASTDB_FAMILY) -> frozenset[str]:
    """The extensions with leftover state under one AstDB family.

    `asterisk -rx 'database show <family>'` prints one `/FAMILY/<key> : value`
    line per entry, and the key is `<ext>/<rest>` for an extension's own subtree.
    A key with no `/` is a family-level value, not an extension.
    """
    found: set[str] = set()
    prefix = f"/{family}/"
    for raw in text.splitlines():
        line = raw.strip()
        if not line.startswith(prefix):
            continue
        key = line[len(prefix) :].split(":", 1)[0].strip()
        ext = key.split("/", 1)[0].strip()
        if ext:
            found.add(ext)
    return frozenset(found)


def render_revert(created: list[Intent], container: str) -> str:
    """The way back: the framework's own delete, for each extension created.

    A PHP script rather than a plain `DELETE`, because a `DELETE` would leave
    the AstDB state this tool's preflight exists to protect: the
    delete has to be FreePBX's (`delUser`/`delDevice` clean the technologies,
    the voicemail box and the `AMPUSER` subtree).
    """
    import datetime

    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    extensions = ", ".join(f"'{i.extension}'" for i in created)
    return "\n".join(
        [
            "<?php",
            "// zeus provision_extension revert — written " + stamp + ", before "
            + str(len(created)) + " creation(s).",
            "//",
            "// Restores the PBX by deleting exactly the extensions this run",
            "// created. FreePBX's own delete, not a DELETE: delUser/delDevice",
            "// clear the sip/pjsip rows, the voicemail box and the AMPUSER",
            "// AstDB subtree, which a raw table delete leaves behind for the next",
            "// phone on this number to inherit.",
            "//",
            "//   docker exec -i " + container + " php < <this file>",
            "//   docker exec " + container + " fwconsole reload",
            "require '/etc/freepbx.conf';",
            "$core = FreePBX::Core();",
            "$extensions = array(" + extensions + ");",
            "foreach ($extensions as $ext) {",
            "    try { $core->delUser($ext, true); } catch (\\Exception $e) {",
            "        echo 'delUser ' . $ext . ': ' . $e->getMessage(), PHP_EOL;",
            "    }",
            "    try { $core->delDevice($ext, true); } catch (\\Exception $e) {",
            "        echo 'delDevice ' . $ext . ': ' . $e->getMessage(), PHP_EOL;",
            "    }",
            "    echo 'removed ' . $ext, PHP_EOL;",
            "}",
            "",
        ]
    )


# ── the live PBX ────────────────────────────────────────────────────────────
def _run(args: list[str], stdin: str | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(args, capture_output=True, text=True, input=stdin, timeout=120)


def table_exists_sql(container: str, table: str) -> bool:
    out = routes.mysql_exec(
        container,
        "SELECT table_name FROM information_schema.tables "
        f"WHERE table_schema='asterisk' AND table_name='{table}' LIMIT 1",
    ).strip()
    return bool(out)


def column_values(container: str, table: str, column: str) -> frozenset[str]:
    """One column of one table, as a set. Missing table is an empty set."""
    if not table_exists_sql(container, table):
        return frozenset()
    out = routes.mysql_exec(
        container, f"SELECT DISTINCT `{column}` FROM `{table}` WHERE `{column}` IS NOT NULL"
    )
    return frozenset(part.strip() for part in out.splitlines() if part.strip())


def read_module_state(container: str) -> tuple[bool, str]:
    """Is the PBX's Core module usable? Returns (ok, note).

    `fwconsole ma list` is the framework's own answer to "is this module
    installed and enabled", and D6 names it as the preflight's first question. It
    is slow (it boots the framework), which is why it is one call, not one per
    extension.
    """
    proc = _run(["docker", "exec", container, "fwconsole", "ma", "list"])
    if proc.returncode != 0:
        detail = proc.stderr.strip().splitlines()
        return False, (
            "`fwconsole ma list` did not answer in "
            f"{container}: {detail[-1] if detail else proc.returncode}"
        )
    text = proc.stdout
    # The list is a table with a `name`/`status` pair per module; `core` is the
    # one every extension lives in.
    match = re.search(r"^\s*core\s+\S+\s+(\S+)", text, re.MULTILINE)
    if not match:
        # Older/other renderings: fall back to "core appears on a line whose
        # status column says enabled".
        if re.search(r"^\s*core\b.*\benabled\b", text, re.MULTILINE):
            return True, ""
        return False, "`fwconsole ma list` did not report the core module"
    status = match.group(1).lower()
    if status.startswith("enabled"):
        return True, ""
    return False, f"the FreePBX core module is {status}, not enabled"


def read_endpoint_two_owner(container: str, intents: list[Intent]) -> frozenset[str]:
    """Extensions whose PJSIP endpoint has two owners (the §2.4 defect).

    Measured with the tool that already exists for it, rather than a second
    implementation: a definition is judged by whether Asterisk loads it, and a
    duplicate is the same (id, type) in two files.
    """
    raw, note = owner.read_container_config(container, owner.DEFAULT_DIR)
    if note or not raw:
        return frozenset()
    files = owner.load_files(raw)
    definitions = owner.definitions(files)
    wanted = {intent.extension for intent in intents}
    two_owner: set[str] = set()
    for (section_id, kind), places in definitions.items():
        if section_id in wanted and kind == "endpoint" and len(places) > 1:
            two_owner.add(section_id)
    return frozenset(two_owner)


def read_observed(container: str, intents: list[Intent]) -> Observed:
    """Measure the PBX. Raises `routes.RouteError` when it cannot be read."""
    modules_ok, modules_note = read_module_state(container)
    astdb_raw = _run(
        ["docker", "exec", container, "asterisk", "-rx", f"database show {ASTDB_FAMILY}"]
    )
    astdb = parse_astdb(astdb_raw.stdout if astdb_raw.returncode == 0 else "")
    return Observed(
        users=column_values(container, "users", "extension"),
        devices=column_values(container, "devices", "id"),
        sip_ids=column_values(container, "sip", "id"),
        pjsip_ids=column_values(container, "pjsip", "id"),
        astdb=astdb,
        endpoint_two_owner=read_endpoint_two_owner(container, intents),
        modules_ok=modules_ok,
        modules_note=modules_note,
    )


def create_extensions(container: str, intents: list[Intent], tech: str) -> list[dict]:
    """Create each extension through FreePBX's own API, and re-read the result.

    Raises `routes.RouteError` if the framework did not answer. A `failed` or
    `partial` row is returned to the caller rather than raised: it is a finding
    about one extension, and the others in the same run are still worth having.
    """
    proc = _run(
        [
            "docker", "exec", "-i",
            "-e", "ZEUS_EXT_INTENTS=" + json.dumps([asdict(i) for i in intents]),
            "-e", f"ZEUS_EXT_TECH={tech}",
            container, "php",
        ],
        stdin=CREATE_SCRIPT,
    )
    if proc.returncode != 0:
        detail = proc.stderr.strip().splitlines()
        raise routes.RouteError(
            f"FreePBX's API did not answer in {container}: "
            f"{detail[-1] if detail else proc.returncode}"
        )
    lines = [ln for ln in proc.stdout.strip().splitlines() if ln.strip()]
    try:
        return json.loads(lines[-1])
    except (ValueError, IndexError) as exc:
        raise routes.RouteError(
            f"could not read the create result from {container}: {exc}"
        ) from exc


def verify_created(container: str, extensions: list[str]) -> dict[str, bool]:
    """Re-read the PBX: did the objects actually appear?

    The create's own exit status is not evidence — the framework can return 0
    with a `failed` row, and a half-created extension (device without user) is
    the state this tool exists to prevent.
    """
    users = column_values(container, "users", "extension")
    devices = column_values(container, "devices", "id")
    return {ext: (ext in users and ext in devices) for ext in extensions}


# ── CLI ─────────────────────────────────────────────────────────────────────
def _describe(report: Report, stream, observed: Observed | None = None) -> None:
    for intent in report.in_sync:
        print(f"  ok         {intent.extension} ({intent.name}) exists", file=stream)
    for intent in report.create:
        print(f"  create     {intent.extension} ({intent.name})", file=stream)
    for refusal in report.refused:
        print(
            f"  refuse     {refusal.intent.extension}: {refusal.reason} "
            f"— {refusal.repair}",
            file=stream,
        )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Check and create the platform's FreePBX extensions.",
        epilog=(
            "Exit: 0 in sync (or applied) — 1 an apply converges it — 2 cannot "
            "tell (no PBX reachable / a table unreadable) — 3 only a person can "
            "(an orphaned row, leftover state, or two endpoint owners)."
        ),
    )
    parser.add_argument("--intent", required=True, help="the account intent (JSON)")
    parser.add_argument(
        "--observed-json",
        help="judge against a measurement taken earlier (offline; --check only)",
    )
    parser.add_argument("--container", help="FreePBX container (default: discover)")
    parser.add_argument(
        "--tech", default="pjsip", choices=["pjsip", "sip"], help="device technology"
    )
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--check", action="store_true", help="report, write nothing")
    action.add_argument("--apply", action="store_true", help="create what is missing")
    parser.add_argument(
        "--revert-out",
        default="/root/zeus-ext-revert.php",
        help="where to write the undo script before applying",
    )
    parser.add_argument("--json", action="store_true", help="print the raw measurement")
    parser.add_argument("--quiet", action="store_true", help="only the summary line")
    args = parser.parse_args(argv)

    if args.observed_json and args.apply:
        parser.error(
            "--observed-json is a measurement, not the PBX — an apply needs the "
            "live box (this is the same rule as --incoming-tsv in dograh_routes.py)"
        )

    try:
        with open(args.intent, "r", encoding="utf-8") as handle:
            intents = parse_intents(handle.read())
    except (OSError, IntentError) as exc:
        print(f"provision_extension: {exc}", file=sys.stderr)
        return 1

    # Offline judging, or the live PBX.
    if args.observed_json:
        try:
            with open(args.observed_json, "r", encoding="utf-8") as handle:
                observed = Observed.from_dict(json.load(handle))
        except (OSError, ValueError, IntentError) as exc:
            print(f"provision_extension: {args.observed_json}: {exc}", file=sys.stderr)
            return 2
        container = ""
    else:
        container = routes.resolve_container(
            args.container or os.environ.get("PBX_CONTAINER", ""),
            ("zeus-freepbx", "freepbx"),
        )
        if not container:
            print(
                "provision_extension: no FreePBX container running — cannot judge "
                "the extensions (pass --container, or --observed-json for an "
                "offline measurement)",
                file=sys.stderr,
            )
            return 2
        try:
            observed = read_observed(container, intents)
        except routes.RouteError as exc:
            print(f"provision_extension: {exc}", file=sys.stderr)
            return 2

    if args.json:
        print(json.dumps(observed.to_dict(), indent=2))

    report = judge(intents, observed)
    out = sys.stderr if args.quiet else sys.stdout
    _describe(report, out, observed)

    if args.check:
        summary = (
            f"provision_extension: {len(report.in_sync)} in sync, "
            f"{len(report.create)} to create, {len(report.refused)} refused"
        )
        if report.create:
            print(summary, file=sys.stderr)
            return 1
        if report.refused:
            print(summary, file=sys.stderr)
            return 3
        print(summary)
        return 0

    # --apply
    if not report.create:
        if report.refused:
            print(
                "provision_extension: nothing to create — the refusals above need "
                "a person (see each repair line)",
                file=sys.stderr,
            )
            return 1
        print(f"provision_extension: already in sync ({len(report.in_sync)} extension(s))")
        return 0

    # The undo is written FIRST and its failure is fatal: an apply with no way
    # back is the thing P0's snapshot discipline exists to prevent.
    try:
        with open(args.revert_out, "w", encoding="utf-8") as handle:
            handle.write(render_revert(report.create, container))
    except OSError as exc:
        print(
            f"provision_extension: refusing to apply — could not write the revert "
            f"script {args.revert_out}: {exc}",
            file=sys.stderr,
        )
        return 1
    print(f"provision_extension: revert script -> {args.revert_out}")

    try:
        results = create_extensions(container, report.create, args.tech)
    except routes.RouteError as exc:
        print(f"provision_extension: {exc}", file=sys.stderr)
        print(f"provision_extension: undo with {args.revert_out}", file=sys.stderr)
        return 1

    created = [row["extension"] for row in results if row.get("result") == "created"]
    for row in results:
        if row.get("result") == "failed":
            print(
                f"provision_extension: {row['extension']} was not created: "
                f"{row.get('message', 'the framework did not say why')}",
                file=sys.stderr,
            )
        elif row.get("result") == "partial":
            print(
                f"provision_extension: {row['extension']} is half-created "
                f"({row.get('message', '')}) — finish or delete it in FreePBX",
                file=sys.stderr,
            )

    # Re-read rather than trust the call: the framework returning 0 is not
    # evidence that the objects exist.
    if created:
        try:
            verified = verify_created(container, created)
        except routes.RouteError as exc:
            print(f"provision_extension: {exc}", file=sys.stderr)
            print(
                f"provision_extension: created {len(created)} extension(s) but could "
                f"not verify them — check with --check, undo with {args.revert_out}",
                file=sys.stderr,
            )
            return 1
        unverified = sorted(ext for ext, ok in verified.items() if not ok)
        if unverified:
            print(
                "provision_extension: the framework reported these as created but "
                "the PBX does not have both objects: "
                + ", ".join(unverified)
                + f" — undo with {args.revert_out}",
                file=sys.stderr,
            )
            return 1
        print(
            f"provision_extension: created {len(created)} extension(s), verified by "
            f"re-reading the PBX; run `docker exec {container} fwconsole reload`"
        )

    failed = [
        row["extension"]
        for row in results
        if row.get("result") in ("failed", "partial")
    ]
    if failed or report.refused:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
