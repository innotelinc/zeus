#!/usr/bin/env python3
"""The structural-parity checklist's Zeus-side rows, closed off-host.

`docs/voice-convergence.md` §8 is the gate for retiring Capstone's
bundled PBX, and its own reading rules say what this repo owes it: rows **1, 2
and 12** must be verifiable *here*, without `.30`, so the other side can flip a
default without taking the voice plane down with it. Three rows, three things
that fail quietly:

  * **Row 1 (Dialplan)** — both products write ONE
    `extensions_custom.conf`. A fragment that defines a context another product
    owns, or a converge that disturbs the other owner's marked segment, is a
    silent clobber: the calls still answer, as whatever the last writer left.
    `test_asterisk_converge.py` proves the merger's semantics; what is asserted
    here is the *shipped* fragment and the two-owner round trip it has to
    survive — including the order independence the two `--check` runs depend on.

  * **Row 2 (ARI)** — one ARI file carries every product's user, and sorcery
    refuses the **whole file** on a duplicate object, so one duplicated user
    costs every ARI user and reads as a wrong password
    (`pbx/asterisk/ari.conf` documents the incident). The split this repo
    already made — the portal's user in `ari.conf`, AVA's in
    `ari_additional_custom.conf` — is the thing that must not regress.

  * **Row 12 (Fail-closed default)** — the deprecation is a compose change on
    the Capstone side, and the check in the table is `docker compose config
    --services` on the shared box: with `CAPSTONE_PBX=zeus` and no profile it
    must name no `freepbx`/`coturn`/`pbx-portal`. The shared box has both
    checkouts side by side, so that is checkable from here — and *skipped*, not
    faked, on a standalone Zeus clone that has no Capstone tree to read.

Run:  python3 -m unittest discover -s pbx/tests -v
"""
import os
import re
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import asterisk_converge as ac  # noqa: E402

ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", ".."))
PBX_ASTERISK = os.path.join(ROOT, "pbx", "asterisk")
ZEUS_FRAGMENT = os.path.join(PBX_ASTERISK, "extensions_custom.conf")
BOOTSTRAP = os.path.join(ROOT, "pbx", "bootstrap-zeus-pbx.sh")
BASE_COMPOSE = os.path.join(ROOT, "docker-compose.yml")
FULL_COMPOSE = os.path.join(ROOT, "docker-compose.full.yml")
#: The sibling checkout the row-12 check reads. Overridable so the test can be
#: pointed at a worktree; absent means skip, never a silent pass.
CAPSTONE_COMPOSE = os.environ.get(
    "CAPSTONE_COMPOSE",
    os.path.normpath(os.path.join(ROOT, "..", "capstone", "docker-compose.yml")),
)

SHARED = {"from-internal-custom"}


