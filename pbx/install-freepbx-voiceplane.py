#!/usr/bin/env python3
"""install-freepbx-voiceplane.py — put the read-only voice-plane module in FreePBX.

WHY THIS EXISTS
---------------
`pbx/freepbx-modules/voiceplane/` is a FreePBX module whose only job is the menu
entry the voice plane could not otherwise have: the framework builds the admin
menu from each installed module's `module.xml` `<menuitems>`, so there is no
config to set instead, and no way for the estate's landing pages or the SSO
gateway's banner to put a *PBX-side* entry there. An entry is a module, or it is
nothing.

The module is also part of the image (`Dockerfile.full` copies it into
`/opt/zeus/pbx-modules/`, and `docker-entrypoint-full.sh` converges it into the
running FreePBX) — but the live PBX is a *volume*, so a host that already has
`freepbx-www` comes up with the previous contents and a changed module never
appears. The entrypoint handles that on the next boot; this tool is how the same
convergence happens **now**, on a host that is not being rebuilt. That is the
same reason `pbx/patch-freepbx-trunk-next-id.py` exists, and it follows its
shape: runnable from the host it installs into, `--check` for drift, no
image rebuild.

WHAT IT DOES, IN ORDER
----------------------
1. Streams the module into the PBX (`/var/www/html/admin/modules/voiceplane`)
   from the checkout this script lives in — the repo is the source of truth, and
   the container may mount none of it.
2. Writes `config.json` beside the module **only when asked** (`--portal-url` /
   `--token`), so a re-run against an already-configured box does not overwrite
   what the operator set. The token is written 0640, asterisk-owned, and is
   never echoed.
3. Runs `fwconsole ma installlocal`. Its own `doInstallLocal()` refreshes the
   module-XML cache and installs every module in state NOTINSTALLED or
   NEEDUPGRADE — so a *version bump in module.xml* is the update path, and
   nothing here has to know how FreePBX stores modules.
4. Verifies the thing the module exists for: it boots FreePBX in the container
   (`fwconsole`'s own CLI recipe) and asks the framework what it makes of the
   module — its status, and the `items` it derived from `<menuitems>`. "The
   files are on disk" is not evidence that Module Admin will offer the entry.

Read-only in the strict sense: it writes the module's own files, its own
`config.json`, and nothing else. It never touches a setting, a route or a
dialplan file — the page it installs has no POST handler at all.

USAGE
-----
    # the live stack, without a rebuild (PBX_CONTAINER=zeus-freepbx is the default)
    pbx/install-freepbx-voiceplane.py --check
    pbx/install-freepbx-voiceplane.py --portal-url https://api.zeus.innotel.us --token "$PBX_SYNC_TOKEN"

    # a bare-metal FreePBX on this host
    sudo pbx/install-freepbx-voiceplane.py --target host --check

`--ensure` is the mode a boot calls: it installs only when the target is not at
this checkout's version, and ignores the "portal not configured" finding that
`--check` reports (that is an operator's setting, not drift).

Exit codes: 0 installed/already current · 1 drift or not installed (from
`--check`) · 2 could not run (no container, no FreePBX in it, no docker).

Note on the pre-state: P0's discipline (`pbx/p0-snapshot.sh`) applies to a change
to a *live phone system*. This one is additive and read-only, but the snapshot is
cheap and the module is removable with `fwconsole ma delete voiceplane`.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import tarfile
import xml.etree.ElementTree as ElementTree
from typing import NoReturn

# Where a FreePBX module lives, in the container and on a bare-metal host. The
# image puts the repo's copy at /opt/zeus/pbx-modules (Dockerfile.full).
DEFAULT_MODULES_DIR = "/var/www/html/admin/modules"
IMAGE_SOURCE_DIR = "/opt/zeus/pbx-modules"
DEFAULT_CONTAINER = os.environ.get("PBX_CONTAINER", "zeus-freepbx")
MODULE_RAWNESS_DIR = "voiceplane"

# Everything the module needs to work. Checked before anything is copied: a
# half-copied module is a module that is *installed* and does not render, which
# is worse than not installing it.
REQUIRED_FILES = (
    "module.xml",
    "Voiceplane.class.php",
    "page.voiceplane.php",
    "views/voiceplane/main.php",
)


class CouldNotRun(Exception):
    """Exit 2 — nothing was changed and nothing was judged."""


def die(message: str) -> NoReturn:
    print(f"install-freepbx-voiceplane: {message}", file=sys.stderr)
    raise SystemExit(2)


def run(argv: list[str], stdin: bytes | None = None, check: bool = True) -> subprocess.CompletedProcess:
    result = subprocess.run(argv, input=stdin, capture_output=True)
    if check and result.returncode != 0:
        detail = (result.stderr or result.stdout).decode(errors="replace").strip()
        raise CouldNotRun(f"{' '.join(argv)} → exit {result.returncode}: {detail[:400]}")
    return result


class Pbx:
    """A FreePBX, reachable through a container or directly on this host."""

    def __init__(self, target: str, container: str, modules_dir: str, pbx_dir: str | None):
        self.target = target
        self.container = container
        self.modules_dir = modules_dir
        self.pbx_dir = pbx_dir or (os.path.dirname(modules_dir) if target == "container" else "")

    def _base(self) -> list[str]:
        return ["docker", "exec", "-i", self.container] if self.target == "container" else []

    def exec(self, script: str, stdin: bytes | None = None, check: bool = True) -> subprocess.CompletedProcess:
        return run([*self._base(), "sh", "-c", script], stdin=stdin, check=check)

    def root(self) -> str:
        """The module dir inside the target."""
        return f"{self.modules_dir}/{MODULE_RAWNESS_DIR}"

    def preflight(self) -> None:
        if self.target == "container":
            if shutil.which("docker") is None:
                die("docker is not on PATH — run this on the PBX host, or use --target host")
            result = run(["docker", "inspect", "-f", "{{.State.Running}}", self.container], check=False)
            if result.returncode != 0 or result.stdout.decode().strip() != "true":
                die(f"container {self.container} is not running — set PBX_CONTAINER or --container")
        probe = self.exec(
            f"test -d {self.modules_dir} && test -x \"$(command -v fwconsole)\" && echo ok", check=False
        )
        if probe.stdout.decode().strip() != "ok":
            where = f"container {self.container}" if self.target == "container" else "this host"
            die(f"no FreePBX in {where}: {self.modules_dir} or fwconsole is missing")

    def read_file(self, path: str) -> str:
        result = self.exec(f"cat {path} 2>/dev/null || true", check=False)
        return result.stdout.decode(errors="replace")

    def fwconsole(self, *args: str, check: bool = True) -> str:
        command = "fwconsole " + " ".join(args)
        result = self.exec(command, check=check)
        return (result.stdout + result.stderr).decode(errors="replace")


def module_manifest(source: str) -> dict[str, str]:
    """rawname / version / name / the menuitem label, straight from module.xml."""
    manifest_path = os.path.join(source, "module.xml")
    if not os.path.isfile(manifest_path):
        die(f"no module.xml in {source} — point --source at the module directory")
    try:
        root = ElementTree.parse(manifest_path).getroot()
    except ElementTree.ParseError as exc:
        die(f"{manifest_path} is not valid XML: {exc}")

    def text(tag: str) -> str:
        found = root.find(tag)
        return (found.text or "").strip() if found is not None else ""

    menuitems = root.find("menuitems")
    item = list(menuitems)[0] if menuitems is not None and len(menuitems) else None
    return {
        "rawname": text("rawname"),
        "version": text("version"),
        "name": text("name"),
        "category": text("category"),
        # The display key is the element name, the label is its text — that pair
        # is what the framework turns into `config.php?display=<key>`.
        "display": item.tag if item is not None else "",
        "label": (item.text or "").strip() if item is not None else "",
    }


def archive(source: str) -> bytes:
    """The module as a tar, for the target's own tar to unpack in place."""
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as tar:
        for name in sorted(os.listdir(source)):
            if name in ("config.json", "__pycache__"):
                # config.json is the *target's* state, never the repo's
                # (it may hold the portal token); and a stale bytecode cache is
                # not something to ship into a running PBX.
                continue
            tar.add(os.path.join(source, name), arcname=f"{MODULE_RAWNESS_DIR}/{name}")
    return buffer.getvalue()


