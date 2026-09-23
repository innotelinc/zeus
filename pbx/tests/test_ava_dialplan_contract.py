#!/usr/bin/env python3
"""The hand-off dialplan's contract, asserted without a PBX.

`pbx/asterisk/extensions_custom.conf` decides where an agent's transfer lands,
and a 15-minute timer converges it onto a live PBX, so a mistake here is not
caught by reading a diff — it is caught by a caller. Three properties are the
whole point of the P2 change and each of them fails *silently* if it regresses:

  * 824 is an ENTRY POINT into `[zeus-ai-interview]`, not a target. The
    extension must not reach `dograh-inbound,8000` again: that constant
    answered every hand-off as whichever interview 8000 happened to be, which
    is the defect this replaced.
  * The per-account decision is the only thing that reaches a workflow, and it
    fails closed — an empty `ZEUS_CAPSTONE_TARGET` (no binding) or one naming a
    workflow this PBX does not carry goes to the operator, never to a default
    agent. Reaching *some* agent is the failure mode, not the fallback.
  * 824 is named by three files — config/ava/ai-agent.yaml's transfer
    inventory, src/lib/handoff.ts's classifier, and this dialplan — so the test
    reads all three and a change to any one of them is caught here rather than
    in production.

Run:  python3 -m unittest discover -s pbx/tests -v
"""
import os
import re
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import asterisk_converge as ac  # noqa: E402

ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", ".."))
DIALPLAN = os.path.join(ROOT, "pbx", "asterisk", "extensions_custom.conf")
AGENT_YAML = os.path.join(ROOT, "config", "ava", "ai-agent.yaml")
HANDOFF_TS = os.path.join(ROOT, "src", "lib", "handoff.ts")

#: The two destinations [zeus-ai-handoff] owns. 824 is the one AVA's transfer
#: inventory names; both are a caller's way out of the agent.
HANDOFF_EXTEN = "824"
OPERATOR_EXTEN = "0"


def _read(path: str) -> str:
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def _contexts(text: str) -> dict[str, list[str]]:
    """{context: [directive, ...]} — comments and blank lines dropped.

    Only the directives matter here, and keeping the list ordered is what lets
    the gate assertions below say "before" instead of "somewhere".
    """
    out: dict[str, list[str]] = {}
    current = None
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("[") and stripped.endswith("]"):
            current = stripped[1:-1]
            out[current] = []
        elif current is not None and stripped and not stripped.startswith(";"):
            out[current].append(stripped)
    return out


def _executable(text: str) -> str:
    """The file with comment and blank lines removed.

    Comments are prose here — they explain the retired constant on purpose —
    so "this constant is gone" has to mean gone from what Asterisk reads.
    """
    return "\n".join(
        line for line in text.splitlines()
        if line.strip() and not line.strip().startswith(";")
    )


def _directive(lines: list[str], exten: str) -> list[str]:
    """The lines belonging to one extension, in order.

    `exten => 824,1,…` followed by its `same => n,…` continuations is one
    extension's body: the assertions join it and read it as one string, so
    order within the body is what "the gate runs first" is measured against.
    """
    body: list[str] = []
    collecting = False
    for line in lines:
        if line.startswith("exten"):
            if collecting:
                break
            collecting = re.match(rf"exten\s*=>\s*{re.escape(exten)},", line) is not None
            if collecting:
                body.append(line)
        elif collecting:
            body.append(line)
    return body


def _block(text: str, key: str) -> str:
    """The indented body of `key:` in a YAML file, by indentation, without PyYAML.

    The block's *shape* is the contract here (one destination per block), so a
    stdlib reader is honest about what is being asserted — and keeps the suite
    runnable on a box with no third-party packages, which is the PBX.
    """
    lines = text.splitlines()
    for i, line in enumerate(lines):
        if line.strip() == f"{key}:":
            indent = len(line) - len(line.lstrip())
            body = []
            for follow in lines[i + 1:]:
                if follow.strip() and (len(follow) - len(follow.lstrip())) <= indent:
                    break
                body.append(follow)
            return "\n".join(body)
    raise AssertionError(f"no {key}: block in {text[:40]!r}…")


class Fixture(unittest.TestCase):
    """Shared read of the fragment, so every case asserts on the same bytes."""

    @classmethod
    def setUpClass(cls):
        cls.text = _read(DIALPLAN)
        cls.ctx = _contexts(cls.text)


