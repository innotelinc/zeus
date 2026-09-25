#!/usr/bin/env python3
"""pbx/pjsip_owner_check.py — who owns the PJSIP endpoint for an extension?

## The endpoint decision (2026-09-25)

**FreePBX owns the endpoint, and the portal extends it.**
`src/lib/pjsip-endpoint.ts` appends `[<ext>](+)` — Asterisk's
append-to-existing-section syntax — plus the WebRTC media settings to
`pjsip.endpoint_custom_post.conf`, which FreePBX includes and never
regenerates. There is no `#include` for the portal to write and no second
`[<ext>]` to collide: the softphone registers as the same object the PBX routes
to and reports device state for, with the device secret FreePBX renders
(`src/lib/pjsip-secret.ts` reads it back out of `pjsip.auth.conf`).

The rejected alternative — a portal-owned endpoint under an id FreePBX will not
generate (`<ext>-webrtc`) — is recorded in
[docs/ava-capstone-convergence.md](../docs/ava-capstone-convergence.md) §11. It
loses because the rest of the PBX addresses `PJSIP/<ext>`: a second endpoint is
one that inbound routes, ring groups and the console's own device-state poll
cannot reach.

## What this tool still measures

The old shape is not gone from the estate, it is only no longer written. A box
provisioned before the decision still has `/etc/asterisk/pjsip_ext_<ext>.conf`
defining `[<ext>](webrtc-template)` — a **second object with FreePBX's id in the
same load tree**, the failure `pbx/README.md` documents for `ari.conf`, where one
duplicate makes sorcery refuse the whole file and *"costs every user"*. The old
shape also had to be made loadable by appending `#include pjsip_ext_<ext>.conf`
to a file, and an include in a file FreePBX regenerates is reverted at the next
Apply Config — so the fragment then sits on disk, entered by nothing, while the
portal still lists the extension as active.

The two defects cancel into silence: if the include is not currently loaded
(because a reload dropped it), the softphone never registers and no secret
works; if it *is* loaded, the duplicate object would take res_pjsip down with
it. Which state a given box is in is a measurement, not an assumption, and this
tool is it. A box that has migrated reports clean: the `[<ext>](+)` append is a
finding of its own, and it is deliberately untyped — `(+)` inherits nothing — so
it is never counted as a second endpoint.

It changes nothing — every probe is a read.

## What it answers

1. **The load tree.** `#include` edges are followed from `pjsip.conf`, so a
   definition is judged by whether Asterisk reads it, not by whether the file is
   on disk. A fragment nothing includes is reported as exactly that.
2. **Every definition of an object id, by type.** `[101]` legitimately appears
   in the generated `pjsip.endpoint.conf`, `pjsip.auth.conf` and
   `pjsip.aor.conf` — three object types, not a collision. A duplicate is the
   same *id and type* in two files, which is why template inheritance is
   resolved: the portal's `[<ext>](webrtc-template)` inherits `type=endpoint`
   from a template in another file, and string-matching the id cannot tell that
   case from the benign three-file one.
3. **Who carries the include.** An `#include` for a product fragment
   (`pjsip_ext_*.conf`, `pjsip_wss.conf`) in a FreePBX-generated file is the
   drift that eats it; the same include in an operator-owned file survives.
4. **What Asterisk actually loaded** — the endpoints, the WSS transport, and
   whether `res_pjsip` is running at all (the duplicate's fingerprint).

`--json` prints the raw measurements as well as the findings, so the decision
can be taken from the output without a second trip to the box.

Exit status, in the style of `d7_assert.py`:

    0 — measured, and no two-owner state was found
    1 — measured, and a two-owner state was found (a duplicate object id, a
        product include in a FreePBX-regenerated file, or a provisioned
        fragment that nothing loads)
    2 — nothing could be evaluated (no config dir, no container, no docker)

Run:
    python3 pbx/pjsip_owner_check.py --live                 # the box
    python3 pbx/pjsip_owner_check.py --live --extension 101
    python3 pbx/pjsip_owner_check.py --live --json          # paste this back
    python3 pbx/pjsip_owner_check.py --config-dir /etc/asterisk   # inside the PBX

Unit tests own the parsing and the verdict table
(pbx/tests/test_pjsip_owner_check.py); this file owns talking to the box.
"""
from __future__ import annotations