def module_state(pbx: Pbx, rawname: str) -> tuple[str, str]:
    """(version, state) as FreePBX reports them, or ('', '') when it does not.

    Read from `fwconsole ma list` rather than the database: the local module
    list is the framework's own answer, and parsing it avoids depending on which
    kvstore/table a given FreePBX version records a module in.
    """
    for line in pbx.fwconsole("ma", "list", check=False).splitlines():
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if len(cells) >= 3 and cells[0] == rawname:
            return cells[1], cells[2]
    return "", ""


def file_hashes(pbx: Pbx, source: str) -> tuple[dict[str, str], dict[str, str]]:
    """(local, target) md5 for every module file, keyed by its relative path.

    Files, not versions: an operator editing the module in the checkout and
    re-applying is the ordinary way this changes, and a version bump is easy to
    forget. One `md5sum` on the target rather than a read per file, because this
    runs on every boot.

    `config.json` is on neither side: it is the target's state (it holds the
    portal token), so its content is expected to differ and is reported
    separately.
    """
    local: dict[str, str] = {}
    for root, dirs, files in os.walk(source):
        dirs[:] = [name for name in dirs if name != "__pycache__"]
        for name in files:
            if name == "config.json":
                continue
            path = os.path.join(root, name)
            with open(path, "rb") as handle:
                local[os.path.relpath(path, source)] = hashlib.md5(handle.read()).hexdigest()

    result = pbx.exec(
        f"cd {pbx.root()} 2>/dev/null && find . -type f ! -name config.json -print0 "
        "| sort -z | xargs -0 md5sum 2>/dev/null",
        check=False,
    )
    remote: dict[str, str] = {}
    for line in result.stdout.decode(errors="replace").splitlines():
        parts = line.split(None, 1)
        if len(parts) == 2:
            remote[parts[1].strip().lstrip("./")] = parts[0]
    return local, remote


