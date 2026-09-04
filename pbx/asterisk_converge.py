#!/usr/bin/env python3
"""pbx/asterisk_converge.py — per-context merge for the shared voice plane.

Both Zeus and Capstone contribute dialplan contexts to ONE FreePBX
`/etc/asterisk/extensions_custom.conf`. A wholesale `cp` (or a naive
last-writer-wins merge) silently drops the other product's contexts, so this
tool is the single renderer that owns that file.

Ownership policies (per context name):

  replace (default)
      The source fragment is canonical for the context. The target's copy of
      that context (and the comment run attached above it) is replaced in
      place with the source's. Contexts the source does not define are left
      untouched — other products' contexts survive.

  append-shared
      Used for contexts several products legitimately extend (FreePBX's
      generated `[from-internal-custom]`, which both products add dialable
      extensions / includes to). The context itself is never replaced; the
      source's body is appended inside it, wrapped in ownership markers so a
      later run of the same owner replaces only its own segment:
          ; >>> begin <owner>
          ...source lines...
          ; >>> end <owner>

Marker ownership keeps every product idempotent without any product being
able to clobber another's lines.

Usage:
  asterisk_converge.py --target <file> --source <file> --owner <name>
      [--append <context> ...] [--check]

  --check   compare instead of writing; exit 1 when the merge would change
            the target (drift detection for the reconcile timers).

Both `--source` fragments and one `--target` can be combined into a single
converge run (apply Zeus then Capstone): pass --source multiple times.
"""
from __future__ import annotations

import argparse
import os
import re
import sys
import tempfile

SECTION_RE = re.compile(r"^\s*\[([^\]]+)\]\s*(?:;.*)?$")
COMMENT_LINE_RE = re.compile(r"^\s*(?:;.*)?$")  # blank or comment-only line
MARKER_LINE_RE = re.compile(r"^\s*;\s*>>>\s*(?:begin|end)\s+\S+")
BEGIN_MARK = "; >>> begin {owner}"
END_MARK = "; >>> end {owner}"


# --------------------------------------------------------------------------
# parsing
# --------------------------------------------------------------------------

def split_blocks(text: str):
    """Split a config file into ordered blocks.

    Returns a list of:
      ("text", [lines])       — prelude content before the first context
      ("ctx", name, [lines])  — a section header line + its body

    A comment run directly above a section header belongs to that context
    (so replace swaps the source's own doc comment in with it) — the run is
    the *prefix* of the context it introduces, never the tail of the
    previous one.
    """
    lines = text.splitlines(keepends=True)
    hdrs = [i for i, ln in enumerate(lines) if SECTION_RE.match(ln)]
    if not hdrs:
        return [("text", lines)] if lines else []

    def comment_run_start(header_idx: int) -> int:
        """First line of the comment/blank run directly above a header."""
        j = header_idx - 1
        while j >= 0 and COMMENT_LINE_RE.match(lines[j]):
            j -= 1
        start = j + 1
        # attach only when the run is a genuine doc comment for the section:
        # it must carry a real ';' comment and contain no ownership markers
        # (an owner's '; >>> end <owner>' line is the tail of the *previous*
        # context's segment, never a prefix of the next one)
        has_comment = any(lines[k].lstrip().startswith(";") for k in range(start, header_idx))
        has_marker = any(MARKER_LINE_RE.match(lines[k]) for k in range(start, header_idx))
        if has_comment and not has_marker:
            return start
        return header_idx

    starts = {h: comment_run_start(h) for h in hdrs}
    blocks: list = []
    prelude = lines[:starts[hdrs[0]]]
    if prelude:
        blocks.append(("text", prelude))
    for i, h in enumerate(hdrs):
        name = SECTION_RE.match(lines[h]).group(1)
        end = starts[hdrs[i + 1]] if i + 1 < len(hdrs) else len(lines)
        blocks.append(("ctx", name, lines[starts[h]:end]))
    return blocks


def serialize(blocks) -> str:
    out: list[str] = []
    for blk in blocks:
        if blk[0] == "text":
            out.extend(blk[1])
        else:
            out.extend(blk[2])
    return "".join(out)


def _ensure_trailing_newline(block_lines: list[str]) -> list[str]:
    if block_lines and not block_lines[-1].endswith("\n"):
        block_lines = block_lines + ["\n"]
    return block_lines


# --------------------------------------------------------------------------
# merge
# --------------------------------------------------------------------------

def _source_contexts(source_text: str):
    """Return ordered {name: {"full": lines, "inner": lines}}.

    `full` is the whole context block (attributed comment prefix + header +
    body) — used when the product owns the context wholesale. `inner` is the
    body *after* the header, used for append-shared insertions so an owner's
    segment never re-declares the context header inside the shared one.
    """
    seen: dict[str, dict] = {}
    for kind, *rest in split_blocks(source_text):
        if kind != "ctx":
            continue
        name, full = rest
        if name in seen:
            continue
        hdr_idx = next((i for i, ln in enumerate(full)
                        if SECTION_RE.match(ln)), None)
        inner = full[hdr_idx + 1:] if hdr_idx is not None else []
        seen[name] = {
            "full": _ensure_trailing_newline(full),
            "inner": _ensure_trailing_newline(inner),
        }
    return seen


