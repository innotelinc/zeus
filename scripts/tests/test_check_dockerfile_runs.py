#!/usr/bin/env python3
"""Unit tests for scripts/check_dockerfile_runs.py.

The checker's value is that it reconstructs a RUN body exactly the way
BuildKit does, so most of these tests pin that reconstruction: how
continuations join, which lines vanish, and what counts as heredoc data
rather than code.

Run:  python3 -m unittest discover -s scripts/tests -v
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts"))

import check_dockerfile_runs as checker  # noqa: E402


class Harness(unittest.TestCase):
    def bodies(self, text: str, name: str = "Dockerfile"):
        tmp = Path(tempfile.mkdtemp()) / name
        tmp.write_text(text, encoding="utf-8")
        return checker.run_bodies(tmp)

    def first(self, text: str) -> checker.RunBody:
        bodies = self.bodies(text)
        self.assertTrue(bodies, "expected at least one RUN body")
        return bodies[0]


class TestReconstruction(Harness):
    def test_continuations_join_without_a_separator(self):
        # BuildKit removes the backslash *and* the newline; the next line's
        # indentation stays, which is why `&&` + "    for" is what the shell
        # really sees.
        body = self.first("RUN apt update && \\\n    echo hi\n")
        self.assertEqual(body.text, "apt update &&     echo hi")
        self.assertIsNone(checker.check_body(body))

    def test_comment_lines_are_dropped_even_between_continuations(self):
        body = self.first(
            "RUN echo one && \\\n"
            "    # this whole line disappears, like BuildKit does\n"
            "    echo two\n"
        )
        self.assertEqual(body.text, "echo one &&     echo two")

    def test_leading_comment_and_blank_lines_are_not_instructions(self):
        bodies = self.bodies("# a note\n\nRUN echo hi\n")
        self.assertEqual(len(bodies), 1)
        self.assertEqual(bodies[0].index, 1)

    def test_line_number_points_at_the_instruction(self):
        body = self.first("# note\n\nRUN echo hi\n")
        self.assertEqual(body.line, 3)

    def test_line_number_is_the_start_of_a_continued_instruction(self):
        # The reported line must be where the instruction *begins*, not where it
        # ends: with a multi-line RUN the two differ, and the end is useless for
        # finding the body that just failed.
        body = self.first("# note\n\nRUN echo one && \\\n    echo two\n")
        self.assertEqual(body.line, 3)
        self.assertEqual(body.text, "echo one &&     echo two")

    def test_non_run_instructions_are_ignored(self):
        bodies = self.bodies(
            "FROM debian:12-slim\nCOPY a b\nENV X=1\nRUN echo hi\nCMD [\"true\"]\n"
        )
        self.assertEqual([b.index for b in bodies], [1])
        self.assertEqual(bodies[0].text, "echo hi")

    def test_runs_are_numbered_separately_from_other_instructions(self):
        bodies = self.bodies("RUN echo a\nCOPY x y\nRUN echo b\nRUN echo c\n")
        self.assertEqual([b.index for b in bodies], [1, 2, 3])
        self.assertEqual([b.text for b in bodies], ["echo a", "echo b", "echo c"])


class TestHeredocs(Harness):
    def test_body_is_preserved_verbatim(self):
        body = self.first(
            "RUN cat > /etc/x.conf <<'EOF'\n"
            "[general]\n"
            "; a comment, and an unbalanced ' quote\n"
            "# not a Dockerfile comment here\n"
            "EOF\n"
        )
        self.assertIn("<<'EOF'", body.text)
        self.assertIn("; a comment, and an unbalanced ' quote", body.text)
        self.assertIn("# not a Dockerfile comment here", body.text)
        self.assertTrue(body.text.rstrip().endswith("EOF"))

    def test_body_is_data_so_odd_content_still_parses(self):
        # If the body were parsed as shell, the stray quote would be a syntax
        # error — the whole point of keeping heredoc bodies verbatim.
        body = self.first("RUN cat <<EOF\nit's not shell\nEOF\n")
        self.assertIsNone(checker.check_body(body))

    def test_dash_form_strips_tabs_before_matching_the_terminator(self):
        body = self.first("RUN cat <<-EOF\n\tindented body\n\tEOF\n")
        self.assertIn("indented body", body.text)
        self.assertTrue(body.text.rstrip().endswith("EOF"))

    def test_unterminated_heredoc_is_reported(self):
        # `sh -n` stays silent about this one, so the checker has to notice it:
        # an unterminated heredoc means BuildKit swallowed the rest of the file
        # into its body, and the failure shows up as a mystery much later.
        body = self.first("RUN cat <<EOF\nbody without a terminator\n")
        error = checker.check_body(body)
        self.assertIsNotNone(error)
        self.assertIn("<<EOF is never terminated", error)


class TestShellSelection(Harness):
    def test_default_shell_is_sh(self):
        body = self.first("RUN echo hi\n")
        self.assertEqual(body.shell, ["/bin/sh", "-c"])

    def test_shell_instruction_is_honoured(self):
        bodies = self.bodies('SHELL ["/bin/bash", "-c"]\nRUN [[ -n x ]] && echo yes\n')
        self.assertEqual(bodies[0].shell[0], "/bin/bash")
        self.assertIsNone(checker.check_body(bodies[0]))

    def test_bashism_fails_under_sh(self):
        # The counterpart: a bash-only construct must be reported when the body
        # still runs under /bin/sh, which is a real failure in the build.
        # (An array assignment: dash rejects it, bash accepts it. `[[ ]]` would
        # not do — dash parses it as an ordinary command, so `-n` stays quiet.)
        body = self.first("RUN x=(1 2 3) && echo \"${x[1]}\"\n")
        self.assertIsNotNone(checker.check_body(body))


class TestFailureReporting(Harness):
    def test_unclosed_construct_is_reported(self):
        body = self.first("RUN if true; then echo x\n")
        error = checker.check_body(body)
        self.assertIsNotNone(error)
        self.assertIn("Syntax error", error)

    def test_unterminated_quote_is_reported(self):
        body = self.first('RUN echo "never closed\n')
        self.assertIsNotNone(checker.check_body(body))

    def test_broken_function_chain_is_reported(self):
        # The shape that shipped here once: a function definition chained into
        # the following `&&` list with a stray brace left open.
        body = self.first("RUN f() { echo one; && echo two\n")
        self.assertIsNotNone(checker.check_body(body))

    def test_valid_function_chain_passes(self):
        body = self.first(
            "RUN apt_retry() { \\\n"
            "      while :; do echo x; done; \\\n"
            "    } && \\\n"
            "    apt_retry echo hi\n"
        )
        self.assertIsNone(checker.check_body(body))

    def test_real_retry_helper_between_a_left_brace_and_an_and_list(self):
        # The exact shape the Dockerfile ships: a function whose body ends with
        # `;` then `}` chained into `&&`. If the brace were unbalanced or the
        # chain misplaced, this is where it would show up.
        text = Path(REPO / "Dockerfile.full").read_text(encoding="utf-8")
        start = text.index("apt_retry() {")
        self.assertIn("} && \\\n    apt_retry -y install", text[start : start + 900])


class TestRealDockerfiles(unittest.TestCase):
    def test_every_tracked_dockerfile_parses(self):
        targets = checker.dockerfiles(REPO, [])
        self.assertTrue(targets, "expected to find the repo's Dockerfiles")
        bad = []
        for path in targets:
            for body in checker.run_bodies(path):
                error = checker.check_body(body)
                if error:
                    bad.append(f"{path.relative_to(REPO)} RUN #{body.index}: {error}")
        self.assertEqual(bad, [])

    def test_full_dockerfile_is_covered(self):
        full = REPO / "Dockerfile.full"
        texts = " ".join(b.text for b in checker.run_bodies(full))
        self.assertIn("freepbx-17.0.19.32.tgz", texts)
        self.assertIn("installlocal", texts)


class TestCommandLine(unittest.TestCase):
    """The exit code is the whole contract with CI, so pin it."""

    def run_cli(self, text: str) -> subprocess.CompletedProcess:
        tmp = Path(tempfile.mkdtemp()) / "Dockerfile"
        tmp.write_text(text, encoding="utf-8")
        return subprocess.run(
            [sys.executable, str(REPO / "scripts" / "check_dockerfile_runs.py"), str(tmp)],
            capture_output=True, text=True,
        )

    def test_cli_fails_on_a_broken_body(self):
        proc = self.run_cli("# note\nRUN if true; then echo x\n")
        self.assertEqual(proc.returncode, 1, proc.stdout + proc.stderr)
        # The report has to locate the body inside the file, not just complain.
        self.assertIn("RUN #1 (starts line 2)", proc.stdout)

    def test_cli_passes_a_clean_file(self):
        proc = self.run_cli("FROM debian:12-slim\nRUN echo hi\n")
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn("all 1 RUN bodies parse", proc.stdout)


if __name__ == "__main__":
    unittest.main()