def drifted_files(pbx: Pbx, source: str) -> tuple[list[str], list[str]]:
    """(files that differ or are absent, extra files the checkout does not have).

    Extra files are reported and never acted on: a target can legitimately hold
    more than the checkout (an operator's local experiment), and deleting files
    from a live PBX is not a decision a version comparison should make.
    """
    local, remote = file_hashes(pbx, source)
    drifted = sorted(name for name, digest in local.items() if remote.get(name) != digest)
    extra = sorted(name for name in remote if name not in local)
    return drifted, extra


def configured_portal(pbx: Pbx) -> bool:
    """Whether the module on the target has a portal URL and token to read with."""
    raw = pbx.read_file(f"{pbx.root()}/config.json").strip()
    if not raw:
        return False
    try:
        settings = json.loads(raw)
    except json.JSONDecodeError:
        return False
    return bool(settings.get("portal_url")) and bool(settings.get("pbx_sync_token"))


def check(pbx: Pbx, manifest: dict[str, str], as_json: bool, source: str) -> int:
    """Report drift without changing anything. 0 current · 1 needs attention."""
    version, state = module_state(pbx, manifest["rawname"])
    enabled = state.lower() == "enabled"
    present = pbx.exec(f"test -f {pbx.root()}/Voiceplane.class.php && echo yes", check=False)
    files_present = present.stdout.decode().strip() == "yes"
    configured = configured_portal(pbx)
    drifted, extra = drifted_files(pbx, source) if source and os.path.isdir(source) else ([], [])
    # The menu entry is the whole point of the module, so it is what the check
    # reports on rather than "the files are there".
    menuitem = pbx_menu_entry(pbx, manifest)

    findings = []
    if version == "":
        findings.append("not installed")
    elif version != manifest["version"]:
        findings.append(f"installed {version}, checkout has {manifest['version']}")
    if version and not enabled:
        findings.append("installed but disabled")
    if not files_present:
        findings.append("files missing from the target")
    if not configured:
        findings.append("no portal URL/token configured (the plan half will be empty)")
    if not menuitem:
        findings.append("the framework offers no menu entry for this module")
    if drifted:
        findings.append(f"the target's files differ from the checkout: {', '.join(drifted)}")

    report = {
        "module": manifest["rawname"],
        "version": manifest["version"],
        "installed_version": version,
        "enabled": enabled,
        "files_present": files_present,
        "files_drifted": drifted,
        "files_extra": extra,
        "portal_configured": configured,
        "menu_entry": menuitem,
        "target": f"container {pbx.container}" if pbx.target == "container" else "host",
        "findings": findings,
    }
    if as_json:
        print(json.dumps(report, indent=2))
    else:
        print(f"voiceplane on {report['target']}")
        print(f"  installed   {version or '(not installed)'}   checkout {manifest['version']}")
        print(f"  enabled     {'yes' if enabled else 'no'}")
        print(f"  menu entry  {menuitem or '(absent)'}")
        print(f"  files       {len(drifted)} drifted from the checkout"
              + (f", {len(extra)} extra on the target" if extra else ""))
        print(f"  portal      {'configured' if configured else 'NOT configured — the plan half will be empty'}")
        for finding in findings:
            print(f"  finding: {finding}")
        if not findings:
            print("  ok: installed, enabled, the framework offers the menu entry, portal configured")
    return 1 if findings else 0


