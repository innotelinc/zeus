#!/usr/bin/env python3
"""pbx/voicemail_mailbox.py — the mailbox an extension was promised, made real.

`*97` is FreePBX's My Voicemail, and on this estate it answers nothing. The
reason is in FreePBX's own create path, vendored at `vendor/freepbx-*.tgz`:

  * **`Core::addUser()` decides voicemail from the mailbox that already exists.**
    It calls `Voicemail::getMailbox($ext)` — which reads `voicemail.conf` — and
    writes the user row with `voicemail = "novm"` when that returns null
    (`core/Core.class.php`, `addUser`). `generateDefaultUserSettings()` carries no
    `voicemail` key at all, so the D6 provisioner's sequence lands there too.
  * **The GraphQL `addExtension(vmEnable, vmPassword)` drops those fields.**
    `core/Api/Gql/Extensions.php` turns them into `$input['vm']` and
    `$input['vmpwd']` — and `vmpwd` appears *nowhere* in `Core.class.php`. The
    mutation accepts them, answers "Extension has been created Successfully", and
    creates no box.

So every extension the platform creates — the portal's
`POST /api/phone/extensions`, `pbx/legacy_voice_migrate.py`, and
`pbx/provision_extension.py` — is a desk phone that rings and a mailbox that does
not exist. `users.voicemail` and AstDB's `AMPUSER/<ext>/voicemail` both read
`novm`, and `*97` (the voicemail module's `app-vmmain` context) does
`Macro(get-vmcontext,${AMPUSER})` → `VoiceMailMain(${AMPUSER}@novm)`: no such box,
so the caller gets the bare login prompt and nothing else. Every other indicator
on the PBX stays green, which is why this was discovered by a call and not by a
check.

There is a gate *before* the mailbox, and it fails the same way at the phone,
which is why this tool judges it first. `macro-user-callerid` does not trust the
caller id it was handed: it re-derives the extension from AstDB's
`DEVICE/<callerid>/user`, then reads `AMPUSER/<ext>/cidname`. Both keys are
written by FreePBX's own create path — `Core::addDevice` and `Core::addUser` —
and an extension that reached the tables by any other route (the portal's
GraphQL `addExtension`, `legacy_voice_migrate.py`'s direct writes) has neither.
`DEVICE/<ext>/user` absent means `AMPUSER` is blanked to `""`, so `*97` calls
`macro-get-vmcontext` with no argument, resolves no context, and the call ends
on the first priority after that lookup — one second, `ANSWERED`, with
`lastapp=Set, lastdata=VMCONTEXT=default` as the only trace. Every extension on
this estate but the hand-built one was in that state.

This is the writer for that fifth thing — and the measurement:

  * `plan` says which mailboxes are missing, and for each one which of the four
    facts is wrong (`no-caller-id`, `no-mailbox`, `not-enabled`,
    `context-disagrees`);
  * `apply` creates them through FreePBX's own `Voicemail::addMailbox` (which
    writes `voicemail.conf` and the mailbox mapping) and then re-points the
    extension at the context — the `users.voicemail` row and the AstDB key a
    re-run of `addUser` would have written, which an *existing* extension cannot
    go through again because `addUser` INSERTs;
  * the read-back is `asterisk -rx 'voicemail show users'` — what Asterisk
    **loaded**, not the file that was just written. `plan` run again after an
    `apply` is the verify; there is no third mode that could disagree with it.

Exit status, three-valued like its siblings:

    0 — every mailbox the intent asks for resolves
    1 — one does not (the line names which fact is wrong; `apply` converges all
        three, so this is also "an apply is pending")
    2 — nothing could be evaluated (no docker, no PBX container, no intent):
        not evidence of health

A limit stated rather than hidden: a mailbox that exists with the *wrong PIN* is
not this tool's finding. `*97` reaches the box (the failure this exists for) and
rejects the PIN; the Voicemail module's own page is where a PIN is changed.

Run:
    python3 pbx/voicemail_mailbox.py plan  --intent mailboxes.json
    python3 pbx/voicemail_mailbox.py apply --intent mailboxes.json
    python3 pbx/voicemail_mailbox.py plan  --intent mailboxes.json   # verify

The intent is a list, `{"extensions": [...]}` or `{"accounts": [...]}`, of an
extension's `extension`, `name`, `email` and `pin` (also read as `voicemail_pin`
or `vm.pin`). `pbx/legacy_voice_migrate.py`'s snapshot is one of those documents
— `/root/pbx-merge/accounts.json` has each account's name, extension and
`vm.pin` — so it can be passed as-is. The PIN goes into `voicemail.conf`, so this
tool's output carries credentials. A row with no PIN is refused by name rather
than given a generated one: a box nobody can open is not a repair.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass

CONTAINER = os.environ.get("ZEUS_PBX_CONTAINER", "zeus-freepbx")

# Where a mailbox lives when nothing says otherwise: FreePBX's own default
# context, and the one `Voicemail::addMailbox` falls back to.
VM_CONTEXT = "default"

# AstDB is where the dialplan reads an extension's voicemail context from —
# `Macro(get-vmcontext,${AMPUSER})` — and nothing clears it when the rows go.
ASTDB_FAMILY = "AMPUSER"

# The family `macro-user-callerid` re-derives the caller from, and the reason a
# mailbox that exists can still be unreachable: with no `DEVICE/<ext>/user` the
# extension is never resolved, so `*97` asks for a context for nobody.
DEVICE_FAMILY = "DEVICE"

# What `users.voicemail` holds when FreePBX considers the extension to have no
# mailbox. `addUser` writes "novm"; the GUI has also used "disabled".
NO_MAILBOX = frozenset({"novm", "disabled", ""})

# A mailbox is a number you dial, so it is the extension, and it is digits:
# every consumer here (`*97`'s VoiceMailMain, the AstDB key, voicemail.conf)
# assumes it. The ceiling is Asterisk's, not FreePBX's convention — this estate's
# extensions are ten-digit DIDs (4132643964 and friends came across whole), so a
# narrower range than that would refuse the mailboxes this tool exists to create.
EXT_RE = re.compile(r"^[0-9]{2,15}$")
PIN_RE = re.compile(r"^[0-9]{4,8}$")


class IntentError(RuntimeError):
    """An intent that cannot be judged."""


# ── the intent (pure) ───────────────────────────────────────────────────────
@dataclass(frozen=True)
class Intent:
    """One mailbox the platform intends to exist, PIN included."""

    extension: str
    name: str
    email: str = ""
    pin: str = ""


def _pin_of(row: dict) -> str:
    """The PIN a row carries, under whichever name its author used.

    Three sources exist in this estate and all three are the same fact: an
    intent written by hand (`pin`), a portal extension row (`voicemail_pin`),
    and the legacy migration's snapshot (`vm.pin`).
    """
    for key in ("pin", "voicemail_pin", "vm_password"):
        value = str(row.get(key, "") or "").strip()
        if value:
            return value
    vm = row.get("vm")
    if isinstance(vm, dict):
        return str(vm.get("pin", "") or "").strip()
    return ""


def parse_intents(text: str) -> list[Intent]:
    """Validate the intent document.

    Refuses rather than repairs — an extension that is not digits, a missing
    name, a PIN that is not one, or the same extension twice would each be
    discovered later as a mailbox nobody can open.
    """
    try:
        raw = json.loads(text)
    except ValueError as exc:
        raise IntentError(f"intent is not JSON: {exc}") from exc

    # `accounts` is not a second format: it is the migration snapshot's own key
    # (`/root/pbx-merge/accounts.json`), and that document already holds each
    # account's name, extension and `vm.pin`. Accepting it means an intent can be
    # handed over as-is rather than translated — and a translation is where a PIN
    # gets left behind.
    if isinstance(raw, dict):
        rows = raw.get("extensions", raw.get("accounts"))
    else:
        rows = raw
    if not isinstance(rows, list):
        raise IntentError(
            "intent must be {\"extensions\": [...]}, {\"accounts\": [...]} or a list "
            "of extensions"
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
                f"entry {index}: extension {ext!r} is not digits — a mailbox is "
                "a number you dial, and every consumer here assumes digits"
            )
        if not name:
            raise IntentError(f"entry {index}: extension {ext} has no name")
        if ext in seen:
            raise IntentError(
                f"entry {index}: extension {ext} appears twice (entry {seen[ext]})"
            )
        seen[ext] = index
        intents.append(
            Intent(
                extension=ext,
                name=name,
                email=str(row.get("email", "") or "").strip(),
                pin=_pin_of(row),
            )
        )
    return intents


def unpinned(intents: list[Intent], fallback: str) -> dict[str, str]:
    """{extension: why} for the rows that cannot be created, PIN first.

    A mailbox created without a PIN is a box anybody can open, so this is a
    refusal and not a default. Nothing is generated: the operator holds the
    source PIN (`vm.pin`, `voicemail_pin`), and a wrong one is worse than a
    missing box because it looks finished.
    """
    trouble: dict[str, str] = {}
    for intent in intents:
        pin = intent.pin or fallback
        if not pin:
            trouble[intent.extension] = "no PIN (add one to the intent or pass --pin)"
        elif not PIN_RE.match(pin):
            trouble[intent.extension] = (
                f"PIN {pin!r} is not 4-8 digits — FreePBX's Voicemail page will not "
                "accept it and neither should this"
            )
    return trouble


def pin_for(intent: Intent, fallback: str) -> str:
    return intent.pin or fallback


# ── the PBX's answers (pure) ────────────────────────────────────────────────
def parse_loaded(text: str) -> dict[str, str]:
    """{mailbox: context} from `asterisk -rx 'voicemail show users'`.

    The command prints a fixed-width table under a
    `context  mbox  user  zone  newmsg` header, so the context is the first
    column and the mailbox the second — the user column carries spaces. This is
    the *loaded* config: it is what `*97` will look the box up in.
    """
    found: dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.lower().startswith("context"):
            continue
        parts = line.split()
        if len(parts) >= 2 and EXT_RE.match(parts[1]):
            found[parts[1]] = parts[0]
    return found


def parse_astdb(text: str) -> dict[str, str]:
    """{extension: context} from `asterisk -rx 'database show AMPUSER'`.

    One `/AMPUSER/<ext>/voicemail : <context>` line per extension, which is the
    key `Macro(get-vmcontext,${AMPUSER})` reads before `VoiceMailMain`.
    """
    found: dict[str, str] = {}
    prefix = f"/{ASTDB_FAMILY}/"
    for raw in text.splitlines():
        line = raw.strip()
        if not line.startswith(prefix) or ":" not in line:
            continue
        key, value = line.split(":", 1)
        parts = key[len(prefix) :].strip().split("/")
        if len(parts) == 2 and parts[1] == "voicemail" and parts[0]:
            found[parts[0]] = value.strip()
    return found


def parse_cidname(text: str) -> dict[str, str]:
    """{extension: cidname} from `asterisk -rx 'database show AMPUSER'`.

    The second half of the caller-id gate. `/AMPUSER/<ext>/cidname` sits among
    the same dozens of sibling keys as the voicemail one, and an empty value is
    the same as absent to `macro-user-callerid` — it reads the attribute, not
    the key's existence.
    """
    found: dict[str, str] = {}
    prefix = f"/{ASTDB_FAMILY}/"
    for raw in text.splitlines():
        line = raw.strip()
        if not line.startswith(prefix) or ":" not in line:
            continue
        key, value = line.split(":", 1)
        parts = key[len(prefix) :].strip().split("/")
        if len(parts) == 2 and parts[1] == "cidname" and parts[0]:
            found[parts[0]] = value.strip()
    return found


def parse_device_user(text: str) -> dict[str, str]:
    """{device: user} from `asterisk -rx 'database show DEVICE'`.

    `DEVICE/<id>/user` is the mapping `macro-user-callerid` resolves a call's
    caller id through (`${DB(DEVICE/${REALCALLERIDNUM}/user)}`), which is why a
    missing one blanks `AMPUSER` even when the extension, its device row and its
    mailbox all exist. The other keys in the family are read by other features;
    only this one decides whether `*97` knows who is dialling.
    """
    found: dict[str, str] = {}
    prefix = f"/{DEVICE_FAMILY}/"
    for raw in text.splitlines():
        line = raw.strip()
        if not line.startswith(prefix) or ":" not in line:
            continue
        key, value = line.split(":", 1)
        parts = key[len(prefix) :].strip().split("/")
        if len(parts) == 2 and parts[1] == "user" and parts[0]:
            found[parts[0]] = value.strip()
    return found


def parse_users(rows: str) -> dict[str, str]:
    """{extension: voicemail} from `select extension, voicemail from users`."""
    found: dict[str, str] = {}
    for raw in rows.splitlines():
        parts = raw.rstrip("\n").split("\t")
        if len(parts) >= 2 and parts[0].strip():
            found[parts[0].strip()] = parts[1].strip()
    return found


# ── the judgement (pure) ────────────────────────────────────────────────────
@dataclass(frozen=True)
class Finding:
    """Which of the three facts behind `*97` is wrong, and what fixes it."""

    state: str
    detail: str
    repair: str

    @property
    def ok(self) -> bool:
        return self.state == "ok"


def verdict(
    intent: Intent,
    *,
    loaded: dict[str, str],
    users: dict[str, str],
    astdb: dict[str, str],
    device_user: dict[str, str],
    cidname: dict[str, str],
) -> Finding:
    """Whether one extension's mailbox can be reached by dialing `*97`.

    The four facts are checked in the order they fail, and each names its own
    repair: an extension the switch cannot name from its caller id is wired;
    a box that is not in the loaded config is created; an extension FreePBX
    records as `novm` is enabled; and a mailbox the dialplan resolves in a
    different context than it lives in is re-pointed. All four are writes
    `apply` makes, which is why one finding is not more work than another.

    The caller-id pair is judged first because it is what the other three are
    looked up *with*: with no `AMPUSER`, `macro-get-vmcontext` is called with no
    argument and no box could be reached however many exist.
    """
    ext = intent.extension

    device_of = device_user.get(ext, "")
    name_of = cidname.get(ext, "")
    if not device_of or not name_of:
        absent = [
            key
            for key, value in (
                (f"{DEVICE_FAMILY}/{ext}/user", device_of),
                (f"{ASTDB_FAMILY}/{ext}/cidname", name_of),
            )
            if not value
        ]
        return Finding(
            state="no-caller-id",
            detail=(
                ", and ".join(absent)
                + " — the two keys `macro-user-callerid` resolves an internal "
                "caller with. With either absent it blanks AMPUSER, so `*97` "
                "calls `macro-get-vmcontext` with no argument, resolves no "
                "context, and the call ends one second in (lastapp=Set, "
                "lastdata=VMCONTEXT=default)"
            ),
            repair=(
                f"apply: set {DEVICE_FAMILY}/{ext}/user = {ext} (with its dial, "
                f"tech and type, as Core::addDevice writes them) and "
                f"{ASTDB_FAMILY}/{ext}/cidname = {intent.name}"
            ),
        )

    context = loaded.get(ext)

    if context is None:
        return Finding(
            state="no-mailbox",
            detail=(
                f"`*97` does VoiceMailMain({ext}@${{VMCONTEXT}}) and the loaded "
                f"voicemail.conf has no mailbox {ext}"
            ),
            repair=f"apply: addMailbox({ext}) in [{VM_CONTEXT}] with the account's PIN",
        )

    recorded = users.get(ext)
    if recorded is None or recorded in NO_MAILBOX:
        return Finding(
            state="not-enabled",
            detail=(
                f"the mailbox {ext}@{context} exists, and users.voicemail is "
                f"{recorded!r} — Core::addUser wrote that because the box did not "
                f"exist when the extension was created"
            ),
            repair=f"apply: set users.voicemail = {context} for {ext}",
        )

    resolved = astdb.get(ext)
    if resolved != context:
        return Finding(
            state="context-disagrees",
            detail=(
                f"the box lives in [{context}] and the dialplan resolves "
                f"AMPUSER/{ext}/voicemail to {resolved or 'nothing'!r}, which is "
                f"where app-vmmain looks it up"
            ),
            repair=f"apply: set AMPUSER/{ext}/voicemail = {context}",
        )

    return Finding(
        state="ok",
        detail=f"mailbox {ext}@{context} is loaded and the dialplan resolves it",
        repair="",
    )


# ── the live PBX ────────────────────────────────────────────────────────────
def _run(args: list[str], stdin: str | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(args, capture_output=True, text=True, input=stdin, timeout=120)


def _exec(*args: str) -> str | None:
    """One read inside the PBX container. None means "could not be read".

    The distinction is the whole point: an empty answer is not an empty PBX.
    """
    done = _run(["docker", "exec", CONTAINER, *args])
    if done.returncode != 0:
        return None
    return done.stdout


def read_asterisk(cli: str) -> str | None:
    return _exec("asterisk", "-rx", cli)


def read_users() -> str | None:
    return _exec(
        "mysql",
        "-uroot",
        "asterisk",
        "-N",
        "-B",
        "-e",
        "select extension, voicemail from users",
    )


# The create, run inside the container against the framework's own API. The
# mailbox first, then the two rows that point the extension at it: that is the
# order `Core::addUser` reads them in, and an existing extension cannot be sent
# through `addUser` again because it INSERTs.
APPLY_SCRIPT = """<?php
require '/etc/freepbx.conf';
$rows = json_decode(getenv('ZEUS_VM_INTENTS') ?: '[]', true);
$out = array();
$vm = FreePBX::Voicemail();
$db = FreePBX::Database();
$astman = FreePBX::create()->astman;
foreach ($rows as $row) {
    $ext = (string)$row['extension'];
    $ctx = isset($row['vmcontext']) && $row['vmcontext'] !== '' ? $row['vmcontext'] : 'default';
    try {
        // The box, through the module that owns voicemail.conf. addMailbox
        // writes the mailbox line and the mailbox mapping, and records the PIN
        // as the mailbox's password.
        $box = $vm->getMailbox($ext, false);
        if (empty($box)) {
            $vm->addMailbox($ext, array(
                'vmcontext' => $ctx,
                'vmpwd'     => (string)$row['pin'],
                'name'      => (string)$row['name'],
                'email'     => (string)$row['email'],
            ));
            $result = 'created';
        } else {
            // A box another context already holds is left where it is: moving
            // it would strand any messages already in it.
            $ctx = $box['vmcontext'];
            $result = 'exists';
        }
        // The caller-id pair `*97` resolves the extension with before it
        // looks any box up: `macro-user-callerid` reads DEVICE/<callerid>/user
        // and AMPUSER/<ext>/cidname, and blanks AMPUSER when either is absent.
        // Both are Core::addUser's and Core::addDevice's own writes, so this
        // is the framework's set, derived from the rows rather than invented —
        // and written only where absent, so a mapping a person set is never
        // overwritten.
        if ($astman->connected()) {
            if (trim((string)$astman->database_get('AMPUSER', $ext . '/cidname')) === '') {
                $astman->database_put('AMPUSER', $ext . '/cidname', (string)$row['name']);
            }
            if (trim((string)$astman->database_get('AMPUSER', $ext . '/cidnum')) === '') {
                $astman->database_put('AMPUSER', $ext . '/cidnum', $ext);
            }
            $sthdev = $db->prepare('SELECT tech, dial, devicetype, user FROM devices WHERE id = ?');
            $sthdev->execute(array($ext));
            $device = $sthdev->fetch(PDO::FETCH_ASSOC);
            if ($device && trim((string)$astman->database_get('DEVICE', $ext . '/user')) === '') {
                $devuser = (string)$device['user'] !== '' ? (string)$device['user'] : $ext;
                $astman->database_put('DEVICE', $ext . '/user', $devuser);
                $astman->database_put('DEVICE', $ext . '/tech', (string)$device['tech']);
                $astman->database_put('DEVICE', $ext . '/dial', (string)$device['dial']);
                $astman->database_put('DEVICE', $ext . '/type', (string)$device['devicetype']);
                $astman->database_put('DEVICE', $ext . '/default_user', $devuser);
                if (trim((string)$astman->database_get('AMPUSER', $ext . '/device')) === '') {
                    $astman->database_put('AMPUSER', $ext . '/device', $ext);
                }
            }
        }
        $sth = $db->prepare('UPDATE users SET voicemail = ? WHERE extension = ?');
        $sth->execute(array($ctx, $ext));
        if ($astman->connected()) {
            $astman->database_put('AMPUSER', $ext . '/voicemail', $ctx);
        }
        $out[] = array('extension' => $ext, 'result' => $result, 'context' => $ctx);
    } catch (\\Exception $e) {
        $out[] = array('extension' => $ext, 'result' => 'failed',
                       'message' => $e->getMessage());
    }
}
echo json_encode($out), PHP_EOL;
"""


def apply(intents: list[Intent], fallback_pin: str) -> list[dict]:
    """Create and re-point every mailbox. Returns the script's own report.

    The intent travels in the environment rather than the argument list: it
    carries a PIN, and `ps` can read a command line.
    """
    payload = [
        {
            "extension": i.extension,
            "name": i.name,
            "email": i.email,
            "pin": pin_for(i, fallback_pin),
            "vmcontext": VM_CONTEXT,
        }
        for i in intents
    ]
    done = _run(
        [
            "docker", "exec", "-i",
            "-e", "ZEUS_VM_INTENTS=" + json.dumps(payload),
            CONTAINER, "php",
        ],
        stdin=APPLY_SCRIPT,
    )
    if done.returncode != 0:
        detail = done.stderr.strip().splitlines()
        raise IntentError(
            f"FreePBX's API did not answer in {CONTAINER}: "
            f"{detail[-1] if detail else done.returncode}"
        )
    lines = [line for line in done.stdout.strip().splitlines() if line.strip()]
    try:
        return json.loads(lines[-1])
    except (ValueError, IndexError) as exc:
        raise IntentError(
            f"could not read the mailbox result from {CONTAINER}: {exc}"
        ) from exc


def main(argv: list[str] | None = None) -> int:
    global CONTAINER
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("mode", choices=("plan", "apply"))
    parser.add_argument("--intent", required=True)
    parser.add_argument("--pbx", default=CONTAINER)
    parser.add_argument("--pin", default="", help="PIN for rows that carry none")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    CONTAINER = args.pbx

    try:
        with open(args.intent) as handle:
            intents = parse_intents(handle.read())
    except (OSError, IntentError) as err:
        print(f"voicemail_mailbox: {err}", file=sys.stderr)
        return 2

    unpinned_rows = unpinned(intents, args.pin)
    if unpinned_rows and args.mode == "apply":
        for ext, why in unpinned_rows.items():
            print(f"REFUSE  {ext}: {why}", file=sys.stderr)
        return 1

    if args.mode == "apply":
        try:
            report = apply(intents, args.pin)
        except IntentError as err:
            print(f"voicemail_mailbox: {err}", file=sys.stderr)
            return 2
        if not args.json:
            for row in report:
                line = f"       {str(row.get('extension')):>8}  {row.get('result')}"
                if row.get("context"):
                    line += f" [{row['context']}]"
                if row.get("message"):
                    line += f"  ({row['message']})"
                print(line)
        # The read-back is what Asterisk loads, so the reload comes first and
        # the finding below is measured after it, not from the write.
        _run(["docker", "exec", CONTAINER, "fwconsole", "reload"])

    loaded_text = read_asterisk("voicemail show users")
    users_text = read_users()
    astdb_text = read_asterisk(f"database show {ASTDB_FAMILY}")
    device_text = read_asterisk(f"database show {DEVICE_FAMILY}")
    if (
        loaded_text is None
        or users_text is None
        or astdb_text is None
        or device_text is None
    ):
        print(
            "voicemail_mailbox: the PBX could not be read (no docker, or no "
            f"container named {CONTAINER}) — nothing was evaluated",
            file=sys.stderr,
        )
        return 2

    loaded = parse_loaded(loaded_text)
    users = parse_users(users_text)
    astdb = parse_astdb(astdb_text)
    device_user = parse_device_user(device_text)
    cidname = parse_cidname(astdb_text)

    findings = []
    for intent in intents:
        finding = verdict(
            intent,
            loaded=loaded,
            users=users,
            astdb=astdb,
            device_user=device_user,
            cidname=cidname,
        )
        findings.append((intent, finding))

    if args.json:
        print(
            json.dumps(
                [
                    {
                        "extension": intent.extension,
                        "state": finding.state,
                        "detail": finding.detail,
                        "repair": finding.repair,
                    }
                    for intent, finding in findings
                ],
                indent=2,
            )
        )
    else:
        for intent, finding in findings:
            mark = "OK    " if finding.ok else "FIND  "
            print(f"{mark}{intent.extension:>8}  {finding.detail}")
            if not finding.ok:
                print(f"         repair: {finding.repair}")

    bad = [f for _, f in findings if not f.ok]
    if bad:
        print(f"\n{len(bad)} of {len(findings)} mailboxes do not resolve")
        return 1
    print(f"\n{len(findings)} of {len(findings)} mailboxes resolve")
    return 0


if __name__ == "__main__":
    sys.exit(main())
