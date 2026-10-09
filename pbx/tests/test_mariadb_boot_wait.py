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
    step runs against a server that has not answered yet;
  * how long the wait took is **logged** on success (a slow volume should be
    visible in the boot log, not only when it finally times out).

The invariants above are pinned textually; the reboot itself is *rehearsed*
against stub commands (`service` that reports failure, a `mysql` that is slow to
answer, a clock advance) so the survival of the 2026-10-08 case is measured
rather than argued — see TheBootSurvivesASlowDaemon.

Run:  python3 -m unittest discover -s pbx/tests -v
"""
import os
import re
import subprocess
import tempfile
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


class TheRecoveryIsTimed(unittest.TestCase):
    def setUp(self):
        with open(ENTRYPOINT, encoding="utf-8") as fh:
            self.text = fh.read()
        self.code = _code_lines(self.text)

    def test_the_wait_is_timed_from_before_the_first_probe(self):
        start = next(
            (i for i, l in enumerate(self.code) if "MARIADB_WAIT_BEGAN=" in l),
            None,
        )
        probe = next(
            (i for i, l in enumerate(self.code) if "SELECT 1" in l),
            None,
        )
        self.assertIsNotNone(start, "the wait is not timed")
        self.assertIsNotNone(probe, "no readiness probe found")
        self.assertLess(
            start,
            probe,
            "the clock starts after the first probe, so recovery is undercounted",
        )

    def test_the_elapsed_time_is_reported_on_success(self):
        elapsed = [
            l for l in self.code if "MARIADB_RECOVERY_SECS=" in l and "date +%s" in l
        ]
        self.assertTrue(elapsed, "no elapsed-time computation after the wait")
        answer = next(
            (i for i, l in enumerate(self.code) if "MariaDB is answering" in l),
            None,
        )
        self.assertIsNotNone(answer, "the success message is gone")
        reported = [
            l for l in self.code if "MARIADB_RECOVERY_SECS" in l and "echo" in l
        ]
        self.assertTrue(
            reported,
            "the boot log never prints the recovery time it measured",
        )

    def test_the_timeout_message_names_the_elapsed_time(self):
        self.assertIn(
            "NOW - MARIADB_WAIT_BEGAN",
            self.text,
            "a timeout that does not report how long it waited cannot be sized",
        )


# ── The rehearsal ───────────────────────────────────────────────────────────
# The block below is lifted verbatim out of the entrypoint and run under stub
# commands, so the reboot is reproduced instead of described. The stubs are the
# three facts of that outage: the init script reports failure while mariadbd is
# busy recovering (`service ... exit 1`), the server does not answer a query for
# a while (`mysql` fails N probes), and the container is only restarted when the
# wait is *unbounded* — which is why a bounded, advisory wait is the fix.

STUBS = {
    # A clock that advances 2s per call, so a slow-volume boot is rehearsed in
    # milliseconds instead of by really sleeping through the timeout.
    "date": """#!/usr/bin/env bash
f="${ZEUS_SCAN_CLOCK:?}"
n=$(cat "$f" 2>/dev/null || echo 0)
n=$(( n + 2 ))
echo "$n" > "$f"
echo "$n"
""",
    "sleep": "#!/usr/bin/env bash\nexit 0\n",
    "pgrep": "#!/usr/bin/env bash\nexit \"${ZEUS_SCAN_PGREP_RC:-0}\"\n",
    # Fails the first ZEUS_SCAN_MYSQL_FAIL probes, then answers — the redo-log
    # replay window.
    "mysql": """#!/usr/bin/env bash
f="${ZEUS_SCAN_MYSQL_PROBES:?}"
n=$(cat "$f" 2>/dev/null || echo 0)
n=$(( n + 1 ))
echo "$n" > "$f"
if [ "$n" -le "${ZEUS_SCAN_MYSQL_FAIL:-0}" ]; then
  exit 1
fi
echo 1
""",
    "service": """#!/usr/bin/env bash
case "$1 $2" in
  "mariadb start") exit "${ZEUS_SCAN_SERVICE_RC:-1}" ;;
  "mariadb status") echo "mariadb is not running"; exit 0 ;;
