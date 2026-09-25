#!/usr/bin/env python3
"""A res_odbc class whose DSN `/etc/odbc.ini` does not define is a dead feature.

That is not a hypothetical. `res_odbc_custom.conf` registers
`[asteriskvoicemail]` — the class `app_voicemail` stores messages through —
against `MySQL-asteriskvoicemail`, and `/etc/odbc.ini` defined only the CDR DSN,
so every voicemail retrieve failed with *"Data source name not found and no
default driver specified"*. What a caller hears is `*97` (FreePBX's My
Voicemail) doing nothing at all, on a PBX that looks healthy from every other
angle — the same shape as the nine days of missing CDR that `pbx/d7_assert.py`
was written for: only the *absence* of a connection said anything was wrong, and
nothing was watching for an absence.

Two files can keep that pair apart, and this checks both, from the text rather
than from a list of names (a new class is then checked by the same test):

  * `scripts/setup.sh` writes `/etc/odbc.ini` **and** `res_odbc_custom.conf`
    itself, one right after the other. Every DSN its own classes name has to be
    a section its own file defines — this is the parity that was broken, and
    the file it writes is not additive (`cat >`, not `>>`), so a class left out
    is not left out politely.

  * `docker-entrypoint-full.sh` patches `/etc/odbc.ini` on **every boot**,
    because that file lives in the image and not on a volume: a section added by
    hand — the fix the upstream deploy README documents — is gone the next time
    the container is recreated. So the entrypoint block is rehearsed here for
    real, in a scratch directory, against a fake odbc.ini: the DSN is derived
    from the class (never restated, or a renamed class would need the entrypoint
    edited), the added section mirrors the connection that already works, and a
    second run changes no byte.

Run:  python3 -m unittest discover -s scripts/tests -v
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
SETUP = REPO / "scripts" / "setup.sh"
ENTRYPOINT = REPO / "docker-entrypoint-full.sh"

ODBC_INI = "/etc/odbc.ini"
RES_ODBC_CUSTOM = "/etc/asterisk/res_odbc_custom.conf"

# `cat > <path> <<TAG` … a line that is exactly TAG. Both scripts write their
# config this way, and it is the only form either uses.
WRITE = re.compile(r"^cat > (\S+) <<'?([A-Za-z_][A-Za-z0-9_]*)'?\s*$", re.M)
SECTION = re.compile(r"^\[(.+?)\]\s*$")
# FreePBX writes `key=>value`; a hand edit leaves `key=value`. Both are read.
KEY = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)\s*=>?\s*(.*?)\s*$")

# The entrypoint block is found by the banner comment above it, not by line
# numbers, and runs until the next top-level banner: the rehearsal then executes
# exactly what the container executes.
BLOCK_START = "# ── The DSNs res_odbc_custom.conf names and odbc.ini does not define"
BANNER = re.compile(r"^# ── ", re.M)


def written(text: str, target: str) -> str:
    """The body of the `cat > <target>` heredoc in a script."""
    for match in WRITE.finditer(text):
        if match.group(1) != target:
            continue
        tag = match.group(2)
        rest = text[match.end() :]
        end = re.search(rf"^{re.escape(tag)}\s*$", rest, re.M)
        if end is None:
            raise AssertionError(f"{target}: heredoc {tag} is never closed")
        return rest[: end.start()]
    raise AssertionError(f"no `cat > {target}` heredoc found")


def parse(fragment: str) -> dict[str, dict[str, str]]:
    """{section: {key: value}} for an INI-style fragment."""
    out: dict[str, dict[str, str]] = {}
    section: str | None = None
    for line in fragment.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith(("#", ";")):
            continue
        match = SECTION.match(stripped)
        if match:
            section = match.group(1)
            out.setdefault(section, {})
            continue
        if section is None:
            continue
        key = KEY.match(stripped)
        if key:
            out[section][key.group(1).lower()] = key.group(2)
    return out


def section_text(fragment: str, name: str) -> str:
    """The lines of one section, without its header."""
    lines = fragment.splitlines()
    start = lines.index(f"[{name}]")
    body: list[str] = []
    for line in lines[start + 1 :]:
        if line.startswith("["):
            break
        body.append(line)
    return "\n".join(body)


def entrypoint_block() -> str:
    """The block docker-entrypoint-full.sh runs, as text."""
    text = ENTRYPOINT.read_text(encoding="utf-8")
    start = text.find(BLOCK_START)
    if start == -1:
        raise AssertionError(
            f"{ENTRYPOINT.name} no longer carries the block this test rehearses "
            f"({BLOCK_START!r}) — if it moved, move the rehearsal with it"
        )
    following = BANNER.search(text, start + len(BLOCK_START))
    if following is None:
        raise AssertionError(f"{ENTRYPOINT.name}: the block has no closing banner")
    return text[start : following.start()]


class SetupParity(unittest.TestCase):
    """scripts/setup.sh writes both halves; they must name the same DSNs."""

    def setUp(self):
        self.classes = parse(written(SETUP.read_text(encoding="utf-8"), RES_ODBC_CUSTOM))
        self.dsns = parse(written(SETUP.read_text(encoding="utf-8"), ODBC_INI))

    def test_the_fixture_is_real(self):
        self.assertTrue(self.classes, "setup.sh registers no res_odbc class?")
        self.assertTrue(self.dsns, "setup.sh defines no odbc.ini DSN?")

    def test_every_dsn_a_class_names_is_defined(self):
        for name, settings in sorted(self.classes.items()):
            dsn = settings.get("dsn")
            if not dsn:
                continue
            self.assertIn(
                dsn,
                self.dsns,
                f"res_odbc class [{name}] names DSN {dsn!r}, and the /etc/odbc.ini "
                f"this same script writes defines {sorted(self.dsns)} — the class "
                f"cannot connect and the feature behind it fails with 'Data source "
                f"name not found and no default driver specified'",
            )

    def test_each_dsn_reaches_the_database_its_class_names(self):
        """A section that mirrors its neighbour is right; one that points at the
        neighbour's database is the copy-paste this pairing invites."""
        for name, settings in sorted(self.classes.items()):
            dsn, database = settings.get("dsn"), settings.get("database")
            if not dsn or not database:
                continue
            defined = self.dsns.get(dsn, {})
            self.assertEqual(
                defined.get("database"),
                database,
                f"[{name}] stores in {database!r} but its DSN {dsn!r} connects to "
                f"{defined.get('database')!r}",
            )