import argparse
import io
import json
import os
import re
import subprocess
import sys
import tarfile
from dataclasses import asdict, dataclass, replace

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

# The file res_pjsip is configured from. Everything Asterisk loads hangs off it.
ENTRY = "pjsip.conf"
DEFAULT_DIR = "/etc/asterisk"

# The transport/media fragment the full-stack entrypoint writes, and the
# per-extension fragment the portal writes. Both are only reachable through an
# `#include` somebody has to own.
WSS_TRANSPORT_FILE = "pjsip_wss.conf"
EXT_FRAGMENT_RE = re.compile(r"^pjsip_ext_(?P<ext>[A-Za-z0-9_.-]+)\.conf$")

# FreePBX stamps its generated files with this header. It is the primary
# evidence; the name list below is the fallback for a file that lost or never
# had it (a truncated write, an older image).
GENERATED_MARKER = re.compile(r"auto-generated by freepbx|do not edit this file", re.I)
GENERATED_NAMES = frozenset(
    {
        "pjsip.conf",
        "pjsip.endpoint.conf",
        "pjsip.auth.conf",
        "pjsip.aor.conf",
        "pjsip.registration.conf",
        "pjsip.identify.conf",
        "pjsip.transport.conf",
        "pjsip.transports.conf",
        "pjsip_additional.conf",
        "extensions.conf",
        "extensions_additional.conf",
        "sip.conf",
        "sip_additional.conf",
        "rtp.conf",
        "rtp_additional.conf",
    }
)

# `[101]`, `[101](webrtc-template)` and `[webrtc-template](!)` are all headers;
# the parenthesised tail is the template inherited from, and `!` marks the
# section as a template rather than an object. Dropping that tail is how a
# template looks untyped and a portal endpoint looks like it is not there.
SECTION_RE = re.compile(r"^\s*\[([^\]]+)\]\s*(?:\(([^)]*)\))?\s*(?:;.*)?$")
INCLUDE_RE = re.compile(r"^\s*#(?:try)?include\s+\"?<*([^\"\s;>]+)>?")
TYPE_RE = re.compile(r"^\s*type\s*=\s*(\S+)")
# The two fragments this repo writes that need an owner. A generated file
# carrying one of these is the drift; a `_custom` file carrying it is the shape
# that survives Apply Config.
PRODUCT_INCLUDE_RE = re.compile(r"^(?:pjsip_wss\.conf|pjsip_ext_[A-Za-z0-9_.-]+\.conf)$")

# `pjsip show endpoints` / `pjsip show transports` print a dotted column header
# before the objects, and the header lines match the object shape. Every real
# object id is dot-free, so the dots are the cheapest reliable discriminator.
HEADER_DOTS = "..."


# ── findings ────────────────────────────────────────────────────────────────
@dataclass(frozen=True)
class Finding:
    """One measurement. `ok is None` means it could not be evaluated."""

    ok: bool | None
    detail: str


@dataclass(frozen=True)
class Section:
    """One `[header]` and the two things that decide object identity."""

    id: str
    base: str | None  # `[101](webrtc-template)` -> "webrtc-template"
    template: bool  # `[x](!)` -> a template, not an object
    type: str | None  # an explicit `type =` inside the section
    line: int


@dataclass(frozen=True)
class ConfigFile:
    name: str
    sections: tuple[Section, ...]
    includes: tuple[str, ...]
    generated: bool = False  # FreePBX writes and rewrites this file
    ownership: str = "other"  # generated | custom | other


# ── parsing (pure, so the shapes can be tested without a PBX) ───────────────
def parse_config(name: str, text: str) -> ConfigFile:
    """Sections and `#include` edges of one Asterisk config file."""
    sections: list[Section] = []
    includes: list[str] = []

    for number, line in enumerate(text.splitlines(), start=1):
        match = INCLUDE_RE.match(line)
        if match:
            # Includes resolve relative to the config directory, so a path, a
            # quoted name and an angle-bracketed name all reduce to the
            # basename — `#include /etc/asterisk/pjsip_ext_101.conf` is the same
            # edge as the bare filename.
            includes.append(os.path.basename(match.group(1)))
            continue

        header = SECTION_RE.match(line)
        if header:
            base = header.group(2)
            sections.append(
                Section(
                    id=header.group(1).strip(),
                    base=base,
                    template=base == "!",
                    type=None,
                    line=number,
                )
            )
            continue

        if sections:
            found = TYPE_RE.match(line)
            # `type` belongs to the object the section opened. The first one
            # wins: a second `type` in the same body is a malformed section, not
            # a second object, and silently taking the last would let a
            # duplicate hide behind it.
            if found and sections[-1].type is None:
                last = sections[-1]
                sections[-1] = replace(last, type=found.group(1))

    return ConfigFile(name=name, sections=tuple(sections), includes=tuple(includes))


