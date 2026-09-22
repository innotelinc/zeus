#!/usr/bin/env python3
"""The voice preflight's mounts must reach everything its script imports.

`docker-compose.yml` gates the voice profile on the `voice-preflight` service,
and the engine waits on it with `condition: service_completed_successfully`. So
a gate that cannot *start* does not fail the check — it stops the engine from
starting at all, and the caller sees a voice plane that is simply absent.

That is what happened. The service mounted only `./pbx`, while
`pbx/ava_ari_check.py` reads the engine's `.env` through `scripts/env_file.py`
(`from env_file import read_key`) and inserts both its own directory and its
sibling `scripts/` onto `sys.path`. On a host those are the repo's `pbx/` and
`scripts/`; in a container that mounts `./pbx:/pbx` they are `/pbx` and
`/scripts`, and nothing mounted `/scripts`. The gate died of
`ModuleNotFoundError` before it could judge anything, and
`docker compose --profile voice up` left the engine at `Created`.

This derives the requirement from the script instead of restating the fix: it
reads the `sys.path.insert` calls and the imports out of
`pbx/ava_ari_check.py`, works out which paths that script would look in inside
the container, and asserts a mount covers each one with the module present. A
new import, a moved script, or a renamed mount is then caught the same way.

It parses the compose file as text rather than with a YAML loader on purpose:
`PyYAML` is not a dependency of this repo's Python (nothing else imports it),
and a test that pulls one in would fail in CI for the wrong reason.

Run:  python3 -m unittest discover -s scripts/tests -v
"""
import os
import posixpath
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
COMPOSE = os.path.join(REPO_ROOT, "docker-compose.yml")
SCRIPT = os.path.join(REPO_ROOT, "pbx", "ava_ari_check.py")

SERVICE = "voice-preflight"
ENGINE = "ai-engine"

# `  name:` at two spaces begins a service; anything at column 0 ends the file
# section. The block is everything between.
NEXT_SERVICE = re.compile(r"^  [a-z0-9-]+:\s*$")
TOP_LEVEL = re.compile(r"^[a-z]")
# `- ./host:/container[:ro|:rw]`, the only mount form these services use.
MOUNT = re.compile(r"^\s+- (\./[^\s:]+):(/[^\s:]+?)(?::(?:ro|rw))?\s*$")
ENTRYPOINT = re.compile(r"^\s+entrypoint:\s*\[(.+)\]\s*$", re.M)
INSERT = re.compile(r"sys\.path\.insert\(0,\s*(.+?)\)\s*$", re.M)
IMPORT = re.compile(r"^(?:from\s+([A-Za-z_][\w.]*)\s+import|import\s+([A-Za-z_][\w.]*))", re.M)


def service_block(text, name):
    """The compose text of one service, by indentation."""
    lines = text.splitlines()
    start = next(
        (
            i
            for i, line in enumerate(lines)
            if line == f"  {name}:"
        ),
        None,
    )
    if start is None:
        raise AssertionError(f"{name}: no such service in docker-compose.yml")
    block = [lines[start]]
    for line in lines[start + 1 :]:
        if NEXT_SERVICE.match(line) or TOP_LEVEL.match(line):
            break
        block.append(line)
    return "\n".join(block)


def mounts(block):
    """{container path: host path} for one service's volumes."""
    found = {}
    for line in block.splitlines():
        match = MOUNT.match(line)
        if match:
            host, container = match.group(1), match.group(2)
            found[posixpath.normpath(container)] = host
    return found


def entrypoint_script(block):
    """The .py path the entrypoint runs, as the container sees it."""
    match = ENTRYPOINT.search(block)
    if not match:
        raise AssertionError(f"{SERVICE}: no entrypoint")
    for token in re.findall(r"[^\s,\"']+", match.group(1)):
        if token.endswith(".py") and token.startswith("/"):
            return posixpath.normpath(token)
    raise AssertionError(f"{SERVICE}: entrypoint runs no script")


def lookups(script_text, script_dir):
    """The directories the script puts on sys.path, as the container sees them.

    Evaluated rather than hardcoded: each `sys.path.insert` mentioning
    `__file__` is resolved against the script's container directory, using the
    literal path parts it joins. That is what makes this a guard — the answer
    moves when the script moves.
    """
    dirs = set()
    for expr in INSERT.findall(script_text):
        if "__file__" not in expr:
            continue
        parts = re.findall(r'"([^"]*)"', expr)
        path = script_dir
        for part in parts:
            path = posixpath.normpath(posixpath.join(path, part))
        dirs.add(path)
    return dirs


def modules(script_text):
    """Modules the script imports that are not part of the standard library."""
    names = set()
    for package, plain in IMPORT.findall(script_text):
        name = (package or plain).split(".")[0]
        if name and name not in sys.stdlib_module_names:
            names.add(name)
    return names


class VoicePreflightMountsTest(unittest.TestCase):
    def setUp(self):
        with open(COMPOSE, encoding="utf-8") as fh:
            self.compose = fh.read()
        with open(SCRIPT, encoding="utf-8") as fh:
            self.script = fh.read()
        self.block = service_block(self.compose, SERVICE)
        self.mounts = mounts(self.block)

    def test_the_gate_sees_its_own_script(self):
        script = entrypoint_script(self.block)
        self.assertTrue(
            any(script == c or script.startswith(c + "/") for c in self.mounts),
            f"{script} is not covered by any mount: {sorted(self.mounts)}",
        )

    def test_every_imported_module_is_reachable_in_the_container(self):
        """The failure this file exists for: a mount that stops one import short.

        `from env_file import read_key` fails the whole gate, and the gate takes
        the engine with it, so the module has to be *inside* a mounted path —
        not merely mentioned.
        """
        script = entrypoint_script(self.block)
        script_dir = posixpath.dirname(script)
        needed = modules(self.script)
        self.assertTrue(needed, "no non-stdlib imports found — did the parse break?")

        for lookup in sorted(lookups(self.script, script_dir)):
            covered = [
                host
                for container, host in self.mounts.items()
                if lookup == container or lookup.startswith(container + "/")
            ]
            self.assertTrue(
                covered,
                f"{SCRIPT} looks in {lookup} inside the container, and no mount "
                f"provides it (mounts: {sorted(self.mounts)})",
            )
            # A module found in an earlier sys.path entry satisfies the import,
            # so only a lookup with nothing importable in it is a defect.
            if any(
                os.path.exists(os.path.join(REPO_ROOT, host.lstrip("./"), f"{m}.py"))
                for host in covered
                for m in needed
            ):
                return
        self.fail(
            f"none of the mounted lookups ({sorted(lookups(self.script, script_dir))}) "
            f"holds {sorted(needed)}"
        )

    def test_the_engine_actually_waits_on_the_gate(self):
        """A gate nothing depends on is not a gate."""
        engine = service_block(self.compose, ENGINE)
        self.assertIn(SERVICE, engine)
        self.assertIn("service_completed_successfully", engine)


if __name__ == "__main__":
    unittest.main()