# Asked *of the framework*, not of our own file: the point is whether FreePBX
# will offer the menu entry, and only FreePBX's own parse of module.xml can
# answer that. `getInfo()` is the walk behind Module Admin and the admin nav,
# and `items` is what the nav is built from — one key per `<menuitems>` entry,
# carrying the category and name the framework derived.
#
# Booting FreePBX in CLI is `fwconsole`'s own recipe (`$bootstrap_settings`
# with `freepbx_auth = false`, then `/etc/freepbx.conf`); a bare
# `require bootstrap.php` fails on the database. The program is fed on stdin so
# no shell quoting can mangle it.
MENU_PROBE = r'''<?php
$bootstrap_settings["freepbx_auth"] = false;
include_once "/etc/freepbx.conf";
$all = \FreePBX::Modules()->getInfo();
$module = isset($all["%s"]) ? $all["%s"] : null;
echo "VOICEPLANE_PROBE:", json_encode(array(
    "present" => $module !== null,
    "status" => $module["status"] ?? null,
    "name" => $module["name"] ?? null,
    "version" => $module["version"] ?? null,
    "items" => $module["items"] ?? null,
)), "\n";
'''


def framework_module(pbx: Pbx, rawname: str) -> dict:
    """What FreePBX itself makes of the module: its status and its menu items."""
    result = pbx.exec("php", stdin=(MENU_PROBE % (rawname, rawname)).encode(), check=False)
    for line in result.stdout.decode(errors="replace").splitlines():
        if line.startswith("VOICEPLANE_PROBE:"):
            try:
                return json.loads(line.split(":", 1)[1])
            except json.JSONDecodeError:
                return {}
    return {}


def pbx_menu_entry(pbx: Pbx, manifest: dict[str, str]) -> str:
    """The module's menu entry as the framework derives it, or '' if it has none.

    Reporting the framework's own answer is the difference between "the files
    are on disk" (which says nothing) and "Module Admin will offer this entry".
    A framework that cannot be booted in CLI leaves the entry unproven, and the
    caller reports that as a finding rather than a pass.
    """
    info = framework_module(pbx, manifest["rawname"])
    items = info.get("items") or {}
    for key, item in items.items():
        if key == manifest["display"]:
            return (f"{item.get('category', manifest['category'])} → {item.get('name', manifest['label'])}"
                    f" (display={key})")
    return ""


def ensure(pbx: Pbx, manifest: dict[str, str], source: str, reload_pbx: bool, as_json: bool) -> int:
    """Converge the target onto this checkout — what the entrypoint runs on boot.

    Installs when the target is not at this version *or* when its files differ
    from the checkout: an existing `freepbx-www` volume predates the module
    entirely, and a checkout can move ahead of an image without a version bump.
    Both are the same answer, and a copy of files that already match is cheap
    next to a PBX page that silently runs old code.

    It deliberately ignores the "portal not configured" finding that `--check`
    reports: that is an operator's setting, and a boot must not re-install on
    every start because a secret has not been written yet. Exit 0 means the
    module is at this checkout's state, whether this call installed it or found
    it that way.
    """
    version, state = module_state(pbx, manifest["rawname"])
    drifted, _ = drifted_files(pbx, source) if os.path.isdir(source) else (["no checkout"], [])
    if version == manifest["version"] and state.lower() == "enabled" and not drifted:
        if as_json:
            print(json.dumps({"module": manifest["rawname"], "version": version,
                              "state": state, "action": "none"}, indent=2))
        else:
            print(f"voiceplane {version} already current ({state}, files match)")
        return 0
    if drifted:
        print(f"voiceplane: {len(drifted)} file(s) differ from the checkout — converging")
    return install(pbx, manifest, source, "", "", reload_pbx, as_json)


