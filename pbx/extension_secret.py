#!/usr/bin/env python3
"""pbx/extension_secret.py — every stored secret must be the one the PBX renders.

A softphone registers as the PJSIP endpoint **FreePBX** owns
(`docs/voice-convergence.md` §11.5), so the credential that endpoint accepts is
the one FreePBX generated and copied into `pjsip.auth.conf` — not a value the
portal invented. `src/lib/pjsip-secret.ts` reads that rendered value per row and
`src/lib/extension-readiness.ts` shows the operator what to do about a
disagreement; this is the same judgement, fleet-wide and non-interactive, so an
estate with a broken line says so on its own rather than waiting for somebody to
open the Phone screen.

Two states cost a line its phone, and both are silent — the endpoint looks
configured, the trunk is up, and the only symptom is a softphone that will not
register:

  * **No stored secret.** A row the legacy portal merge adopted
    (`scripts/legacy_portal_merge.py` deliberately stores no invented
    credential) or a FreePBX-created extension the portal has just mirrored. The
    PBX renders one, so `Repair` adopts it.
  * **A secret the PBX does not render.** The row and the PBX disagree, so every
    REGISTER is a 401.

**One direction only**, like `pbx/extension_mirror.py`. Only the extensions the
PBX renders a credential for are judged: the fax service lines (`3291`–`3294`)
are IAX2 modems with no `[<ext>-auth]` section, and a portal row the PBX has no
credential for is not a phone that failed to register — it is not judged at all.
(This is the whole reason the judgement does not simply require a secret on every
row: that would be permanently red on the estate's own fax lines.)

**Read-only, and it never writes.** Adopting the PBX's secret is the portal's
`POST /api/phone/extensions/repair`; a tool that wrote one would be inventing the
credential the readiness row exists to report.

    # live PBX, read-only. Exit 0 in sync, 1 drift, 2 cannot tell.
    python3 pbx/extension_secret.py --db /var/lib/docker/volumes/zeus-portal-data/_data/pbx.db --check

    # off-host: judge a portal db against an auth file dumped from the PBX
    python3 pbx/extension_secret.py --db <portal.pbx.db> --auth-conf pjsip.auth.conf

Exit codes are the shape `pbx/dograh_routes.py` and `pbx/extension_mirror.py`
use, so a caller's habits stay valid: 1 means "a person converges this", 2 means
"no evidence", and neither is a pass.
"""
from __future__ import annotations

import argparse
import os
import sqlite3
import subprocess
import sys
from typing import Mapping

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pbx_db  # noqa: E402
from legacy_voice_migrate import parse_auth_conf  # noqa: E402

# The portal's mirror of FreePBX's own extension list.
PORTAL_QUERY = "SELECT extension_id, extension_secret FROM freepbx_extensions"

# The files that may render a `[<ext>-auth]` section, in the order they are read.
# The generated one first — authoritative when it exists — then the files an
# operator may have written one into by hand. Kept in step with
# `src/lib/pjsip-secret.ts`'s AUTH_FILES, because that is what the portal adopts
# from and the two must agree about which section is an extension's credential.
AUTH_FILES = (
    "pjsip.auth.conf",
    "pjsip.auth_custom.conf",
    "pjsip_custom.conf",
    "pjsip_custom_post.conf",
    "pjsip.endpoint_custom_post.conf",
)

# The kinds of finding. Kept as names rather than inline literals so the verdict
# wording and the tests cannot drift.
MISSING = "missing"              # the PBX renders a secret; the portal stores none
DIFFERS = "differs"              # both sides hold one, and they are not equal
UNREGISTERABLE = "unregisterable"  # neither side has one — nothing can register

DESCRIPTIONS = {
    MISSING: "no SIP secret stored — the PBX renders one, so Repair adopts it",
    DIFFERS: "the stored secret is not the one the PBX renders — every REGISTER is refused",
    UNREGISTERABLE: "no SIP secret stored and the PBX renders none — no softphone can register",
}


def _ext_key(extension: str) -> tuple[int, int, str]:
    """Digits sort numerically — `1001` before `12000`, not after — and anything
    else sorts after them, by name."""
    return (0, int(extension), "") if extension.isdigit() else (1, 0, extension)


def judge(portal: Mapping[str, str | None],
          rendered: Mapping[str, str]) -> list[tuple[str, str]]:
    """The disagreements, as `(extension, kind)` — pure, so the contract is
    testable with no PBX and no portal.

    Only the PBX's own credential is authoritative, so an extension the PBX
    renders none for is judged on the portal's value alone: a row with a secret
    is the portal's own endpoint and is fine, and a row with neither is a line
    nothing can register — reported, because it is a phone nobody can use.
    """
    findings: list[tuple[str, str]] = []
    for extension in sorted(portal, key=_ext_key):
        stored = portal[extension]
        pbx = rendered.get(extension)
        if pbx is None:
            if not stored:
                findings.append((extension, UNREGISTERABLE))
        elif not stored:
            findings.append((extension, MISSING))
        elif stored != pbx:
            findings.append((extension, DIFFERS))
    return findings


def describe(finding: tuple[str, str]) -> str:
    """One finding as the line an operator reads."""
    extension, kind = finding
    return f"{extension} ({DESCRIPTIONS[kind]})"