class EntrypointRehearsal(unittest.TestCase):
    """The boot repair, run in a scratch directory: no container, no /etc."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="zeus-odbc-dsn-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.ini = self.tmp / "odbc.ini"
        self.res = self.tmp / "res_odbc_custom.conf"
        self.block = self.tmp / "block.sh"
        self.block.write_text(entrypoint_block(), encoding="utf-8")

    def working_ini(self) -> None:
        """What the image ships: the CDR DSN, resolvable, and nothing else."""
        self.ini.write_text(
            "[MySQL-asteriskcdrdb]\n"
            "Description=MySQL connection to 'asteriskcdrdb' database\n"
            "# the driver the Connector/ODBC is registered under\n"
            "driver=MariaDB\n"
            "server=localhost\n"
            "database=asteriskcdrdb\n"
            "username=root\n"
            "password=hunter2\n"
            "Port=3306\n"
            "Socket=/run/mysqld/mysqld.sock\n"
            "option=3\n"
            "Charset=utf8\n",
            encoding="utf-8",
        )

    def classes(self, text: str) -> None:
        self.res.write_text(text, encoding="utf-8")

    def run_block(self) -> subprocess.CompletedProcess:
        env = {
            **os.environ,
            "ODBC_INI": str(self.ini),
            "RES_ODBC_CUSTOM": str(self.res),
        }
        return subprocess.run(
            ["bash", "-e", str(self.block)], env=env, capture_output=True, text=True
        )

    def test_a_class_whose_dsn_is_missing_gets_one(self):
        self.working_ini()
        # `=>` (what FreePBX writes) and `=` (what a hand edit leaves behind) in
        # the same file, because both have to be read for the repair to be a
        # repair rather than a guess at this file's house style.
        self.classes(
            "[asteriskvoicemail]\n"
            "enabled=>yes\n"
            "dsn=>MySQL-asteriskvoicemail\n"
            "database=>asteriskvoicemail\n"
            "\n"
            "[legacyvm]\n"
            "enabled=yes\n"
            "dsn=MySQL-legacyvm\n"
            "database=legacyvm\n"
            # a class that names no database: there is nothing to connect to, so
            # it gets no section rather than an empty one.
            "\n"
            "[general]\n"
            "dsn=>MySQL-nothing-to-say\n"
        )
        done = self.run_block()
        self.assertEqual(done.returncode, 0, done.stderr)

        added = parse(self.ini.read_text(encoding="utf-8"))
        self.assertIn("MySQL-asteriskvoicemail", added)
        self.assertIn("MySQL-legacyvm", added)
        self.assertNotIn("MySQL-nothing-to-say", added)

        # Neither the class nor the DSN is restated: a renamed class keeps
        # working, which is the whole reason the block derives instead.
        code = "\n".join(
            line
            for line in self.block.read_text(encoding="utf-8").splitlines()
            if not line.strip().startswith("#")
        )
        self.assertNotIn("MySQL-asteriskvoicemail", code)

        # The new sections are copies of the one that connects — a DSN missing
        # credentials, or a driver this image does not register, is the same
        # dead class with a different sentence in the log.
        ini_text = self.ini.read_text(encoding="utf-8")
        for dsn in ("MySQL-asteriskvoicemail", "MySQL-legacyvm"):
            self.assertEqual(added[dsn]["driver"], "MariaDB")
            self.assertEqual(added[dsn]["socket"], "/run/mysqld/mysqld.sock")
            self.assertEqual(added[dsn]["username"], "root")
            self.assertEqual(added[dsn]["password"], "hunter2")
            self.assertEqual(added[dsn]["port"], "3306")
            # Carried over from the section it mirrors, but not the comments:
            # those describe the CDR driver, not this connection.
            self.assertFalse(
                [
                    line
                    for line in section_text(ini_text, dsn).splitlines()
                    if line.startswith("#")
                ]
            )
            self.assertIn(
                added[dsn]["description"],
                f"MySQL connection to '{added[dsn]['database']}' database",
            )
        self.assertEqual(added["MySQL-asteriskvoicemail"]["database"], "asteriskvoicemail")
        self.assertEqual(added["MySQL-legacyvm"]["database"], "legacyvm")
        self.assertIn("MySQL-asteriskvoicemail", done.stdout)

    def test_a_second_boot_changes_no_byte(self):
        """A repair that re-adds its own section every boot grows the file the
        container has to read, and res_odbc re-reads it on every reload."""
        self.working_ini()
        self.classes(
            "[asteriskvoicemail]\n"
            "dsn=>MySQL-asteriskvoicemail\n"
            "database=>asteriskvoicemail\n"
        )
        first = self.run_block()
        self.assertEqual(first.returncode, 0, first.stderr)
        after_first = self.ini.read_text(encoding="utf-8")

        second = self.run_block()
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual(self.ini.read_text(encoding="utf-8"), after_first)
        self.assertNotIn(">>> [odbc]", second.stdout)

    def test_a_defined_dsn_is_left_alone(self):
        self.working_ini()
        with self.ini.open("a", encoding="utf-8") as handle:
            handle.write(
                "\n[MySQL-asteriskvoicemail]\n"
                "Description=added by hand when this was last fixed\n"
                "driver=MariaDB\n"
                "database=asteriskvoicemail\n"
            )
        before = self.ini.read_text(encoding="utf-8")
        self.classes(
            "[asteriskvoicemail]\n"
            "dsn=>MySQL-asteriskvoicemail\n"
            "database=>asteriskvoicemail\n"
        )
        done = self.run_block()
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(self.ini.read_text(encoding="utf-8"), before)


if __name__ == "__main__":
    unittest.main()
