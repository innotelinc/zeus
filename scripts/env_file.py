#!/usr/bin/env python3
"""scripts/env_file.py — read and upsert a single key in a KEY=VALUE env file.

The deploy path writes one secret into `.env` (the AVA admin password, after it
is rotated) and reads several out. A `.env` here is a 300-line file an operator
has curated by hand, and the failure modes of editing it with a `sed -i`
one-liner are all the bad kind: a value containing the delimiter rewrites an
unrelated key, a value containing a newline splits one key into two, and a
trailing newline that goes missing silently joins two keys together on the next
line. So the write is done once, here, with the whole file in hand and an
atomic replace, and the two callers stay shell.

Values are written verbatim apart from the newline refusal below — no quoting —
which is what Compose expects from a `.env`.

Usage:
    python3 scripts/env_file.py get FILE KEY            # prints the value, empty if unset
    python3 scripts/env_file.py set FILE KEY [VALUE]    # upsert (VALUE omitted: read stdin)

`set` prints nothing on success. Exit 2 is a usage/refusal error, so a caller
can tell "the write did not happen" from "the key is empty".
"""
import os
import re
import sys
import tempfile

KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


class Refused(Exception):
    """The write would have damaged the file, so it did not happen."""


def read_key(text: str, key: str) -> str | None:
    """The value of KEY, or None when the file does not set it.

    Last occurrence wins, matching how Compose resolves a duplicated key.
    """
    found = None
    for line in text.splitlines():
        if line.startswith(f"{key}="):
            found = _clean(line[len(key) + 1:])
    return found


def _clean(raw: str) -> str:
    """A value as Compose reads it: trailing comment off, surrounding quotes off.

    The comment goes first: `K="abc"  # note` is a quoted value followed by a
    comment, and stripping quotes before the comment would leave them on.
    An inline comment is only a comment after whitespace — a '#' inside a value
    (a password, a URL fragment) is part of the value.
    """
    value = re.split(r"\s+#", raw.strip(), maxsplit=1)[0].strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        return value[1:-1]
    return value


def upsert(text: str, key: str, value: str) -> str:
    """`text` with KEY set to `value`, every other line untouched.

    A duplicated KEY collapses to one line: two lines would leave the effective
    value to Compose's last-wins rule, which is not something an operator
    reading the file can see.
    """
    if not KEY_RE.match(key):
        raise Refused(f"not a valid env key: {key!r}")
    if "\n" in value or "\r" in value:
        raise Refused(f"refusing a newline in the value of {key}: it would split the line")

    out: list[str] = []
    replaced = False
    for line in text.split("\n"):
        if line.startswith(f"{key}="):
            # Rewrite the first occurrence where it stands — the key stays in
            # whatever section the operator put it in — and drop any later ones.
            if not replaced:
                out.append(f"{key}={value}")
                replaced = True
            continue
        out.append(line)
    while out and out[-1] == "":
        out.pop()
    if not replaced:
        out.append(f"{key}={value}")
    return "\n".join(out) + "\n"


def write_atomic(path: str, text: str) -> None:
    """Replace `path` in one step, so a failure cannot leave a half-written .env."""
    directory = os.path.dirname(os.path.abspath(path)) or "."
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".env-file-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(text)
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def main(argv: list[str]) -> int:
    if len(argv) < 3:
        print(__doc__.strip().splitlines()[-2:][0], file=sys.stderr)
        return 2
    verb, path, key = argv[1], argv[2], argv[3] if len(argv) > 3 else ""
    if verb == "get":
        if not key:
            return 2
        try:
            with open(path, "r", encoding="utf-8") as fh:
                text = fh.read()
        except FileNotFoundError:
            text = ""
        print(read_key(text, key) or "")
        return 0
    if verb == "set":
        if not key:
            return 2
        value = argv[4] if len(argv) > 4 else sys.stdin.read().strip("\n")
        try:
            with open(path, "r", encoding="utf-8") as fh:
                text = fh.read()
        except FileNotFoundError:
            text = ""
        try:
            write_atomic(path, upsert(text, key, value))
        except Refused as exc:
            print(f"env_file: {exc}", file=sys.stderr)
            return 2
        return 0
    print(f"env_file: unknown verb {verb!r} (get|set)", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