def is_generated(name: str, text: str) -> bool:
    """Is this a file FreePBX writes and therefore rewrites?

    Two signals, either sufficient: the generated header, or a name FreePBX
    writes wholesale. `pjsip_custom*.conf` and friends never match, which is the
    whole point of the convention.
    """
    return bool(GENERATED_MARKER.search(text)) or name in GENERATED_NAMES


def ownership(name: str, text: str) -> str:
    """`generated` | `custom` | `other`.

    `custom` is the operator-owned convention (`*_custom.conf`,
    `*_custom_post.conf`); `other` is everything else — a product fragment, or a
    file this rule has no opinion about. Only `generated` is a defect as an
    include carrier, but all three labels are reported so the output is not read
    as a binary.
    """
    if is_generated(name, text):
        return "generated"
    stem = name[: -len(".conf")] if name.endswith(".conf") else name
    if stem.endswith("_custom") or stem.endswith("_custom_post"):
        return "custom"
    return "other"


def load_files(raw: dict[str, str]) -> dict[str, ConfigFile]:
    """Parse `{name: text}` into ConfigFiles, classified for ownership."""
    files: dict[str, ConfigFile] = {}
    for name, text in raw.items():
        cfg = parse_config(name, text)
        files[name] = replace(
            cfg,
            generated=is_generated(name, text),
            ownership=ownership(name, text),
        )
    return files


def include_closure(files: dict[str, ConfigFile], entry: str = ENTRY) -> list[str]:
    """The files Asterisk loads starting at `entry`, in order.

    Breadth-first over `#include`, cycle-safe — a re-included file is a real
    FreePBX artefact, not a hypothetical. Includes naming a file that is not in
    `files` are reported by `missing_includes` rather than dropped: a fragment
    that is included but absent is a different fault from one that is present
    but not included, and this check must not conflate them.
    """
    if entry not in files:
        return []
    order: list[str] = []
    seen: set[str] = set()
    queue = [entry]
    while queue:
        name = queue.pop(0)
        if name in seen:
            continue
        seen.add(name)
        order.append(name)
        # Only files that exist are loaded: an include naming an absent file is
        # `missing_includes`'s finding, and folding it in here would report a
        # fragment as "not loaded" when the truth is that its carrier is gone.
        queue.extend(
            target for target in files[name].includes if target in files and target not in seen
        )
    return order


def missing_includes(files: dict[str, ConfigFile]) -> list[tuple[str, str]]:
    """(carrier, target) for every include naming a file that is not here."""
    return [
        (name, target)
        for name, cfg in sorted(files.items())
        for target in cfg.includes
        if target not in files
    ]


def templates_of(files: dict[str, ConfigFile]) -> dict[str, Section]:
    """Every template (`[x](!)`) by id, first definition winning."""
    found: dict[str, Section] = {}
    for name in sorted(files):
        for section in files[name].sections:
            if section.template and section.id not in found:
                found[section.id] = section
    return found


def object_type(section: Section, templates: dict[str, Section]) -> str | None:
    """The `type` a section ends up as, following template inheritance.

    FreePBX generates `[101]` in `pjsip.endpoint.conf`, `pjsip.auth.conf` and
    `pjsip.aor.conf` — three objects sharing an id, and *not* a collision. The
    portal's `[<ext>](webrtc-template)` inherits `type=endpoint` from a template
    in another file, which is why one hop is included: a section that only
    documents `type=endpoint` directly would make the portal's fragment look
    untyped, and an untyped section cannot be compared with anything.
    """
    seen: set[str] = set()
    current: Section | None = section
    while current is not None:
        if current.type is not None:
            return current.type
        base = current.base
        if base is None or base == "!" or base in seen:
            return None
        seen.add(base)
        current = templates.get(base)
    return None


