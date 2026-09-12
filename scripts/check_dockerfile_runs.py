#!/usr/bin/env python3
"""Syntax-check every RUN body in a Dockerfile, as BuildKit would run it.

Dockerfile shells fail in ways that are invisible on the page: a continuation
that drops a newline where one was needed, a function chained into an ``&&``
list, a heredoc body that gets parsed as code. Reviewing them by eye is how
this repo shipped an ``apt_retry`` chain that no shell would accept, and each
one surfaced only after a 45-90 minute image build.

This reconstructs each RUN instruction the way BuildKit hands it to the shell
— comment lines removed, continuations joined with the newline dropped, heredoc
bodies preserved verbatim — and runs the shell's own parser over it
(``sh -n``, or whichever shell a ``SHELL`` instruction selects). It checks
syntax, not semantics: it will not notice a swallowed exit status.

Usage:
    python3 scripts/check_dockerfile_runs.py                 # every tracked Dockerfile
    python3 scripts/check_dockerfile_runs.py Dockerfile.full # specific files
    python3 scripts/check_dockerfile_runs.py --list          # show what it found
    python3 scripts/check_dockerfile_runs.py --dump 12       # print body #12's text
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

# `<<`, `<<-`, with an optional quoted terminator: <<EOF, <<-EOF, <<'EOF', <<"EOF"
HEREDOC = re.compile(r"<<(-?)(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\2")
# Only the backslash and what follows it go: BuildKit keeps the space before
# it, so `RUN foo && \` + `    bar` really does reach the shell as `foo && `
# followed by the indentation (`foo &&     bar`).
CONTINUATION = re.compile(r"\\[ \t]*$")
SHELL_JSON = re.compile(r"^SHELL\s+(\[.*\])\s*$")


@dataclass
class RunBody:
    """One RUN instruction, reconstructed."""

    file: Path
    index: int          # 1-based, only counting RUNs in this file
    line: int           # line the instruction starts on (1-based)
    shell: list[str]    # the shell BuildKit would use for it
    text: str           # exactly what that shell receives
    problems: list[str] # defects only this layer can see (see below)


# `sh -n` cannot see these: a heredoc whose terminator is missing is a warning
# at runtime, not a parse error, and BuildKit has already swallowed the rest of
# the file into its body by then.


def _logical_lines(lines: list[str], start: int) -> tuple[list[str], int]:
    """Collect one instruction's lines, following continuations.

    Comment lines are dropped — BuildKit removes them, including between
    continuations. A trailing backslash is removed with its newline, which is
    why the pieces join with no separator: leading indentation is preserved,
    exactly as BuildKit passes it on.
    """
    parts: list[str] = []
    i = start
    while i < len(lines):
        line = lines[i]
        if line.lstrip().startswith("#"):
            i += 1
            continue
        m = CONTINUATION.search(line)
        parts.append(line[: m.start()] if m else line)
        i += 1
        if not m:
            break
    return parts, i


def _heredoc_words(text: str) -> list[tuple[str, bool]]:
    return [(m.group(3), bool(m.group(1))) for m in HEREDOC.finditer(text)]


def _consume_heredoc(
    lines: list[str], i: int, word: str, strip_tabs: bool
) -> tuple[str, int, bool]:
    """Body of one heredoc (terminator included), the next index, and whether
    the terminator was actually there."""
    body: list[str] = []
    terminated = False
    while i < len(lines):
        line = lines[i]
        body.append(line)
        i += 1
        check = line.lstrip("\t") if strip_tabs else line
        if check == word:
            terminated = True
            break
    return "\n" + "\n".join(body), i, terminated


def run_bodies(path: Path) -> list[RunBody]:
    """Every RUN instruction in ``path``, reconstructed for its shell."""
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    shell = ["/bin/sh", "-c"]
    out: list[RunBody] = []
    i = 0
    while i < len(lines):
        raw = lines[i]
        if not raw.strip() or raw.lstrip().startswith("#"):
            i += 1
            continue

        instr, nxt = _logical_lines(lines, i)
        text = "".join(instr)
        start_line = i + 1  # `i` still points at the instruction's first line
        i = nxt

        word_match = re.match(r"^(\w+)(?:\s+(.*))?$", text, re.S)
        name = word_match.group(1).upper() if word_match else ""

        if name == "SHELL":
            m = SHELL_JSON.match(text)
            if m:
                try:
                    import json

                    shell = json.loads(m.group(1))
                except ValueError:
                    pass
            continue
        if name != "RUN":
            continue

        body = text[4:] if text[:4].upper() == "RUN " else text[len("RUN"):]
        # A RUN's heredoc bodies follow the whole instruction, not the line the
        # opener appears on: BuildKit has already joined the continuations.
        problems: list[str] = []
        for word, strip_tabs in _heredoc_words(body):
            extra, i, terminated = _consume_heredoc(lines, i, word, strip_tabs)
            body += extra
            if not terminated:
                problems.append(
                    f"heredoc <<{word} is never terminated — BuildKit reads the "
                    "rest of the file as its body"
                )

        out.append(
            RunBody(
                file=path, index=len(out) + 1, line=start_line, shell=list(shell),
                text=body, problems=problems,
            )
        )
    return out


def check_body(body: RunBody) -> str | None:
    """Run the shell's parser over the body; return its error, or None."""
    if body.problems:
        return "; ".join(body.problems)
    shell = body.shell[0] if body.shell else "/bin/sh"
    if not Path(shell).exists():
        return None  # can't check what isn't installed (e.g. a non-sh SHELL)
    proc = subprocess.run(
        [shell, "-n"], input=body.text, text=True, capture_output=True
    )
    if proc.returncode == 0:
        return None
    detail = (proc.stderr or proc.stdout or "").strip()
    return detail or f"{shell} -n exited {proc.returncode}"


