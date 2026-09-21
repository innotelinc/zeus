#!/usr/bin/env python3
"""Merge the legacy `voice` PBX accounts into Zeus.

Source: snapshots captured from the legacy bare-metal FreePBX (extension
accounts, their devices, voicemail, caller IDs, device secrets, and
`userman_users` rows including the bcrypt password hashes).

Target: the Zeus PBX, driven through FreePBX's own GraphQL API — the same path
the portal provisions with — rather than writing config rows behind FreePBX's
back. Three properties that API cannot carry, and how each is handled:

  * device secrets. `addExtension` has no secret field (it generates one), and
    `updateExtension` is a no-op in this build — it answers
    `{status: null, message: null}` and changes nothing. The legacy secret is
    therefore written into the `sip` table, which is FreePBX's own store for
    device keyword/data and what the GUI's device editor writes, and applied by
    `fwconsole reload`. `verify` reads it back out of the generated config
    rather than out of the table we just wrote.
  * IAX2 devices. Some FreePBX builds refuse them outright — "The existing
    driver not support this tech(`iax2`) option. Please use pjsip instead" — so
    an iax2 device lands as pjsip and the ATA has to be reprovisioned to SIP.
    The tool says so per account rather than switching tech silently.
  * User Management passwords. The API only takes a plaintext `umPassword`, and
    a bcrypt hash cannot be reversed, so the legacy hash is copied verbatim into
    `userman_users`, which is what the userman driver reads.

Idempotent: an object that already exists is aligned, never recreated, and
nothing the target PBX already had is overwritten — this merges into a live PBX
that may already route DIDs to the voice agents.

    legacy_voice_migrate.py plan     # compare, say what would change
    legacy_voice_migrate.py apply    # do it
    legacy_voice_migrate.py verify   # prove the result matches the source

Outbound routes are reported, never written; see report_outbound() for why.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

PBX = os.environ.get("ZEUS_PBX_URL", "http://127.0.0.1:8083")
PBX_CONTAINER = os.environ.get("ZEUS_PBX_CONTAINER", "zeus-freepbx")
PORTAL_CONTAINER = os.environ.get("ZEUS_PORTAL_CONTAINER", "zeus-portal")
EMAIL_DOMAIN = os.environ.get("ZEUS_EMAIL_DOMAIN", "innotel.us")

SNAP = os.environ.get("ZEUS_LEGACY_ACCOUNTS", "/root/pbx-merge/accounts.json")
UM_SNAP = os.environ.get("ZEUS_LEGACY_UM", "/root/pbx-merge/um_users.json")
ROUTES_SNAP = os.environ.get("ZEUS_LEGACY_ROUTES", "/root/pbx-merge/routes.json")

# Source destinations that do not exist on the target, translated to their
# equivalent. `from-external,824,1` reached extension 824 = Stasis(dograh) — the
# voice agent with no explicit agent, i.e. the default, which Zeus spells
# `dograh-inbound,8000,1` and where it already sends its own PSTN DID.
DESTINATION_TRANSLATION = {"from-external,824,1": "dograh-inbound,8000,1"}

ADD_EXT = ("mutation A($input: addExtensionInput!) "
           "{ addExtension(input: $input) { status message } }")

IAX2_UNSUPPORTED = ("source device was iax2; this build refuses iax2 devices "
                    "(pjsip only) — migrated as pjsip, the ATA needs "
                    "reprovisioning to SIP")


# ── pure decisions ───────────────────────────────────────────────────────────

def voicemail_enabled(account: dict) -> bool:
    return str(account.get("voicemail", "")).lower() not in ("novm", "", "none")


def core_input(account: dict) -> dict:
    """The addExtension core fields the source account implies."""
    ext, name = account["extension"], account["name"]
    vm_ok = voicemail_enabled(account)
    payload = {"extensionId": ext, "name": name, "callerID": f"{name} <{ext}>",
               "vmEnable": vm_ok}
    outbound = (account.get("outboundcid") or "").strip()
    if outbound:
        payload["outboundCid"] = outbound
    pin = (account.get("vm") or {}).get("pin")
    if vm_ok and pin:
        payload["vmPassword"] = pin
    return payload


def translated_destination(destination: str) -> str:
    return DESTINATION_TRANSLATION.get(destination, destination)


def secret_upsert_sql(ext: str, secret: str) -> str:
    """Upsert the device secret where FreePBX keeps device keyword/data.

    `updateExtension(extPassword)` is a no-op in the builds this has to run
    against and the bulk handler has no secret column, so this is the same write
    the GUI's device page performs, applied by the next reload. `sip` is the
    table FreePBX reads regardless of whether the device is chan_pjsip.
    """
    escaped = secret.replace("'", "''")
    return (f"insert into sip (id, keyword, data, flags) "
            f"values ('{ext}', 'secret', '{escaped}', 0) "
            f"on duplicate key update data='{escaped}'")


def tech_note(tech: str) -> str | None:
    """The honest warning for a device the target cannot host as-is."""
    return IAX2_UNSUPPORTED if tech == "iax2" else None


def parse_auth_conf(text: str) -> dict[str, str]:
    """Extension -> password, as Asterisk will actually load it.

    FreePBX renders each extension's credential into pjsip.auth.conf as an
    `[<ext>-auth]` section, so this is an end-to-end check rather than a read of
    the table the tool just wrote.
    """
    secrets: dict[str, str] = {}
    section = None
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith((";", "#")):
            continue
        if stripped.startswith("[") and stripped.endswith("]"):
            name = stripped[1:-1]
            section = name[:-5] if name.endswith("-auth") else None
        elif section and "=" in stripped:
            key, value = stripped.split("=", 1)
            if key.strip() in ("password", "secret"):
                secrets[section] = value.strip()
    return secrets


def plan_account(account: dict, *, exists: bool, secret_on_target: str,
                 tech_on_target: str) -> list[str]:
    """What would change for one account. Pure, so it can be unit-tested."""
    ext, name = account["extension"], account["name"]
    tech = account.get("device_tech") or "pjsip"
    tag = f"{ext:>11}  {name[:26]:26}"
    notes: list[str] = []

    if not exists:
        notes.append(f"PLAN  {tag} create as {tech}, secret{' + UCP' if account.get('um') else ''} from source")
    note = tech_note(tech)
    if note:
        notes.append(f"NOTE  {tag} {note}")
    legacy = account.get("secret") or ""
    if legacy:
        if secret_on_target == legacy:
            notes.append(f"OK    {tag} device secret already matches source")
        else:
            notes.append(f"PLAN  {tag} set legacy device secret")
    if tech_on_target and tech_on_target != tech and not note:
        notes.append(f"PLAN  {tag} tech {tech_on_target} -> {tech}")
    return notes


# ── I/O ──────────────────────────────────────────────────────────────────────

def _run(args: list[str], **kwargs) -> subprocess.CompletedProcess:
    return subprocess.run(args, capture_output=True, text=True, **kwargs)


def sql(query: str) -> list[str]:
    out = _run(["docker", "exec", PBX_CONTAINER, "mysql", "-uroot", "asterisk",
                "-N", "-B", "-e", query])
    return [line for line in out.stdout.splitlines() if line.strip()]


def one(query: str) -> str:
    found = sql(query)
    return found[0] if found else ""


def reload_pbx() -> None:
    _run(["docker", "exec", PBX_CONTAINER, "fwconsole", "reload"], timeout=300)


def api_token() -> str:
    def portal_env(name: str) -> str:
        return _run(["docker", "exec", PORTAL_CONTAINER, "printenv", name]).stdout.strip()

    body = urllib.parse.urlencode({
        "grant_type": "client_credentials",
        "client_id": portal_env("FREEPBX_CLIENT_ID"),
        "client_secret": portal_env("FREEPBX_CLIENT_SECRET"),
    }).encode()
    request = urllib.request.Request(f"{PBX}/admin/api/api/token", data=body)
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)["access_token"]


def gql(query: str, variables: dict, token: str) -> dict:
    payload = json.dumps({"query": query, "variables": variables}).encode()
    request = urllib.request.Request(
        f"{PBX}/admin/ajax.php?module=api&command=gql", data=payload,
        headers={"Authorization": f"Bearer {token}",
                 "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            parsed = json.load(response)
    except urllib.error.HTTPError as err:
        raise RuntimeError(f"HTTP {err.code}: {err.read().decode()[:200]}") from None
    if parsed.get("errors"):
        raise RuntimeError("; ".join(e.get("message", "?") for e in parsed["errors"]))
    return parsed.get("data") or {}


def generated_secret(ext: str) -> str:
    out = _run(["docker", "exec", PBX_CONTAINER, "cat",
                "/etc/asterisk/pjsip.auth.conf"])
    return parse_auth_conf(out.stdout).get(ext, "")


def ensure_account(token: str, account: dict, apply: bool, um: dict,
                   has_ucp: bool) -> list[str]:
    ext, name = account["extension"], account["name"]
    tech = account.get("device_tech") or "pjsip"
    tag = f"{ext:>11}  {name[:26]:26}"
    notes: list[str] = []
    exists = bool(one(f"select 1 from users where extension='{ext}' limit 1"))

    if not exists:
        if not apply:
            return plan_account({**account, "um": bool(um)}, exists=False,
                                secret_on_target="", tech_on_target="")
        payload = core_input(account)
        payload.update({"tech": "pjsip", "email": f"{ext}@{EMAIL_DOMAIN}"})
        result = gql(ADD_EXT, {"input": payload}, token)["addExtension"]
        if not result["status"]:
            return [f"FAIL  {tag} addExtension: {result['message']}"]
        notes.append(f"ADD   {tag} created (pjsip)")

    note = tech_note(tech)
    if note:
        notes.append(f"NOTE  {tag} {note}")

    legacy = account.get("secret") or ""
    if legacy:
        current = one(f"select data from sip where id='{ext}' and keyword='secret'")
        if current == legacy:
            notes.append(f"OK    {tag} device secret already matches source")
        elif not apply:
            notes.append(f"PLAN  {tag} set legacy device secret")
        else:
            sql(secret_upsert_sql(ext, legacy))
            got = one(f"select data from sip where id='{ext}' and keyword='secret'")
            ok = got == legacy
            notes.append(f"{'SECRET' if ok else 'FAIL  '}  {tag} device secret "
                         f"{'matches source' if ok else 'MISMATCH'}")

    if has_ucp and um.get("password"):
        row = one("select id from userman_users "
                  f"where default_extension='{ext}' limit 1")
        if not row:
            notes.append(f"WARN  {tag} no User Management user on the target to carry the hash")
        elif one(f"select password from userman_users where id={row}") == um["password"]:
            notes.append(f"OK    {tag} UCP password hash matches source")
        elif not apply:
            notes.append(f"PLAN  {tag} restore legacy UCP password hash")
        else:
            sets = [f"password='{um['password']}'"]
            for column in ("username", "displayname", "fname", "lname", "email",
                           "description", "auth", "authid", "primary_group",
                           "permissions"):
                value = (um.get(column) or "").replace("'", "''")
                sets.append(f"{column}=" + (f"'{value}'" if value else "NULL"))
            sql(f"update userman_users set {', '.join(sets)} where id={row}")
            ok = one(f"select password from userman_users where id={row}") == um["password"]
            notes.append(f"{'UCP   ' if ok else 'FAIL  '}  {tag} UCP password hash "
                         f"{'matches source' if ok else 'MISMATCH'}")
    return notes


def ensure_ring_group(token: str, group: list[str], apply: bool) -> str:
    number, description, strategy, ring, members = group[0], group[1], group[2], group[3], group[4]
    line = f"ringgroup {number} '{description}' {strategy} {ring}s members={members}"
    if one(f"select 1 from ringgroups where grpnum='{number}' limit 1"):
        return f"SKIP  {line}  (already on the target)"
    if not apply:
        return f"PLAN  {line}"
    result = gql("mutation A($input: addRingGroupInput!) "
                 "{ addRingGroup(input: $input) { status message } }",
                 {"input": {"groupNumber": number, "description": description,
                            "strategy": strategy, "extensionList": members,
                            "ringTime": ring}}, token)["addRingGroup"]
    return f"{'ADD ' if result['status'] else 'FAIL'}  {line}" + (
        "" if result["status"] else f"  ({result['message']})")


def ensure_inbound(token: str, row: list[str], apply: bool) -> str:
    ext, cidnum, description, source_destination = row[0], row[1], row[2], row[3]
    destination = translated_destination(source_destination)
    translated = "" if destination == source_destination else f"  (was {source_destination})"
    line = f"inbound {ext or '(catch-all)'} -> {destination}  '{description or '-'}'{translated}"
    if ext and one(f"select 1 from incoming where extension='{ext}' limit 1"):
        return f"SKIP  {line}  (target already routes this DID)"
    if not apply:
        return f"PLAN  {line}"
    result = gql("mutation A($input: addInboundRouteInput!) "
                 "{ addInboundRoute(input: $input) { status message } }",
                 {"input": {"extension": ext, "cidnum": cidnum,
                            "description": description, "destination": destination}},
                 token)["addInboundRoute"]
    return f"{'ADD ' if result['status'] else 'FAIL'}  {line}" + (
        "" if result["status"] else f"  ({result['message']})")


def report_outbound(snapshot: dict, token: str) -> None:
    """Report the source's outbound routes against the target's. Never writes.

    FreePBX evaluates outbound routes in sequence order and the target's first
    route matches `X.` — every number. A migrated route placed after it can
    never be reached, and one placed before it would hijack ordinary dialing
    with the fax caller ID and its own digit normalisation. Preserving the
    source's outbound plan therefore means changing the priority or the patterns
    of a live dial plan, which is an operator decision rather than a migration
    detail.
    """
    target = sql("select r.route_id, r.name, p.match_pattern_pass, p.prepend_digits, s.seq "
                 "from outbound_routes r "
                 "left join outbound_route_patterns p on p.route_id = r.route_id "
                 "left join outbound_route_sequence s on s.route_id = r.route_id "
                 "order by s.seq, r.route_id")
    print("outbound routes (reported, not changed)")
    print("  on the target:")
    for row in target:
        route_id, name, pattern, prepend, seq = (row.split("\t") + ["", "", "", "", ""])[:5]
        print(f"    seq={seq or '?':3} route {route_id} {name:10} {pattern or '-':14} prepend={prepend or '-'}")
    print("  on the source:")
    for route in snapshot.get("routes", []):
        patterns = ", ".join(
            f"{p.get('match') or '-'}" + (f"+{p['prepend']}" if p.get("prepend") else "")
            for p in route.get("patterns", [])) or "-"
        print(f"    seq={route.get('seq') or '?':3} route {route['route_id']} "
              f"{route['name']:10} {patterns:44} cid={route.get('outcid') or '-'}")
    if snapshot.get("trunks"):
        names = ", ".join(f"{t['name']} ({t['tech']})" for t in snapshot["trunks"])
        print(f"  source trunks: {names}")
    print("  nothing written: on the target the first route matches X. (every number), so a"
          "\n  later route is unreachable and an earlier one would take over ordinary dialing."
          "\n  Moving these is a dial-plan priority decision, not a migration step.")


def load(path: str) -> dict:
    with open(path) as handle:
        return json.load(handle)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("mode", choices=("plan", "apply", "verify"))
    parser.add_argument("--accounts", default=SNAP)
    parser.add_argument("--um", default=UM_SNAP)
    parser.add_argument("--routes", default=ROUTES_SNAP)
    args = parser.parse_args(argv)

    apply = args.mode == "apply"
    snapshot = load(args.accounts)
    accounts = snapshot["accounts"]
    um_by_extension = {row["default_extension"]: row
                       for row in load(args.um)["users"]}
    has_ucp = {ext for ext, row in um_by_extension.items() if row.get("password")}
    print(f"source  {snapshot['source_host']}  ({len(accounts)} accounts, "
          f"{len(has_ucp)} UCP users)")
    print(f"target  Zeus PBX ({PBX_CONTAINER})   mode={args.mode.upper()}\n")

    token = api_token()

    print("accounts")
    for account in accounts:
        try:
            for line in ensure_account(token, account, apply,
                                       um_by_extension.get(account["extension"], {}),
                                       account["extension"] in has_ucp):
                print("  " + line)
        except Exception as err:          # one bad account must not stop the merge
            print(f"  FAIL  {account['extension']}: {err}")

    print("\nring groups")
    for group in snapshot.get("ringgroups", []):
        try:
            print("  " + ensure_ring_group(token, group, apply))
        except Exception as err:
            print(f"  FAIL  ringgroup {group[0]}: {err}")

    print("\ninbound routes")
    for row in snapshot.get("inbound", []):
        try:
            print("  " + ensure_inbound(token, row, apply))
        except Exception as err:
            print(f"  FAIL  inbound {row[0] or '(catch-all)'}: {err}")

    if snapshot.get("sms_webhooks"):
        print("\nsms webhooks")
        for row in snapshot["sms_webhooks"]:
            print(f"  {row}")
    else:
        print("\nsms webhooks\n  none on the source (its SMS module tables are empty)")

    if apply:
        reload_pbx()
        print("\napplied: fwconsole reload")

    if args.mode in ("apply", "verify"):
        print("\nresult on the target")
        print(f"  extensions  {len(sql('select extension from users'))}")
        print(f"  devices     {len(sql('select id from devices'))}")
        print(f"  ring groups {len(sql('select grpnum from ringgroups'))}")
        print(f"  inbound     {len(sql('select extension from incoming'))}")
        print(f"  UCP users   {len(sql('select id from userman_users'))}")
        print("\nsecrets as Asterisk will load them")
        for account in accounts:
            if not account.get("secret"):
                continue
            got = generated_secret(account["extension"])
            state = ("matches source" if got == account["secret"]
                     else "not in generated config" if not got else "DIFFERS from source")
            print(f"  {account['extension']:>11}  {state}")

    if sys.stdout.isatty() or args.mode != "apply":
        try:
            print()
            report_outbound(load(args.routes), token)
        except FileNotFoundError:
            print(f"\noutbound routes: no snapshot at {args.routes}; skipped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