def definitions(
    files: dict[str, ConfigFile], names: list[str] | None = None
) -> dict[tuple[str, str], list[tuple[str, int]]]:
    """{(id, type): [(file, line), …]} for every non-template object.

    Keyed by id *and* type: the same id in three generated files is three
    objects, and only a repeated (id, type) pair is the duplicate that makes
    sorcery refuse the file.
    """
    templates = templates_of(files)
    found: dict[tuple[str, str], list[tuple[str, int]]] = {}
    for name in names if names is not None else sorted(files):
        for section in files[name].sections:
            if section.template:
                continue
            # "?" rather than a guess: an id whose type cannot be resolved is
            # still worth showing, but it cannot be compared with a typed object.
            kind = object_type(section, templates) or "?"
            found.setdefault((section.id, kind), []).append((name, section.line))
    return found


def include_carriers(files: dict[str, ConfigFile]) -> list[dict]:
    """Every `#include` of a product fragment, with the file that carries it.

    This is the measurement the decision rests on: an include for
    `pjsip_ext_*.conf` / `pjsip_wss.conf` living in a generated file is drift
    waiting for the next Apply Config; the same include in a `_custom` file is
    the shape that survives.
    """
    rows: list[dict] = []
    for name in sorted(files):
        for target in files[name].includes:
            if not PRODUCT_INCLUDE_RE.match(target):
                continue
            rows.append(
                {
                    "carrier": name,
                    "carrier_ownership": files[name].ownership,
                    "target": target,
                    "missing": target not in files,
                }
            )
    return rows


# ── verdicts (pure) ─────────────────────────────────────────────────────────
def verdict_endpoint(
    ext: str,
    files: dict[str, ConfigFile],
    closure: list[str],
    loaded: dict[tuple[str, str], list[tuple[str, int]]],
) -> list[Finding]:
    """Who answers for `<ext>`, and does Asterisk load it.

    Two questions, reported separately on purpose. Whether *an* endpoint exists
    and whether the **portal's** fragment is the one being loaded are different
    facts, and the interesting state has opposite answers: FreePBX's generated
    endpoint is loaded (so calls work) while the fragment the portal handed a
    secret for is inert (so no softphone can register). A check that stopped at
    "the endpoint exists" would report that box as healthy.
    """
    fragment = f"pjsip_ext_{ext}.conf"
    appended = portal_appends(files, ext)
    in_tree = set(closure)
    endpoint_defs = [
        (name, line)
        for (ident, kind), places in loaded.items()
        if ident == ext and kind == "endpoint"
        for name, line in places
    ]
    loaded_defs = [place for place in endpoint_defs if place[0] in in_tree]
    ours_loaded = any(name == fragment for name, _ in loaded_defs)

    findings: list[Finding] = []
    if len(loaded_defs) > 1:
        where = ", ".join(f"{name}:{line}" for name, line in loaded_defs)
        findings.append(
            Finding(
                False,
                f"[{ext}] endpoint is defined {len(loaded_defs)} times in the load tree "
                f"({where}) — a duplicate object id makes res_pjsip refuse the whole "
                f"pjsip configuration, which takes every endpoint with it (the ari.conf "
                f"duplicate failure, applied to the voice plane)",
            )
        )
    elif loaded_defs:
        name, line = loaded_defs[0]
        findings.append(
            Finding(
                True,
                f"[{ext}] endpoint is defined once in the load tree: {name}:{line} "
                f"({files[name].ownership if name in files else '?'})",
            )
        )
        if appended:
            findings.append(
                Finding(
                    True,
                    f"{appended} carries [{ext}](+), which extends that endpoint with "
                    f"WebRTC media instead of defining a second object — the endpoint "
                    f"decision (docs/ava-capstone-convergence.md §11)",
                )
            )
    elif endpoint_defs:
        where = ", ".join(f"{name}:{line}" for name, line in endpoint_defs)
        findings.append(
            Finding(
                False,
                f"[{ext}] endpoint is defined in {where}, and nothing in the {ENTRY} "
                f"include tree loads it — Asterisk has no such endpoint at all",
            )
        )
    else:
        if appended:
            findings.append(
                Finding(
                    False,
                    f"{appended} carries [{ext}](+), which appends to the endpoint FreePBX "
                    f"generates for [{ext}] — but no [{ext}] endpoint exists in the {ENTRY} "
                    f"include tree, so the append has nothing to extend and a softphone "
                    f"still has no WebRTC endpoint to register against",
                )
            )
        else:
            findings.append(
                Finding(None, f"no [{ext}] endpoint anywhere on this PBX (nothing to judge)")
            )

    # The portal's own claim about this extension, judged on its own.
    if fragment in files and fragment in in_tree and not ours_loaded:
        findings.append(
            Finding(
                False,
                f"{fragment} is loaded but defines no [{ext}] endpoint — the fragment and "
                f"the extension it was written for disagree, so the secret the portal "
                f"handed out cannot be the one Asterisk authenticates against",
            )
        )
    elif fragment in files and fragment not in in_tree and loaded_defs:
        owner = loaded_defs[0][0]
        findings.append(
            Finding(
                False,
                f"{fragment} is on this PBX and nothing includes it, so every secret the "
                f"portal issued for [{ext}] is inert; Asterisk answers [{ext}] from "
                f"{owner} instead",
            )
        )
    return findings