def install(pbx: Pbx, manifest: dict[str, str], source: str, portal_url: str, token: str,
            reload_pbx: bool, as_json: bool) -> int:
    payload = archive(source)
    # `tar` unpacks it in place, creating the module directory: one streamed
    # command rather than a file-by-file copy, so a transient failure cannot
    # leave a module half-written and *installed*.
    pbx.exec(f"mkdir -p {pbx.modules_dir} && tar -xzf - -C {pbx.modules_dir}", stdin=payload)

    # The web user owns the tree (php-fpm runs as `asterisk` in this image), and
    # a module's own config file is not world-readable — it holds the same bearer
    # token the sync timer uses.
    if portal_url or token:
        settings = {}
        existing = pbx.read_file(f"{pbx.root()}/config.json").strip()
        if existing:
            try:
                settings = json.loads(existing)
            except json.JSONDecodeError:
                settings = {}
        if portal_url:
            settings["portal_url"] = portal_url.rstrip("/")
        if token:
            settings["pbx_sync_token"] = token
        pbx.exec(
            f"cat > {pbx.root()}/config.json", stdin=json.dumps(settings, indent=2).encode() + b"\n"
        )
        pbx.exec(f"chmod 0640 {pbx.root()}/config.json")

    pbx.exec(f"chown -R asterisk:asterisk {pbx.modules_dir}/{MODULE_RAWNESS_DIR} 2>/dev/null || true")
    pbx.exec(f"find {pbx.modules_dir}/{MODULE_RAWNESS_DIR} -type d -exec chmod 0755 {{}} + && "
             f"find {pbx.modules_dir}/{MODULE_RAWNESS_DIR} -type f -exec chmod 0644 {{}} + && "
             f"test -f {pbx.root()}/config.json && chmod 0640 {pbx.root()}/config.json || true")

    before, _ = module_state(pbx, manifest["rawname"])
    output = pbx.fwconsole("ma", "installlocal", check=False)
    after, state = module_state(pbx, manifest["rawname"])

    if reload_pbx:
        # An install writes module state; the menu and the dialplan are rebuilt
        # from it. This is the same reload an Apply Config does.
        pbx.fwconsole("reload", check=False)

    entry = pbx_menu_entry(pbx, manifest)
    report = {
        "module": manifest["rawname"],
        "from_version": before,
        "to_version": after,
        "state": state,
        "menu_entry": entry,
        "config_written": bool(portal_url or token),
        "installlocal_output": output.strip().splitlines()[-3:],
    }
    ok = after == manifest["version"] and entry != ""
    if as_json:
        print(json.dumps({**report, "ok": ok}, indent=2))
    else:
        print(f"installed {manifest['rawname']} {after or '(still not installed)'} "
              f"(was {before or 'not installed'})")
        print(f"  menu entry  {entry or 'NOT cached — the admin menu will not show it'}")
        if not ok:
            print("  the install did not converge; see the module admin output above", file=sys.stderr)
    return 0 if ok else 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--source", default=os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                                         "freepbx-modules", MODULE_RAWNESS_DIR),
                        help="the module checkout to install (default: pbx/freepbx-modules/voiceplane)")
    parser.add_argument("--target", choices=("container", "host"), default="container",
                        help="a FreePBX in a container (default) or directly on this host")
    parser.add_argument("--container", default=DEFAULT_CONTAINER,
                        help=f"container name for --target container (default: {DEFAULT_CONTAINER})")
    parser.add_argument("--modules-dir", default=DEFAULT_MODULES_DIR,
                        help=f"FreePBX module directory in the target (default: {DEFAULT_MODULES_DIR})")
    parser.add_argument("--pbx-dir", default=None,
                        help="FreePBX web root in the target (default: the parent of --modules-dir)")
    parser.add_argument("--check", action="store_true", help="report drift, change nothing")
    parser.add_argument("--ensure", action="store_true",
                        help="install only if the target is behind this checkout (what a boot calls)")
    parser.add_argument("--json", action="store_true", help="machine-readable output")
    parser.add_argument("--portal-url", default="", help="write this portal URL into the module's config.json")
    parser.add_argument("--token", default="", help="write this sync token into the module's config.json (0600)")
    parser.add_argument("--no-reload", action="store_true", help="skip `fwconsole reload` after installing")
    args = parser.parse_args()

    source = os.path.abspath(args.source)
    if not os.path.isdir(source):
        # A host whose checkout is elsewhere (or that runs this from a published
        # image, where the module ships inside) resolves it with --source; the
        # alternative is a copy of the module that silently goes stale.
        die(f"no module checkout at {source} — pass --source <dir>")
    missing = [name for name in REQUIRED_FILES if not os.path.isfile(os.path.join(source, name))]
    if missing:
        die(f"{source} is not a complete module — missing: {', '.join(missing)}")

    manifest = module_manifest(source)
    if manifest["rawname"] != MODULE_RAWNESS_DIR:
        die(f"module.xml says rawname={manifest['rawname']}, expected {MODULE_RAWNESS_DIR}")

    pbx = Pbx(args.target, args.container, args.modules_dir.rstrip("/"), args.pbx_dir)
    try:
        pbx.preflight()
        if args.check:
            return check(pbx, manifest, args.json, source)
        if args.ensure:
            return ensure(pbx, manifest, source, not args.no_reload, args.json)
        return install(pbx, manifest, source, args.portal_url, args.token, not args.no_reload, args.json)
    except CouldNotRun as exc:
        die(str(exc))
    return 2


if __name__ == "__main__":
    sys.exit(main())