def _read(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def _executable(text):
    """The file with comments and blanks removed — what Asterisk reads."""
    return "\n".join(
        line for line in text.splitlines()
        if line.strip() and not line.strip().startswith(";")
    )


def _sections(text):
    """Every section/context name in a config file, in order."""
    return re.findall(r"^\s*\[([^\]]+)\]\s*(?:;.*)?$", text, re.M)


def _segment(text, owner):
    """The lines an owner's append-shared segment holds, markers included."""
    lines = text.splitlines()
    begin, end = f"; >>> begin {owner}", f"; >>> end {owner}"
    try:
        start = lines.index(begin)
        stop = lines.index(end, start)
    except ValueError as exc:  # pragma: no cover - a fixture, not a product
        raise AssertionError(f"no {owner!r} marked segment in:\n{text}") from exc
    return lines[start:stop + 1]


#: Capstone's fragment, in the shape `--owner capstone --append
#: from-internal-custom` converges (pbx/README.md): agent extensions inside the
#: shared context, and its own `[dograh-inbound]` context beside them.
CAPSTONE_FRAGMENT = (
    "[from-internal-custom]\n"
    "exten => 8000,1,NoOp(Dialing the IT agent)\n"
    " same => n,Goto(dograh-inbound,8000,1)\n"
    "\n"
    "[dograh-inbound]\n"
    "exten => 8000,1,Stasis(dograh_deadbeef)\n"
    " same => n,Hangup()\n"
)

#: FreePBX's own file, with a GUI-added entry and nothing else.
STOCK = (
    "; FreePBX-generated extensions_custom.conf content\n"
    "[from-internal-additional]\n"
    "exten => 100,1,Answer()\n"
)


class Row1DialplanTest(unittest.TestCase):
    """One owner per fragment, and the fragment this repo actually ships."""

    @classmethod
    def setUpClass(cls):
        cls.zeus = _read(ZEUS_FRAGMENT)

    def test_the_shipped_fragment_defines_only_zeus_contexts(self):
        # `--owner capstone` may only ever write its own contexts, and it can
        # only be sure of that if this fragment defines none of them. Capstone's
        # dialplan context belongs to Capstone's fragment; its agent extensions
        # (8000-8007) live inside the shared context, which neither side owns
        # wholesale.
        self.assertFalse([name for name in _sections(self.zeus) if "dograh" in name])

    def test_zeus_ships_no_inbound_routing_at_all(self):
        # The DID -> workflow decision lives in FreePBX's `incoming` table now,
        # so this fragment must name no destination for it. A literal would be a
        # dialplan constant for one workflow; a variable would be a second
        # routing authority beside the row that actually answers the call.
        # (Comments describe the retired router on purpose, so read directives.)
        executable = _executable(self.zeus)
        self.assertIsNone(re.search(r"dograh-inbound", executable))

    def test_the_two_owners_converge_without_either_losing_a_context(self):
        # The two timers fire in whatever order they fire in, and neither may
        # depend on that: each order has to keep every context and every
        # product's segment, and leave the pair a fixed point for both owners.
        capstone_first = ac.merge_into(STOCK, CAPSTONE_FRAGMENT, owner="capstone", append_shared=SHARED)
        zeus_second = ac.merge_into(capstone_first, self.zeus, owner="zeus", append_shared=SHARED)
        zeus_first = ac.merge_into(STOCK, self.zeus, owner="zeus", append_shared=SHARED)
        capstone_second = ac.merge_into(zeus_first, CAPSTONE_FRAGMENT, owner="capstone", append_shared=SHARED)

        self.assertEqual(sorted(_sections(zeus_second)), sorted(_sections(capstone_second)))
        for merged in (zeus_second, capstone_second):
            with self.subTest(order="capstone-then-zeus" if merged is zeus_second else "zeus-then-capstone"):
                sections = _sections(merged)
                self.assertEqual(len(sections), len(set(sections)), sections)
                self.assertIn("[from-internal-additional]", merged)
                self.assertIn("[dograh-inbound]", merged)
                self.assertIn("Stasis(dograh_deadbeef)", merged)
                # A fixed point for both owners: this is what makes the two
                # `--check` runs report "in sync" rather than re-applying for
                # ever (the timer's whole failure mode would be silent).
                self.assertEqual(ac.merge_into(merged, self.zeus, owner="zeus", append_shared=SHARED), merged)
                self.assertEqual(
                    ac.merge_into(merged, CAPSTONE_FRAGMENT, owner="capstone", append_shared=SHARED), merged
                )

    def test_a_zeus_reapply_does_not_disturb_capstones_segment(self):
        capstone_first = ac.merge_into(STOCK, CAPSTONE_FRAGMENT, owner="capstone", append_shared=SHARED)
        merged = ac.merge_into(capstone_first, self.zeus, owner="zeus", append_shared=SHARED)
        self.assertEqual(_segment(merged, "capstone"), _segment(capstone_first, "capstone"))

        # Each owner alone is byte-idempotent: a re-apply must not reorder the
        # other's segment (the regression test_asterisk_converge.py records —
        # strip-and-re-append at the tail).
        self.assertEqual(ac.merge_into(merged, self.zeus, owner="zeus", append_shared=SHARED), merged)
        self.assertEqual(
            ac.merge_into(merged, CAPSTONE_FRAGMENT, owner="capstone", append_shared=SHARED), merged
        )
        # Both owners still have exactly one segment, in the shared context.
        self.assertEqual(merged.count("; >>> begin zeus"), 1)
        self.assertEqual(merged.count("; >>> begin capstone"), 1)
        self.assertEqual(_sections(merged).count("from-internal-custom"), 1)

    def test_capstones_own_context_is_never_replaced_by_zeus(self):
        # A replace-ownership policy applied to a foreign context would rewrite
        # it from a fragment that does not define it — which is a deletion.
        merged = ac.merge_into(
            ac.merge_into(STOCK, CAPSTONE_FRAGMENT, owner="capstone", append_shared=SHARED),
            self.zeus, owner="zeus", append_shared=SHARED,
        )
        self.assertIn("Stasis(dograh_deadbeef)", merged)


class Row2AriTest(unittest.TestCase):
    """One ARI user per owner — a duplicate costs every user, not one."""

    @classmethod
    def setUpClass(cls):
        cls.portal = _read(os.path.join(PBX_ASTERISK, "ari.conf"))
        cls.bootstrap = _read(BOOTSTRAP)

    def test_the_portal_fragment_defines_exactly_one_user(self):
        # Zeus owns one ARI user. Anything else in here is a second owner, which
        # sorcery refuses wholesale: a duplicate object costs EVERY ARI user, not
        # just the one repeated.
        self.assertEqual(_sections(self.portal), ["__ARI_USER__"])

    def test_the_portal_fragment_is_converge_owned(self):
        # Wholesale-copied, it would clobber another product's ARI users.
        owned = re.search(r"^CONVERGE_OWNED=\"(.*)\"$", self.bootstrap, re.M)
        self.assertIsNotNone(owned, "CONVERGE_OWNED is what routes these through converge")
        self.assertIn("ari.conf", owned.group(1).split())

    def test_converging_every_product_leaves_one_of_each_user(self):
        """The row's own failure mode: a duplicate object, not a missing one.

        `ari.conf` ends with comment prose after its last section. The generic
        parser hands that prose to the next section's attributed prefix, so
        the replacement policy must recognise it as the previous section's
        source tail and keep the merged bytes stable across timer applies.
        """
        capstone_user = "[dograh]\ntype = user\npassword = shared-with-pbx\nread_only = no\n"
        target = "[general]\nenabled = yes\n\n" + capstone_user
        merged = target
        for fragment in (self.portal,):
            merged = ac.merge_into(merged, fragment, owner="zeus")

        sections = _sections(merged)
        self.assertEqual(len(sections), len(set(sections)), sections)
        self.assertEqual(sorted(sections), ["__ARI_USER__", "dograh", "general"])
        # Foreign content and FreePBX's own section pass through untouched…
        self.assertIn("password = shared-with-pbx", merged)
        self.assertIn("enabled = yes", merged)
        # …and a re-converge adds no second user and loses none, which is what
        # the ARI user must be stable against however often the timer ticks.
        again = merged
        for fragment in (self.portal,):
            again = ac.merge_into(again, fragment, owner="zeus")
        self.assertEqual(sorted(_sections(again)), sorted(sections))
        self.assertEqual(again.count("type = user"), merged.count("type = user"))
        self.assertEqual(again, merged)


def compose_services(path):
    """{service: {"profiles": [...], "container_name": str|None}} from a compose file.

    A stdlib reader on purpose — the box this suite runs on has no PyYAML, and
    the only thing asserted is which services carry a non-empty `profiles:`,
    which is one 4-space-indented key per service.
    """
    services = {}
    in_services = False
    current = None
    for line in _read(path).splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        indent = len(line) - len(line.lstrip())
        stripped = line.strip()
        if indent == 0:
            in_services = stripped == "services:"
            current = None
            continue
        if not in_services:
            continue
        if indent == 2 and stripped.endswith(":"):
            current = stripped[:-1].strip()
            services[current] = {"profiles": None, "container_name": None}
        elif current and indent == 4:
            if stripped.startswith("profiles:"):
                value = stripped.split(":", 1)[1].split("#", 1)[0].strip()
                services[current]["profiles"] = [
                    item.strip().strip("\"'") for item in value.strip("[]").split(",") if item.strip()
                ]
            elif stripped.startswith("container_name:"):
                services[current]["container_name"] = stripped.split(":", 1)[1].split("#", 1)[0].strip().strip("\"'")
    return services


class Row12FailClosedDefaultTest(unittest.TestCase):
    """A second PBX has to take a flag to appear — checked where it is defined."""

    def test_zeus_supplies_the_layers_the_bundled_pbx_supplied(self):
        # This is the half that makes the flip safe: when Capstone's `freepbx`
        # and `coturn` stop starting, these are what answers instead. Asserted
        # before the Capstone-side check so a standalone clone still gets it.
        shared_plane = compose_services(FULL_COMPOSE)
        self.assertIn("freepbx", shared_plane)
        self.assertIn("coturn", shared_plane)
        # The portal-only deployment must not imply a PBX at all: `docker
        # compose config --services` on it naming `freepbx` would be a second
        # switchboard nobody asked for.
        self.assertNotIn("freepbx", compose_services(BASE_COMPOSE))

    @unittest.skipUnless(
        os.path.exists(CAPSTONE_COMPOSE),
        f"no Capstone checkout at {CAPSTONE_COMPOSE} (set CAPSTONE_COMPOSE to point at one)",
    )
    def test_the_bundled_pbx_takes_a_flag_to_start(self):
        services = compose_services(CAPSTONE_COMPOSE)
        # Not vacuous: the layers the row names must be here to be gated.
        for layer in ("freepbx", "coturn"):
            self.assertIn(layer, services, f"{layer} is not in {CAPSTONE_COMPOSE}")
            self.assertTrue(
                services[layer]["profiles"],
                f"{layer} has no profiles, so `docker compose config --services` names it "
                f"with no flag and the shared plane gets a second one",
            )
        # The bundled portal follows the bundled PBX (the row calls it
        # `pbx-portal`; the service is named `portal` on this compose).
        for name in ("portal", "pbx-portal"):
            if name in services:
                self.assertTrue(
                    services[name]["profiles"],
                    f"{name} has no profiles, so it starts beside the shared portal",
                )


if __name__ == "__main__":
    unittest.main()