def verdict_includes(rows: list[dict]) -> list[Finding]:
    """Product includes must be carried by a file FreePBX does not rewrite."""
    if not rows:
        return [
            Finding(
                None,
                "no product `#include` found for pjsip_ext_*.conf / pjsip_wss.conf — "
                "the portal (or the entrypoint) has provisioned none here",
            )
        ]

    findings: list[Finding] = []
    for row in rows:
        carrier = f"{row['carrier']} (ownership: {row['carrier_ownership']})"
        if row["carrier_ownership"] == "generated":
            findings.append(
                Finding(
                    False,
                    f"the `#include {row['target']}` lives in {carrier}, which FreePBX "
                    f"rewrites on Apply Config — the include, and the object it loads, "
                    f"disappear the first time anyone opens the GUI, and nothing reports "
                    f"it",
                )
            )
        else:
            findings.append(
                Finding(
                    True,
                    f"the `#include {row['target']}` is carried by {carrier}, which "
                    f"survives Apply Config"
                    + (" — but the target is MISSING" if row["missing"] else ""),
                )
            )
    return findings


def parse_endpoints(text: str) -> set[str]:
    """Endpoint ids from `asterisk -rx "pjsip show endpoints"`.

    Objects print as `Endpoint:  <101/101>  <state>`, so the id is the token
    before the slash. The dotted column header matches the same shape and is
    dropped by the dot test — the one thing that distinguishes a header from a
    real id here.
    """
    found: set[str] = set()
    for line in text.splitlines():
        if HEADER_DOTS in line:
            continue
        match = re.match(r"\s*Endpoint:\s*<?([^/>\s]+)", line)
        if match:
            found.add(match.group(1))
    return found


def parse_transports(text: str) -> set[str]:
    """Transport names from `asterisk -rx "pjsip show transports"`.

    The objects here are printed *without* the angle brackets the column header
    uses (`Transport:  transport-wss  wss  0  0`), which is the opposite of
    `pjsip show endpoints` — so both forms are accepted rather than one being
    assumed and the other silently parsing as nothing.
    """
    return set(parse_transport_types(text))


def parse_transport_types(text: str) -> dict[str, str]:
    """Transport id → protocol from ``pjsip show transports``.

    A transport's id is not stable across owners. The hand-written fragment
    uses ``transport-wss``; FreePBX 17 generates ``0.0.0.0-wss`` for the same
    live listener. The protocol column is therefore the fact that answers
    "is WSS loaded?", while the id remains the thing an operator needs in the
    diagnostic.
    """
    found: dict[str, str] = {}
    for line in text.splitlines():
        if HEADER_DOTS in line:
            continue
        match = re.match(r"\s*Transport:\s*<?([^/>\s]+)>?\s+(\S+)", line)
        if match:
            found[match.group(1)] = match.group(2)
    return found


def parse_module_state(text: str) -> bool | None:
    """Is res_pjsip running, from `module show like res_pjsip`? None if absent."""
    for line in text.splitlines():
        if "res_pjsip.so" in line:
            return "not running" not in line.lower()
    return None