class HandoffTest(Fixture):
    """The only destinations an agent may dial — and 824 is no longer one."""

    def test_handoff_carries_the_inventory_plus_the_refusals(self):
        lines = self.ctx["zeus-ai-handoff"]
        self.assertTrue(_directive(lines, HANDOFF_EXTEN))
        self.assertTrue(_directive(lines, OPERATOR_EXTEN))
        self.assertTrue(_directive(lines, "refused"))

    def test_catch_all_refuses_and_is_kept_last(self):
        # A literal destination above must always win: the catch-all is the
        # backstop for an agent that invented an extension, not a router.
        lines = self.ctx["zeus-ai-handoff"]
        declares = [i for i, line in enumerate(lines) if line.startswith("exten")]
        self.assertTrue(lines[declares[-1]].startswith("exten => _X."))
        self.assertEqual(lines[declares[-1] + 1], "same  => n,Goto(refused,1)")

    def test_824_enters_the_interview_context_rather_than_a_target(self):
        body = "\n".join(_directive(self.ctx["zeus-ai-handoff"], HANDOFF_EXTEN))
        self.assertIn("Goto(zeus-ai-interview,s,1)", body)
        self.assertNotIn("dograh-inbound", body)

    def test_the_retired_constant_is_gone_from_the_dialplan(self):
        # Both halves of the old fallback: the fixed extension AND the bare
        # Stasis app name, which no ARI client registers — entering it was a
        # silent Hangup() that read as a routing problem. (Comments still
        # describe both on purpose, so this reads the directives.)
        executable = _executable(self.text)
        self.assertNotIn("dograh-inbound,8000", executable)
        self.assertNotIn("Stasis(dograh)", executable)


class InterviewTest(Fixture):
    """Which workflow an account reaches, and the rule that it cannot guess."""

    def test_the_addon_gate_runs_before_anything_can_be_reached(self):
        body = self.ctx["zeus-ai-interview"]
        gate = "\n".join(body)
        self.assertIn('GotoIf($["${ZEUS_CAPSTONE_ADDON}"="1"]?target,1:zeus-ai-handoff,refused,1)', gate)
        self.assertLess(gate.index("ZEUS_CAPSTONE_ADDON"), gate.index("ZEUS_CAPSTONE_TARGET"))

    def test_an_empty_target_refuses_rather_than_defaulting(self):
        body = _directive(self.ctx["zeus-ai-interview"], "target")
        self.assertIn('GotoIf($["${ZEUS_CAPSTONE_TARGET}"=""]?zeus-ai-handoff,refused,1)', "\n".join(body))

    def test_a_target_naming_an_absent_workflow_refuses(self):
        # The last line of `target` is the fall-through: it must be the same
        # operator refusal, not a direct enter of an app name that rotates.
        body = _directive(self.ctx["zeus-ai-interview"], "target")
        self.assertEqual(body[-1], "same  => n,Goto(zeus-ai-handoff,refused,1)")

    def test_the_only_workflow_reached_is_the_one_the_binding_names(self):
        hits = set(re.findall(r"dograh-inbound,[^\s,)]+", _executable(self.text)))
        # Every mention is the variable — a literal here would be a dialplan
        # constant for whatever that extension is today, which is the bug,
        # and one extension for every account, which is the defect behind it.
        self.assertEqual(hits, {"dograh-inbound,${ZEUS_CAPSTONE_TARGET}"})

    def test_it_enters_through_the_consulted_context_not_stasis(self):
        body = "\n".join(self.ctx["zeus-ai-interview"])
        self.assertNotIn("Stasis(", body)
        self.assertIn("DIALPLAN_EXISTS(dograh-inbound,${ZEUS_CAPSTONE_TARGET},1)", body)


class ReturnTest(Fixture):
    """The way back from Capstone: to an agent, or to the operator — never a guess."""

    def test_a_named_agent_continues_the_call(self):
        body = _directive(self.ctx["zeus-ai-return"], "s")
        self.assertIn('GotoIf($["${AI_AGENT}"!=""]?zeus-ai-first-response,s,1)', "\n".join(body))

    def test_no_agent_goes_to_the_operator_instead_of_the_default_agent(self):
        # `[zeus-ai-first-response]` would substitute `receptionist` for an
        # unset AI_AGENT. That is right for an inbound call and wrong here: a
        # returning interview is a call with context, and handing it to
        # whichever agent the default is would lose it silently.
        lines = _directive(self.ctx["zeus-ai-return"], "s")
        body = "\n".join(lines)
        self.assertIn('GotoIf($["${DIALPLAN_EXISTS(from-internal,0,1)}"="1"]?from-internal,0,1)', body)
        self.assertIn("Playback(ss-noservice)", body)
        self.assertIn("Hangup()", body)
        # The agent check comes first, and `receptionist` — the value
        # [zeus-ai-first-response] substitutes — is never named here.
        self.assertLess(body.index("AI_AGENT"), body.index("from-internal,0,1"))
        self.assertNotIn("receptionist", body)

    def test_any_extension_reaches_the_same_decision(self):
        self.assertEqual(_directive(self.ctx["zeus-ai-return"], "_X."),
                         ["exten => _X.,1,Goto(s,1)"])