def _strip_owned_segment(body: list[str], owner: str) -> list[str]:
    """Remove an existing '; >>> begin owner ... ; >>> end owner' segment."""
    begin = BEGIN_MARK.format(owner=owner)
    end = END_MARK.format(owner=owner)
    out: list[str] = []
    skipping = False
    for line in body:
        stripped = line.strip()
        if not skipping and stripped == begin:
            skipping = True
            continue
        if skipping:
            if stripped == end:
                skipping = False
            continue
        out.append(line)
    return out


def _marked_segment(owner: str, body: list[str]) -> list[str]:
    seg = [BEGIN_MARK.format(owner=owner) + "\n"]
    seg.extend(body)
    if seg and seg[-1].endswith("\n"):
        seg.append(END_MARK.format(owner=owner) + "\n")
    else:
        seg.append("\n" + END_MARK.format(owner=owner) + "\n")
    return seg


def merge_into(target_text: str, source_text: str, owner: str,
               append_shared: set[str] | None = None) -> str:
    """Merge one product's fragment into the target config text."""
    append_shared = append_shared or set()
    blocks = split_blocks(target_text)
    src_ctxs = _source_contexts(source_text)
    if not src_ctxs:
        return target_text

    for name, src_ctx in src_ctxs.items():
        if name in append_shared:
            blocks = _append_shared(blocks, name, owner, src_ctx["inner"])
        else:
            blocks = _replace_context(blocks, name, src_ctx["full"])
    return serialize(blocks)


def _replace_context(blocks, name: str, src_body: list[str]) -> list:
    """Replace target's context `name` (and its attributed comment run) with
    the source body, in place. Append at EOF when absent."""
    idxs = [i for i, blk in enumerate(blocks) if blk[0] == "ctx" and blk[1] == name]
    if not idxs:
        blocks.append(("ctx", name, src_body))
        return blocks
    first = idxs[0]
    # absorb comment-only text blocks directly above the context
    if first > 0 and blocks[first - 1][0] == "text":
        above = blocks[first - 1][1]
        if all(COMMENT_LINE_RE.match(l) for l in above):
            del blocks[first - 1]
            first -= 1
    blocks[first] = ("ctx", name, src_body)
    # drop any duplicate definitions of the same context (later ones)
    for idx in sorted(idxs[1:], reverse=True):
        del blocks[idx]
    return blocks


def _append_shared(blocks, name: str, owner: str, src_body: list[str]) -> list:
    """Add the source body inside target context `name` under owner markers.
    Creates the context when absent; never touches other owners' lines."""
    idxs = [i for i, blk in enumerate(blocks) if blk[0] == "ctx" and blk[1] == name]
    marked = _marked_segment(owner, src_body)
    if not idxs:
        # create a bare context and fall through: the same normalization
        # below (separator blank + marked segment) keeps an empty-target
        # first apply byte-identical to every later apply
        blocks.append(("ctx", name, [name_block_header(name)]))
        idxs = [len(blocks) - 1]
    idx = idxs[0]
    blk_type, _, body = blocks[idx]
    body = _strip_owned_segment(body, owner)
    body = _collapse_blank_runs(body)
    if body and body[-1].strip() != "":  # blank-line separation from foreign content
        body.append("\n")
    body.extend(marked)
    blocks[idx] = (blk_type, name, body)
    return blocks


def _collapse_blank_runs(lines: list[str]) -> list[str]:
    """Collapse runs of blank lines to one, drop leading/trailing blanks."""
    out: list[str] = []
    for line in lines:
        if line.strip() == "":
            if out and out[-1].strip() == "":
                continue
            out.append("\n")
        else:
            out.append(line)
    while out and out[-1].strip() == "":
        out.pop()
    return out


def name_block_header(name: str) -> str:
    return f"[{name}]\n"


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--target", required=True, help="config file to converge")
    ap.add_argument("--source", required=True, action="append",
                    help="product fragment (repeatable: applied in order)")
    ap.add_argument("--owner", required=True,
                    help="owner tag used for append-shared markers (e.g. zeus)")
    ap.add_argument("--append", action="append", default=[],
                    help="context name to treat as shared (repeatable)")
    ap.add_argument("--check", action="store_true",
                    help="drift-check only: exit 1 if the merge would change the target")
    args = ap.parse_args(argv)

    with open(args.target, "r", encoding="utf-8", errors="replace") as fh:
        current = fh.read()
    merged = current
    for src in args.source:
        with open(src, "r", encoding="utf-8", errors="replace") as fh:
            merged = merge_into(merged, fh.read(), args.owner,
                                append_shared=set(args.append))

    if merged == current:
        print(f"asterisk-converge: {args.target} already in sync")
        return 0
    if args.check:
        print(f"asterisk-converge: drift in {args.target}", file=sys.stderr)
        return 1

    # atomic write, keep the file's permission bits
    st = os.stat(args.target)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(args.target) or ".",
                               prefix=".converge-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(merged)
        os.chmod(tmp, st.st_mode & 0o7777)
        os.replace(tmp, args.target)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    print(f"asterisk-converge: {args.target} converged (owner={args.owner})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