def verdict_asterisk(
    endpoints: set[str] | None,
    transports: set[str] | None,
    running: bool | None,
    ext: str = "",
    wanted_transport: str = "transport-wss",
    transport_types: dict[str, str] | None = None,
) -> list[Finding]:
    findings: list[Finding] = []

    if running is None:
        findings.append(Finding(None, "res_pjsip.so is not in the module list"))
    else:
        findings.append(
            Finding(
                running,
                f"res_pjsip is {'running' if running else 'NOT running'}"
                + (
                    ""
                    if running
                    else " — a rejected pjsip configuration (a duplicate object id is "
                    "the usual cause) leaves Asterisk with no PJSIP at all"
                ),
            )
        )

    if transports is None:
        findings.append(Finding(None, "cannot list PJSIP transports"))
    else:
        listed = ", ".join(sorted(transports)) or "none"
        wss_ids = sorted(
            name
            for name, protocol in (transport_types or {}).items()
            if protocol.casefold() == "wss"
        )
        wss_loaded = wanted_transport in transports or bool(wss_ids)
        if wanted_transport in transports:
            detail = f"the {wanted_transport} transport is loaded (transports: {listed})"
        elif wss_ids:
            detail = (
                f"a WSS transport is loaded (id: {', '.join(wss_ids)}; "
                f"transports: {listed})"
            )
        else:
            detail = (
                f"the {wanted_transport} transport is NOT loaded (transports: "
                f"{listed}) — every WebRTC softphone fails at registration, and "
                f"{WSS_TRANSPORT_FILE} having no surviving include is the usual reason"
            )
        findings.append(Finding(wss_loaded, detail))

    if endpoints is None:
        findings.append(Finding(None, "cannot list PJSIP endpoints"))
    else:
        # Deliberately not a pass/fail: which endpoint answers is the question,
        # and an in-memory listing is the answer to it, not a verdict.
        which = f"; [{ext}] is among them" if ext and ext in endpoints else (
            f"; [{ext}] is not" if ext else ""
        )
        findings.append(
            Finding(None, f"Asterisk has {len(endpoints)} endpoint(s) loaded{which}")
        )
    return findings


# ── the box ─────────────────────────────────────────────────────────────────
def _run(cmd: list[str], timeout: float = 60.0) -> tuple[int, bytes]:
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=timeout, check=False)
    except FileNotFoundError:
        return 127, f"{cmd[0]}: not found".encode()
    except subprocess.TimeoutExpired:
        return 124, f"{' '.join(cmd)}: timed out after {timeout:g}s".encode()
    return proc.returncode, (proc.stdout or b"") + (proc.stderr or b"")


def find_pbx_container(explicit: str = "") -> str:
    """The FreePBX container, or "" when there is not exactly one to use.

    An explicit name wins outright: guessing past a typo would silently measure
    some other host's PBX and report it as this one's.
    """
    if explicit:
        return explicit
    code, out = _run(
        [
            "docker",
            "ps",
            "--filter",
            "label=com.docker.compose.service=freepbx",
            "--format",
            "{{.Names}}",
        ]
    )
    if code != 0:
        return ""
    names = [n for n in out.decode(errors="replace").split() if n]
    if len(names) == 1:
        return names[0]
    return "zeus-freepbx" if not names else ""


def asterisk(container: str, command: str) -> tuple[int, str]:
    code, out = _run(["docker", "exec", container, "asterisk", "-rx", command])
    return code, out.decode(errors="replace")


def read_config_dir(directory: str) -> dict[str, str]:
    """Every top-level `*.conf` under `directory` as text (flat, no subdirs)."""
    raw: dict[str, str] = {}
    for name in sorted(os.listdir(directory)):
        if not name.endswith(".conf"):
            continue
        try:
            with open(os.path.join(directory, name), "r", encoding="utf-8", errors="replace") as handle:
                raw[name] = handle.read()
        except (IsADirectoryError, PermissionError):
            # A `.conf`-named directory, or a root-only 0600 fragment: neither is
            # readable configuration, and neither is a reason to stop.
            continue
    return raw