def dockerfiles(repo_root: Path, explicit: list[str]) -> list[Path]:
    """Explicit paths, else every Dockerfile git tracks (nested ones included)."""
    if explicit:
        return [Path(p) for p in explicit]
    try:
        listed = subprocess.run(
            ["git", "ls-files", "Dockerfile", "Dockerfile.*", "*/Dockerfile", "*/*/Dockerfile"],
            cwd=repo_root, text=True, capture_output=True, check=True,
        ).stdout.split()
    except (subprocess.CalledProcessError, FileNotFoundError):
        listed = [str(p.relative_to(repo_root)) for p in sorted(repo_root.glob("**/Dockerfile*"))]
    return [repo_root / p for p in listed if (repo_root / p).is_file()]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("files", nargs="*", help="Dockerfiles to check (default: all git-tracked)")
    ap.add_argument("--list", action="store_true", help="list the RUN bodies found and exit")
    ap.add_argument("--dump", type=int, metavar="N",
                    help="print body #N of the --list order and exit")
    args = ap.parse_args(argv)

    repo_root = Path(__file__).resolve().parent.parent
    targets = dockerfiles(repo_root, args.files)
    if not targets:
        print("no Dockerfiles found", file=sys.stderr)
        return 1

    # One running sequence across every file: a bare "RUN #10" is ambiguous
    # between Dockerfiles, which is exactly the trap this used to fall into.
    seq = total = fails = 0
    for path in targets:
        try:
            bodies = run_bodies(path)
        except OSError as exc:
            print(f"{path}: cannot read ({exc})", file=sys.stderr)
            fails += 1
            continue

        for b in bodies:
            seq += 1
            shown = path.relative_to(repo_root) if path.is_relative_to(repo_root) else path

            if args.dump is not None:
                if seq == args.dump:
                    print(f"--- {shown} RUN #{b.index} of that file (line {b.line}) ---")
                    print(b.text)
                    return 0
                continue

            if args.list:
                first = b.text.strip().splitlines()[0] if b.text.strip() else ""
                print(f"#{seq}\t{shown}:{b.line}\t{first[:70]}")
                continue

            total += 1
            err = check_body(b)
            if err:
                fails += 1
                print(f"{shown}: RUN #{b.index} (starts line {b.line}) does not parse:")
                for line in err.splitlines():
                    print(f"    {line}")

    if args.dump is not None:
        print(f"no RUN body #{args.dump} (there are {seq})", file=sys.stderr)
        return 1
    if args.list:
        return 0
    if fails:
        print(f"\n{fails} of {total} RUN bodies do not parse")
        return 1
    print(f"all {total} RUN bodies parse")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