def portal_secrets(db_path: str) -> dict[str, str | None]:
    """The portal's stored extension secrets, from the portal's own record.

    Read-only, and a missing table raises rather than returning an empty mapping:
    an unread mirror reads as an estate where every secret is fine, and the one
    answer worse than "cannot tell" is a pass claimed over a table never read.
    """
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        return {
            str(row[0]).strip(): row[1]
            for row in con.execute(PORTAL_QUERY)
            if row[0] and str(row[0]).strip()
        }
    finally:
        con.close()


def rendered_secrets(texts: Mapping[str, str]) -> dict[str, str]:
    """Extension -> the secret the PBX renders, over the auth files in order.

    First file wins, as `pbxSecretFor` in `src/lib/pjsip-secret.ts` does: a value
    in the generated `pjsip.auth.conf` is authoritative, and a hand-written file
    only supplies a credential FreePBX does not render at all.
    """
    secrets: dict[str, str] = {}
    for name in AUTH_FILES:
        text = texts.get(name)
        if text is None:
            continue
        for extension, secret in parse_auth_conf(text).items():
            secrets.setdefault(extension, secret)
    return secrets


def _cat(container: str, path: str) -> str | None:
    proc = subprocess.run(
        ["docker", "exec", container, "cat", path],
        capture_output=True, text=True, timeout=30.0,
    )
    return proc.stdout if proc.returncode == 0 else None


def read_container_auth(container: str, directory: str) -> dict[str, str]:
    """The auth files as the PBX renders them, read out of the container.

    One `cat` per file rather than a tar of the tree: the set is small and fixed,
    and the order the files are read in is part of the judgement, which a single
    concatenated stream would lose.
    """
    texts: dict[str, str] = {}
    for name in AUTH_FILES:
        text = _cat(container, f"{directory.rstrip('/')}/{name}")
        if text is not None:
            texts[name] = text
    return texts


def read_local_auth(directory: str) -> dict[str, str]:
    """The same files from a directory this process can read — the PBX container
    itself, or bare metal."""
    texts: dict[str, str] = {}
    for name in AUTH_FILES:
        try:
            with open(os.path.join(directory, name), encoding="utf-8") as handle:
                texts[name] = handle.read()
        except OSError:
            continue
    return texts


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--db", help="the portal's SQLite database (pbx.db)")
    ap.add_argument("--auth-conf",
                    help="a rendered pjsip.auth.conf dumped from the PBX (off-host)")
    ap.add_argument("--asterisk-dir", default=os.environ.get("PJSIP_CONF_DIR"),
                    help="the PBX's config directory, read locally (default: the container)")
    ap.add_argument("--container", default=os.environ.get("PBX_CONTAINER", ""),
                    help="the FreePBX container to read (default: autodetect)")
    ap.add_argument("--check", action="store_true",
                    help="judge and exit 0/1/2 (this tool never writes)")
    args = ap.parse_args(argv)

    if not args.db:
        print("extension-secret: no --db given — there is no stored secret to judge",
              file=sys.stderr)
        return 2
    if not os.path.exists(args.db):
        print(f"extension-secret: {args.db} does not exist — cannot tell", file=sys.stderr)
        return 2
    try:
        portal = portal_secrets(args.db)
    except sqlite3.Error as exc:
        print(f"extension-secret: cannot read the portal's extensions from {args.db}: {exc}",
              file=sys.stderr)
        return 2
    if not portal:
        print(f"extension-secret: {args.db} names no extension — cannot judge", file=sys.stderr)
        return 2

    if args.auth_conf:
        try:
            with open(args.auth_conf, encoding="utf-8") as handle:
                rendered = rendered_secrets({os.path.basename(args.auth_conf): handle.read()})
        except OSError as exc:
            print(f"extension-secret: cannot read {args.auth_conf}: {exc}", file=sys.stderr)
            return 2
        source = args.auth_conf
    elif args.asterisk_dir:
        texts = read_local_auth(args.asterisk_dir)
        if not texts:
            print(f"extension-secret: no auth file under {args.asterisk_dir} — cannot tell",
                  file=sys.stderr)
            return 2
        rendered = rendered_secrets(texts)
        source = args.asterisk_dir
    else:
        container = pbx_db.resolve_container(args.container)
        if not container:
            print("extension-secret: no FreePBX container found — cannot tell", file=sys.stderr)
            return 2
        texts = read_container_auth(container, os.environ.get("PJSIP_CONF_DIR", "/etc/asterisk"))
        if not texts:
            print(f"extension-secret: no auth file could be read from {container} — cannot tell",
                  file=sys.stderr)
            return 2
        rendered = rendered_secrets(texts)
        source = container

    findings = judge(portal, rendered)
    print(f"extension-secret: judged {len(portal)} portal extension(s) and "
          f"{len(rendered)} rendered credential(s) from {source}")
    if not rendered:
        # The PBX renders nothing at all: either the config directory was empty
        # or the file set moved, and in both cases the disagreement this tool
        # reports would be entirely against a blank comparison. Refuse to judge.
        print(f"extension-secret: {source} renders no credential at all — cannot judge",
              file=sys.stderr)
        return 2
    for finding in findings:
        print(f"  {describe(finding)}", file=sys.stderr)
    if findings:
        print(
            f"extension-secret: {len(findings)} extension(s) whose stored secret is missing or "
            f"is not the one the PBX renders — its softphone cannot register. Run Repair for the "
            f"extension in the portal (it adopts the PBX's secret), or create the credential in "
            f"FreePBX if it renders none.",
            file=sys.stderr,
        )
        return 1
    print("extension-secret: every portal extension holds the secret the PBX renders")
    return 0


if __name__ == "__main__":
    sys.exit(main())