def read_container_config(container: str, directory: str) -> tuple[dict[str, str], str]:
    """The PBX's config directory, pulled out read-only. Returns (files, note).

    One `tar` on stdout rather than a `cat` per file or a `docker cp` of the
    tree: it is a single exec, it writes nothing on either side, and a partial
    read cannot leave a half-copied tree behind for the next run to mistake for
    the real thing.
    """
    code, blob = _run(["docker", "exec", container, "tar", "-cf", "-", "-C", directory, "."])
    if code != 0:
        return {}, blob.decode(errors="replace").strip()

    raw: dict[str, str] = {}
    try:
        with tarfile.open(fileobj=io.BytesIO(blob), mode="r:") as archive:
            for member in archive.getmembers():
                if not member.isfile() or not member.name.endswith(".conf"):
                    continue
                # Top level only: keys/, sounds/ and any nested fragment
                # directory are not the include namespace this check reads.
                if "/" in member.name.strip("./"):
                    continue
                handle = archive.extractfile(member)
                if handle is None:
                    continue
                raw[os.path.basename(member.name)] = handle.read().decode("utf-8", errors="replace")
    except tarfile.TarError as exc:
        return {}, f"cannot read {directory} from {container}: {exc}"
    return raw, ""


# ── CLI ─────────────────────────────────────────────────────────────────────
def _emit(finding: Finding, quiet: bool) -> None:
    if quiet:
        return
    marker = "[ok]" if finding.ok else ("[!!]" if finding.ok is False else "[--]")
    print(f"{marker} {finding.detail}")


def extension_of(name: str) -> str | None:
    """The extension a `pjsip_ext_<ext>.conf` fragment claims."""
    match = EXT_FRAGMENT_RE.match(name)
    return match.group("ext") if match else None


def portal_appends(files: dict[str, ConfigFile], ext: str) -> str | None:
    """The operator file carrying `[<ext>](+)`, or None.

    This is the portal's shape since the endpoint decision: it *extends*
    FreePBX's endpoint rather than defining a second one. The append header is
    deliberately untyped, so `definitions()` resolves it to no type and it can
    never be mistaken for a duplicate endpoint object.
    """
    for name in sorted(files):
        for section in files[name].sections:
            if section.id == ext and section.base == "+" and not section.template:
                return name
    return None


