#!/usr/bin/env python3
"""The PBX entrypoint must not die on a MariaDB that is slow to answer.

`docker-entrypoint-full.sh` runs under `set -e` and used to call `service mariadb
start` bare. On 2026-10-08 a host reboot left the `pbx-mariadb-data` volume dirty:
InnoDB replays its redo log before it serves a query — minutes — while the init
script's own wait is measured in seconds, so `service` exited non-zero, `set -e`
ended the entrypoint, and the container restart then SIGKILLed mariadbd *mid
replay*. The volume never got clean, so the container restart-looped with no way
out. The failure only shows up on a dirty volume, so what is pinned here is the
shape the script has to keep:

  * the start is **advisory** (`|| true`) — its exit status may never end the
    boot;
  * readiness is a **bounded** wait, guarded against a non-numeric override, and
    probed with a **real query** (`SELECT 1`) rather than `mysqladmin ping`,
    which exits 0 even on "Access denied" and would call a broken database ready;
  * that wait sits **before** the first `mysql -u root` consumer, so no later
    step runs against a server that has not answered yet.

Behaviour under a stubbed slow daemon is rehearsed by hand; these assert the
invariants that make that rehearsal meaningful.

Run:  python3 -m unittest discover -s pbx/tests -v
"""
import os
import re
import unittest

ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", ".."))
ENTRYPOINT = os.path.join(ROOT, "docker-entrypoint-full.sh")

#: An actual invocation — the command at the start of a line, not its mention
#: inside an `echo "... retrying 'service mariadb start'"` message.
START_COMMAND = re.compile(r"^\s*service\s+mariadb\s+start\b")


def _code_lines(text):
    """Non-comment, non-blank lines — what `bash` actually runs."""
    return [
        line
        for line in text.splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    ]


class TheStartIsAdvisory(unittest.TestCase):
    def setUp(self):
        with open(ENTRYPOINT, encoding="utf-8") as fh:
            self.text = fh.read()

    def test_every_mariadb_start_is_guarded(self):
        starts = [l for l in _code_lines(self.text) if START_COMMAND.match(l)]
        self.assertTrue(starts, "the entrypoint no longer starts MariaDB?")
        for line in starts:
            self.assertIn(
                "|| true",
                line,
                "an unguarded `service mariadb start` can end the boot under "
                f"set -e — this is the restart loop: {line.strip()}",
            )


class ReadinessIsBoundedAndReal(unittest.TestCase):
    def setUp(self):
        with open(ENTRYPOINT, encoding="utf-8") as fh:
            self.text = fh.read()
        self.code = _code_lines(self.text)

    def test_the_wait_is_bounded_and_overrideable(self):
        self.assertIn(
            "MARIADB_READY_TIMEOUT",
            self.text,
            "no bounded MariaDB readiness timeout",
        )
        # A non-numeric override must not reach the deadline arithmetic.
        self.assertIn(
            "''|*[!0-9]*) MARIADB_READY_TIMEOUT=300",
            self.text,
            "the timeout override is not guarded against a non-numeric value",
        )

    def test_readiness_is_a_real_query_not_ping(self):
        probes = [l for l in self.code if "SELECT 1" in l]
        self.assertTrue(probes, "no readiness probe found")
        self.assertTrue(
            any("mysql " in l for l in probes),
            "the readiness probe is not a `mysql` query",
        )
        self.assertFalse(
            [l for l in self.code if "mysqladmin" in l and "ping" in l],
            "`mysqladmin ping` exits 0 even on Access denied — it is not "
            "readiness",
        )

    def test_the_wait_precedes_the_first_database_consumer(self):
        wait = next(
            (i for i, l in enumerate(self.code) if "SELECT 1" in l),
            None,
        )
        consumer = next(
            (i for i, l in enumerate(self.code) if "mysql -u root" in l),
            None,
        )
        self.assertIsNotNone(wait, "no readiness wait")
        self.assertIsNotNone(consumer, "no `mysql -u root` consumer found")
        self.assertLess(
            wait,
            consumer,
            "the first `mysql -u root` step runs before MariaDB is waited for",
        )


if __name__ == "__main__":
    unittest.main()