class ThreeFileContractTest(unittest.TestCase):
    """824 is one contract read from three sides; each side is asserted here."""

    def test_the_engine_s_transfer_inventory_points_at_the_entry_point(self):
        block = _block(_read(AGENT_YAML), "capstone_interview")
        target = re.search(r'^\s*target:\s*"?(\d+)"?\s*$', block, re.M)
        context = re.search(r"^\s*dialplan_context:\s*(\S+)\s*$", block, re.M)
        self.assertIsNotNone(target, block)
        self.assertIsNotNone(context, block)
        self.assertEqual(target.group(1), HANDOFF_EXTEN)
        self.assertEqual(context.group(1), "zeus-ai-handoff")

    def test_the_dialplan_context_the_inventory_names_exists(self):
        context = re.search(
            r"^\s*dialplan_context:\s*(\S+)\s*$",
            _block(_read(AGENT_YAML), "capstone_interview"),
            re.M,
        ).group(1)
        self.assertIn(f"[{context}]", _read(DIALPLAN))

    def test_the_operator_destination_is_the_one_the_file_owns(self):
        block = _block(_read(AGENT_YAML), "operator")
        self.assertEqual(re.search(r'^\s*target:\s*"?(\d+)"?\s*$', block, re.M).group(1),
                         OPERATOR_EXTEN)

    def test_the_portal_classifier_knows_the_same_extension(self):
        # Classified by destination, so a transfer the engine recorded as 824
        # is counted as a Capstone hand-off on the record screen. A literal
        # read: the list is the contract, and importing TypeScript from here
        # is not worth a build dependency in a PBX test.
        text = _read(HANDOFF_TS)
        listed = re.search(r"CAPSTONE_DESTINATIONS\s*=\s*\[(.*?)\]", text, re.S)
        self.assertIsNotNone(listed, "CAPSTONE_DESTINATIONS is the contract this reads")
        self.assertIn(f'"{HANDOFF_EXTEN}"', listed.group(1))


class ConvergenceTest(unittest.TestCase):
    """The fragment is converged by a timer, so it has to be merge-stable.

    One caveat is asserted rather than wished away: `merge_into` replaces the
    contexts its source defines and leaves everything else alone (other
    products share this file). It therefore cannot *retire* a context. That is
    safe for this file today — reverting P2 restores `[zeus-ai-handoff]`'s
    constant and leaves `[zeus-ai-interview]` entered by nothing — but a
    rollback that deletes a context instead of restoring one has to delete the
    live copy on the box too.
    """

    def test_every_context_converges_once_into_a_foreign_file(self):
        stock = (
            "; FreePBX-generated extensions_custom.conf content\n"
            "[from-internal-additional]\nexten => 100,1,Answer()\n"
        )
        merged = ac.merge_into(stock, _read(DIALPLAN), owner="zeus")
        contexts = _contexts(merged)
        for name in ["zeus-ai-router", "zeus-ai-first-response", "zeus-ai-handoff",
                     "zeus-ai-interview", "zeus-ai-return", "zeus-ai-accounts"]:
            with self.subTest(context=name):
                self.assertIn(name, contexts)
        self.assertIn("[from-internal-additional]", merged)

    def test_the_new_contexts_survive_a_reconverge_byte_identically(self):
        once = ac.merge_into(_read(DIALPLAN), _read(DIALPLAN), owner="zeus")
        twice = ac.merge_into(once, _read(DIALPLAN), owner="zeus")
        self.assertEqual(once, twice)
        self.assertEqual(_contexts(once).keys(), _contexts(_read(DIALPLAN)).keys())

    def test_a_context_the_source_stops_defining_is_left_on_the_target(self):
        # Not an endorsement — the tool must not clobber a sharing product's
        # contexts — but a rollback has to know it: re-converging the reverted
        # file leaves [zeus-ai-interview] on the box, entered by nothing.
        trimmed = _read(DIALPLAN).replace("[zeus-ai-interview]", "[zeus-ai-interview-retired]")
        merged = ac.merge_into(_read(DIALPLAN), trimmed, owner="zeus")
        self.assertIn("[zeus-ai-interview-retired]", merged)
        self.assertIn("[zeus-ai-interview]", merged)

    def test_a_reverted_file_leaves_the_retired_context_unreached(self):
        # The honest version of the rollback note: restoring the pre-P2
        # [zeus-ai-handoff] puts the constant back, and nothing enters the
        # left-behind interview context — so a caller is routed exactly as
        # before the phase, not to whichever of the two definitions came last.
        reverted = _read(DIALPLAN).replace(
            "same  => n,Goto(zeus-ai-interview,s,1)",
            "same  => n,GotoIf($[\"${ZEUS_CAPSTONE_ADDON}\"=\"1\"]?824,3:refused,1)",
        )
        merged = ac.merge_into(_read(DIALPLAN), reverted, owner="zeus")
        # Nothing in the merged file enters the left-behind context any more.
        entries = [line for line in _executable(merged).splitlines()
                   if "zeus-ai-interview," in line]
        self.assertEqual(entries, [])


if __name__ == "__main__":
    unittest.main()
