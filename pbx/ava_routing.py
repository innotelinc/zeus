#!/usr/bin/env python3
"""pbx/ava_routing.py — render the per-account AVA routing block.

Every inbound DID is answered by AVA (the first-response voice agent). Which
agent answers that account, whether the account may reach Capstone's interview
agent, and any audio/provider override are per-account decisions, and this tool
is their single renderer: it turns the portal's accounts into the
``[zeus-ai-accounts]`` dialplan context that ``pbx/asterisk/extensions_custom.conf``
includes.

Why render dialplan instead of setting variables on each FreePBX inbound
route: the decision then has one owner, it survives a FreePBX "Apply Config",
and it can be unit-tested without a PBX.

Output is a FreePBX fragment. It is applied through the same per-context merge
as the rest of the dialplan, so nothing else in the file is disturbed:

    python3 pbx/ava_routing.py --accounts-json /tmp/accounts.json --out /tmp/accounts.conf
    python3 pbx/asterisk_converge.py --target <extensions_custom.conf> \\
        --source /tmp/accounts.conf --owner zeus

Fail-closed rules, in order of importance:

  * An account with no add-on record does NOT get the Capstone handoff. The
    routing block writes ``ZEUS_CAPSTONE_ADDON`` only when the account is
    entitled, and ``[zeus-ai-handoff]`` refuses extension 824 without it — so
    an agent prompt cannot hand a call to a product the account has not bought.
  * An account with no agent recorded still gets a route: it falls through to
    the operator rather than being answered by a guessed agent, because AVA
    routing is agent-only and starts the wrong conversation if we guess.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys

# The agent slug charset AVA's store accepts (agents_store.slugify output).
AGENT_SLUG_RE = re.compile(r"^[a-z0-9]{1,64}$")
# Audio/provider override names are passthrough, but must not be able to
# escape the dialplan: block anything that could close a ${} or a line.
SAFE_TOKEN_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,64}$")

DEFAULT_AGENT = "receptionist"
CONTEXT = "zeus-ai-accounts"


class PlanError(ValueError):
    """A routing plan that must not be rendered."""


def _normalize_did(raw: object) -> str:
    """Return the DID as digits, or raise.

    DIDs reach us from a phone-number table, a CSV export of one, and
    occasionally a human, so formatting is stripped first. An 11-digit NANP
    number keeps only its 10-digit national form: FreePBX inbound routes match
    the DID as dialed, and ``17745057135`` would never match a route for
    ``7745057135`` — the call would fall to the catch-all instead of the
    account.

    Anything that is not 7-15 digits is refused rather than rendered into a
    dialplan pattern.
    """
    did = "".join(ch for ch in str(raw) if ch.isdigit())
    if len(did) == 11 and did.startswith("1"):
        did = did[1:]
    if not 7 <= len(did) <= 15:
        raise PlanError(f"not a dialable DID: {raw!r}")
    return did


def load_plan(path: str) -> dict:
    """Load a routing plan JSON file (as produced by the portal)."""
    with open(path, "r", encoding="utf-8") as fh:
        try:
            data = json.load(fh)
        except json.JSONDecodeError as exc:
            raise PlanError(f"{path}: not valid JSON: {exc}") from exc
    if not isinstance(data, dict) or not isinstance(data.get("accounts"), list):
        raise PlanError(f"{path}: expected an object with an 'accounts' list")
    return data


def plan_from_db(db_path: str) -> dict:
    """Build a routing plan from the portal's SQLite database.

    Reads the account's numbers (``phone_numbers.did`` -> ``users``) and, when
    the portal has recorded entitlement checks, their add-on state. Both the
    add-on table and each account's chosen agent are optional: absent means "no
    Capstone handoff" and "default agent" respectively — never a guess.
    """
    if not os.path.exists(db_path):
        raise PlanError(f"portal database not found: {db_path}")

    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    try:
        tables = {
            r["name"]
            for r in con.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            ).fetchall()
        }
        if "phone_numbers" not in tables:
            raise PlanError(f"{db_path}: no phone_numbers table — wrong database?")

        addons: dict[str, dict] = {}
        if "account_addons" in tables:
            for row in con.execute(
                "SELECT user_id, addon, entitled FROM account_addons"
            ).fetchall():
                addons.setdefault(row["user_id"], {})[row["addon"]] = bool(
                    row["entitled"]
                )

        agents: dict[str, str] = {}
        if "voice_agents" in tables:
            for row in con.execute(
                "SELECT user_id, agent_slug FROM voice_agents"
            ).fetchall():
                if row["agent_slug"]:
                    agents[row["user_id"]] = row["agent_slug"]

        accounts = []
        for row in con.execute(
            "SELECT user_id, did FROM phone_numbers WHERE status = 'active' "
            "ORDER BY did"
        ).fetchall():
            user_addons = addons.get(row["user_id"], {})
            accounts.append(
                {
                    "did": row["did"],
                    "agent": agents.get(row["user_id"]),
                    "capstone_addon": bool(user_addons.get("capstone")),
                }
            )
        return {"accounts": accounts}
    finally:
        con.close()


def validate(plan: dict) -> list[dict]:
    """Validate and normalize a plan into renderable account records."""
    accounts: list[dict] = []
    seen: set[str] = set()

    for idx, raw in enumerate(plan.get("accounts", [])):
        if not isinstance(raw, dict):
            raise PlanError(f"accounts[{idx}] is not an object")

        did = _normalize_did(raw.get("did"))
        if did in seen:
            # Two owners for one DID would make the route depend on row order.
            raise PlanError(f"duplicate DID in plan: {did}")
        seen.add(did)

        agent = raw.get("agent") or DEFAULT_AGENT
        if not AGENT_SLUG_RE.match(str(agent)):
            raise PlanError(
                f"accounts[{idx}] (DID {did}): agent {agent!r} is not a valid "
                "agent slug ([a-z0-9], max 64)"
            )

        record = {
            "did": did,
            "agent": str(agent),
            # Fail closed: anything other than an explicit truthy value is off.
            "capstone_addon": raw.get("capstone_addon") is True,
        }

        provider = raw.get("provider")
        if provider:
            if not SAFE_TOKEN_RE.match(str(provider)):
                raise PlanError(f"DID {did}: unsafe provider name {provider!r}")
            record["provider"] = str(provider)

        profile = raw.get("audio_profile")
        if profile:
            if not SAFE_TOKEN_RE.match(str(profile)):
                raise PlanError(f"DID {did}: unsafe audio profile {profile!r}")
            record["audio_profile"] = str(profile)

        accounts.append(record)

    return accounts


def render(accounts: list[dict]) -> str:
    """Render the validated accounts as the [zeus-ai-accounts] fragment."""
    lines = [
        f"[{CONTEXT}]",
        "; GENERATED by pbx/ava_routing.py — do not hand-edit.",
        "; One entry per active DID. The router (zeus-ai-router) dispatches",
        "; here by ${FROM_DID}; ZEUS_CAPSTONE_ADDON gates the Capstone handoff",
        "; in [zeus-ai-handoff], and is written ONLY for entitled accounts.",
        "; Accounts with no agent fall through to the operator (exten below).",
    ]

    for acct in accounts:
        did = acct["did"]
        lines.append(f"exten => {did},1,NoOp(Zeus AI account route for ${{FROM_DID}})")
        if "provider" in acct:
            lines.append(f" same => n,Set(AI_PROVIDER={acct['provider']})")
        if "audio_profile" in acct:
            lines.append(f" same => n,Set(AI_AUDIO_PROFILE={acct['audio_profile']})")
        lines.append(f" same => n,Set(AI_AGENT={acct['agent']})")
        if acct["capstone_addon"]:
            lines.append(" same => n,Set(ZEUS_CAPSTONE_ADDON=1)")
        else:
            # Explicit 0 rather than leaving it unset: the channel may carry a
            # stale value from a transferred call, and the handoff gate reads
            # it as a string.
            lines.append(" same => n,Set(ZEUS_CAPSTONE_ADDON=0)")
        lines.append(" same => n,Goto(zeus-ai-first-response,s,1)")

    # Unmatched DIDs (an account with no active number, or a DID added in
    # FreePBX only) still get answered: the operator, not a guessed agent.
    lines += [
        "; Fallback for a DID with no account on this platform.",
        f"exten => {DEFAULT_AGENT},1,NoOp(Zeus AI router fallback for ${{FROM_DID}})",
        f" same => n,Set(AI_AGENT={DEFAULT_AGENT})",
        " same => n,Set(ZEUS_CAPSTONE_ADDON=0)",
        " same => n,Goto(zeus-ai-first-response,s,1)",
    ]
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Render the [zeus-ai-accounts] AVA routing fragment.",
    )
    src = parser.add_mutually_exclusive_group(required=True)
    src.add_argument("--accounts-json", help="routing plan JSON (portal export)")
    src.add_argument("--db", help="portal SQLite database to read accounts from")
    parser.add_argument("--out", help="write here instead of stdout")
    parser.add_argument(
        "--check",
        action="store_true",
        help="compare against --out and exit 1 when it would change (no write)",
    )
    args = parser.parse_args(argv)

    try:
        plan = load_plan(args.accounts_json) if args.accounts_json else plan_from_db(args.db)
        accounts = validate(plan)
    except PlanError as exc:
        print(f"ava_routing: {exc}", file=sys.stderr)
        return 1

    rendered = render(accounts)

    if args.check:
        if not args.out:
            parser.error("--check requires --out")
        if not os.path.exists(args.out):
            print(f"ava_routing: {args.out} does not exist", file=sys.stderr)
            return 1
        with open(args.out, "r", encoding="utf-8") as fh:
            current = fh.read()
        if current != rendered:
            print(f"ava_routing: {args.out} is out of date", file=sys.stderr)
            return 1
        return 0

    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(rendered)
    else:
        sys.stdout.write(rendered)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