esac
exit 0
""",
}


def _mariadb_block(text):
    """The entrypoint's MariaDB start/wait block, verbatim.

    From the first `service mariadb start` through the `fi` that closes the
    success branch (the `fi` *after* the last "MariaDB is answering" line).
    """
    lines = text.splitlines()
    start = next(i for i, l in enumerate(lines) if START_COMMAND.match(l))
    answered = False
    for i in range(start, len(lines)):
        if "MariaDB is answering" in lines[i]:
            answered = True
        if answered and lines[i].strip() == "fi":
            return "\n".join(lines[start : i + 1])
    raise AssertionError("could not find the end of the MariaDB block")


class TheBootSurvivesASlowDaemon(unittest.TestCase):
    """Rehearse the 2026-10-08 reboot on stub commands."""

    def setUp(self):
        with open(ENTRYPOINT, encoding="utf-8") as fh:
            self.block = _mariadb_block(fh.read())
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.stubdir = os.path.join(self.tmp.name, "bin")
        os.makedirs(self.stubdir)
        self.clock = os.path.join(self.tmp.name, "clock")
        self.probes = os.path.join(self.tmp.name, "probes")
        for name, body in STUBS.items():
            path = os.path.join(self.stubdir, name)
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(body)
            os.chmod(path, 0o755)

    def _run(self, *, mysql_fail, pgrep_rc=0, service_rc=1, timeout=300):
        env = dict(os.environ)
        env.update(
            {
                "PATH": self.stubdir + os.pathsep + env.get("PATH", ""),
                "ZEUS_SCAN_CLOCK": self.clock,
                "ZEUS_SCAN_MYSQL_PROBES": self.probes,
                "ZEUS_SCAN_MYSQL_FAIL": str(mysql_fail),
                "ZEUS_SCAN_PGREP_RC": str(pgrep_rc),
                "ZEUS_SCAN_SERVICE_RC": str(service_rc),
                "MARIADB_READY_TIMEOUT": str(timeout),
            }
        )
        result = subprocess.run(
            ["bash", "-c", "set -e\n" + self.block + "\n"],
            env=env,
            capture_output=True,
            text=True,
            timeout=60,
        )
        attempts = 0
        if os.path.exists(self.probes):
            with open(self.probes, encoding="utf-8") as fh:
                attempts = int(fh.read().strip() or 0)
        return result, attempts

    def test_the_retrying_start_message_shape(self):
        """The message the retry branch prints must match what the script greps
        for by hand, so a rehearsal of a dead daemon is really a rehearsal."""
        self.assertIn("retrying 'service mariadb start'", self.block)

    def test_a_failing_start_does_not_end_the_boot(self):
        """The init script reports failure and mariadbd is still replaying; the
        boot must wait it out, not exit (the restart loop)."""
        result, attempts = self._run(mysql_fail=2, service_rc=1)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("MariaDB is answering", result.stdout)
        self.assertEqual(attempts, 3, "the wait did not re-probe until it answered")

    def test_a_recovering_volume_is_visible_in_the_log(self):
        result, _ = self._run(mysql_fail=20, service_rc=1)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(
            "recovering",
            result.stdout,
            "a slow volume must be visible in the boot log, not only on timeout",
        )

    def test_a_dead_daemon_is_restarted_not_just_waited_for(self):
        result, _ = self._run(mysql_fail=20, pgrep_rc=1, service_rc=1)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(
            "retrying 'service mariadb start'",
            result.stdout,
            "a mariadbd that is gone must be restarted, not waited on forever",
        )

    def test_an_unanswering_daemon_fails_loudly_and_bounded(self):
        # Never answers; the clock still advances, so the deadline is reached.
        result, attempts = self._run(mysql_fail=10**9, timeout=20)
        self.assertEqual(result.returncode, 1, "a broken database must fail loudly")
        self.assertIn("ERROR", result.stdout)
        self.assertIn("MARIADB_READY_TIMEOUT", result.stdout)
        self.assertGreater(attempts, 0)


if __name__ == "__main__":
    unittest.main()
