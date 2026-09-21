#!/usr/bin/env python3
"""pbx/ava_ari_check.py — do the engine and the PBX share one ARI secret?

AVA authenticates to Asterisk as its own ARI user, and the two halves of that
credential are written by different things on the same host:

  * `scripts/pbx.env` -> pbx/bootstrap-zeus-pbx.sh, which renders it into
    `ari.conf` as the password Asterisk will accept;
  * `.env` -> docker-compose.yml, which hands it to the ai-engine container.

Nothing reconciles them. A blank `AVA_ARI_SECRET` in pbx.env is *not* blank for
long: the bootstrap generates a fresh one on every run, so the PBX ends up
accepting a password the engine has never seen. The engine then retries ARI
forever and the only symptom is that calls are not answered — no error names
the credential, because from Asterisk's side an unknown password is just a
failed login. That is what this check exists to catch before a call does.

Exit status:
    0 — the two agree, or there is nothing on this host to compare
    1 — they disagree (including "one side sets it and the other does not")

Run:  python3 pbx/ava_ari_check.py [--engine-env .env] [--pbx-env scripts/pbx.env]
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scripts"))
from env_file import read_key  # noqa: E402

KEY = "AVA_ARI_SECRET"


def _read(path: str):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return fh.read()
    except FileNotFoundError:
        return None


def verdict(engine_env: str, pbx_env: str) -> tuple[bool, str]:
    """(agreed, message). Pure, so the contract can be tested without a PBX."""
    engine_text = _read(engine_env)
    pbx_text = _read(pbx_env)
    engine = read_key(engine_text, KEY) if engine_text is not None else None
    pbx = read_key(pbx_text, KEY) if pbx_text is not None else None

    # No engine environment on this host: the voice plane does not run here, so
    # there is no second half to disagree with.
    if engine_text is None:
        return True, f"{engine_env} is absent — not a voice host, nothing to compare"
    if not engine:
        return (
            True,
            f"{KEY} is unset in {engine_env}; the engine has no ARI credential to check",
        )

    if pbx_text is None:
        return False, (
            f"{pbx_env} does not exist, but {engine_env} sets {KEY}. The bootstrap reads that "
            f"file for the password it renders into ari.conf and generates a fresh one per run "
            f"when it is blank, so the engine's credential would never match. Create {pbx_env} "
            f"from scripts/pbx.env.example (or copy the other checkouts') and set the same value."
        )
    if not pbx:
        return False, (
            f"{KEY} is set in {engine_env} but empty in {pbx_env}. The bootstrap regenerates a "
            f"blank one on every run, so ari.conf will not accept the engine's password. Set the "
            f"same value in both (grep {KEY} {engine_env} {pbx_env})."
        )
    if engine != pbx:
        return False, (
            f"{KEY} differs between {engine_env} and {pbx_env}: the engine would authenticate with "
            f"a password ari.conf does not accept, which shows up only as calls that are never "
            f"answered. Make them the same value."
        )
    return True, f"{KEY} agrees across {engine_env} and {pbx_env}"


def main(argv: list[str]) -> int:
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.dirname(here)
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--engine-env", default=os.path.join(root, ".env"))
    ap.add_argument("--pbx-env", default=os.path.join(root, "scripts", "pbx.env"))
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args(argv[1:])

    agreed, message = verdict(args.engine_env, args.pbx_env)
    if not agreed:
        print(f"ava-ari-check: {message}", file=sys.stderr)
        return 1
    if not args.quiet:
        print(f"ava-ari-check: {message}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