def appended_extensions(files: dict[str, ConfigFile]) -> set[str]:
    """Every extension the portal has extended with `[<ext>](+)`."""
    return {
        section.id
        for name in sorted(files)
        for section in files[name].sections
        if section.base == "+" and not section.template
    }


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        description="Who owns the PJSIP endpoint for an extension?",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__.split("Exit status")[0].strip("\n"),
    )
    parser.add_argument("--live", action="store_true", help="read the PBX container")
    parser.add_argument(
        "--config-dir",
        default="",
        help=f"read a config directory instead of a container (e.g. {DEFAULT_DIR})",
    )
    parser.add_argument("--pbx", default="", help="FreePBX container (default: autodetect)")
    parser.add_argument(
        "--extension",
        action="append",
        default=[],
        help=(
            "extension to judge (repeatable; default: every `[<ext>](+)` section "
            "and every pjsip_ext_*.conf found)"
        ),
    )
    parser.add_argument("--json", action="store_true", help="print the measurements")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args(argv[1:])

    if not args.live and not args.config_dir:
        print(
            "pjsip-owner-check: --live or --config-dir is required; the decision logic is "
            "covered by pbx/tests/test_pjsip_owner_check.py",
            file=sys.stderr,
        )
        return 2

    findings: list[Finding] = []
    container = ""
    if args.config_dir:
        raw = read_config_dir(args.config_dir)
        note = "" if raw else f"{args.config_dir} holds no .conf files"
        source = args.config_dir
    else:
        container = find_pbx_container(args.pbx)
        if not container:
            reason = (
                f"no such container: {args.pbx}"
                if args.pbx
                else "no FreePBX container found (docker absent, or none running)"
            )
            print(f"pjsip-owner-check: cannot run here — {reason}", file=sys.stderr)
            return 2
        raw, note = read_container_config(container, DEFAULT_DIR)
        source = f"{container}:{DEFAULT_DIR}"

    if note:
        findings.append(Finding(None, note))
    if not raw:
        for finding in findings:
            _emit(finding, args.quiet)
        print("pjsip-owner-check: cannot run here — no configuration was read", file=sys.stderr)
        return 2

    files = load_files(raw)
    closure = include_closure(files, ENTRY)
    if ENTRY not in files:
        findings.append(
            Finding(
                None,
                f"{ENTRY} is not present in {source} — either this is not a res_pjsip "
                f"host, or it is configured from somewhere else",
            )
        )
    else:
        findings.append(
            Finding(True, f"{ENTRY} loads {len(closure)} file(s): {', '.join(closure)}")
        )

    # Which extension(s) to judge: the two shapes that claim to be provisioned
    # are the default — the portal's current `[<ext>](+)` appends, and the
    # pre-decision `pjsip_ext_<ext>.conf` fragments it may have left behind.
    # Both are judged when both exist, because a box mid-migration has one of
    # each and the duplicate only shows up if something looks at the pair.
    wanted = list(dict.fromkeys(args.extension))
    if not wanted:
        inferred = set(appended_extensions(files))
        inferred.update(ext for ext in (extension_of(name) for name in sorted(raw)) if ext)
        wanted = sorted(inferred)
        if not wanted:
            findings.append(
                Finding(
                    None,
                    "no `[<ext>](+)` section and no pjsip_ext_*.conf on this PBX — the "
                    "portal has provisioned no softphone endpoint here, so there is "
                    "nothing it issued a secret for",
                )
            )

    loaded = definitions(files)
    for ext in wanted:
        findings.extend(verdict_endpoint(ext, files, closure, loaded))
    findings.extend(verdict_includes(include_carriers(files)))

    dangling = missing_includes(files)
    if dangling:
        findings.append(
            Finding(
                None,
                "includes naming a file that is not here: "
                + ", ".join(f"{carrier} -> {target}" for carrier, target in dangling),
            )
        )

    endpoints: set[str] | None = None
    transports: set[str] | None = None
    transport_types: dict[str, str] | None = None
    running: bool | None = None
    if container:
        code, out = asterisk(container, "pjsip show endpoints")
        endpoints = parse_endpoints(out) if code == 0 else None
        code, out = asterisk(container, "pjsip show transports")
        transport_types = parse_transport_types(out) if code == 0 else None
        transports = set(transport_types or {})
        code, out = asterisk(container, "module show like res_pjsip")
        running = parse_module_state(out) if code == 0 else None
        findings.extend(
            verdict_asterisk(
                endpoints,
                transports,
                running,
                wanted[0] if wanted else "",
                transport_types=transport_types,
            )
        )

    for finding in findings:
        _emit(finding, args.quiet)

    if args.json:
        print(
            json.dumps(
                {
                    "source": source,
                    "entry": ENTRY,
                    "closure": closure,
                    "generated": sorted(
                        name for name, text in raw.items() if is_generated(name, text)
                    ),
                    "ownership": {name: ownership(name, text) for name, text in raw.items()},
                    "includes": [asdict(cfg) for cfg in files.values()],
                    "include_carriers": include_carriers(files),
                    "missing_includes": dangling,
                    "definitions": {
                        f"{ident}/{kind}": [list(place) for place in places]
                        for (ident, kind), places in sorted(loaded.items())
                    },
                    "extensions": wanted,
                    "asterisk": {
                        "endpoints": sorted(endpoints) if endpoints is not None else None,
                        "transports": sorted(transports) if transports is not None else None,
                        "transport_types": transport_types or None,
                        "res_pjsip_running": running,
                    },
                    "findings": [asdict(finding) for finding in findings],
                },
                indent=2,
                sort_keys=False,
            )
        )

    failures = [f for f in findings if f.ok is False]
    evaluated = [f for f in findings if f.ok is not None]
    unresolved = [f.detail for f in findings if f.ok is None]
    if failures:
        print(
            f"pjsip-owner-check: FAIL — {len(failures)} two-owner finding(s)",
            file=sys.stderr,
        )
        return 1
    if not evaluated:
        print(
            "pjsip-owner-check: cannot run here — nothing was evaluated "
            f"({'; '.join(unresolved) or 'no input'})",
            file=sys.stderr,
        )
        return 2
    caveat = f" (not evaluated: {'; '.join(unresolved)})" if unresolved else ""
    print(f"pjsip-owner-check: PASS — {len(evaluated)} finding(s){caveat}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
