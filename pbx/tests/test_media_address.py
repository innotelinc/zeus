#!/usr/bin/env python3
"""The durable media-address writer, asserted with no PBX and no docker.

`pbx/media_address.py` closes a gap whose signature is one-way audio: Asterisk
advertises its own container address to a LAN phone, the phone obeys the SDP,
and its voice and DTMF are lost while the caller still hears the prompts. The
writer's two jobs are pinned here rather than only measured on `.30`:

  * **A reachable address.** A docker, loopback or link-local address is refused
    by name — an empty or wrong value is exactly the bug being fixed, so writing
    it is worse than refusing.
  * **The shared file survives.** The file it keeps its `#include` in is also
    the portal's (`[<ext>](+)` softphone blocks). The include is added once and
    every other byte is carried over untouched.

Run:  python3 -m unittest discover -s pbx/tests -v
"""
from __future__ import annotations

import contextlib
import io
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import media_address as ma  # noqa: E402

# The portal's file, as the softphone path leaves it.
PORTAL_FILE = (
    "; appended by the Zeus portal\n"
    "[4135612020](+)\n"
    "media_encryption=dtls\n"
    "direct_media=no\n"
)


class ParseDevicesTest(unittest.TestCase):
    def test_one_id_per_line_in_order_unique(self):
        self.assertEqual(ma.parse_devices("4135612020\n12000\n4135612020\n\n"),
                         ["4135612020", "12000"])

    def test_keeps_an_extension_a_string(self):
        self.assertEqual(ma.parse_devices("12000\n"), ["12000"])


class BadAddressTest(unittest.TestCase):
    def test_the_lan_address_is_accepted(self):
        self.assertEqual(ma.bad_address("192.168.1.30"), "")

    def test_the_measured_failure_is_refused(self):
        # `c=IN IP4 172.19.0.4` is the whole bug: a docker bridge a phone cannot
        # route to. It must never be written as a "fix".
        self.assertIn("docker", ma.bad_address("172.19.0.4"))

    def test_loopback_nonsense_and_empty_are_refused(self):
        self.assertTrue(ma.bad_address("127.0.0.1"))
        self.assertTrue(ma.bad_address("169.254.1.1"))
        self.assertTrue(ma.bad_address(""))
        self.assertTrue(ma.bad_address("coturn"))
        self.assertTrue(ma.bad_address("192.168.1.300"))

    def test_a_172_outside_dockers_range_is_still_allowed(self):
        # 172.32.0.0/12 is not Docker's; the rule is the range, not the octet.
        self.assertEqual(ma.bad_address("172.32.1.5"), "")


class RenderMediaFileTest(unittest.TestCase):
    def test_one_append_per_endpoint_sorted_numerically(self):
        text = ma.render_media_file(["12000", "9999", "4135612020"], "192.168.1.30")
        self.assertLess(text.index("[9999](+)"), text.index("[12000](+)"))
        self.assertLess(text.index("[12000](+)"), text.index("[4135612020](+)"))
        self.assertEqual(text.count("media_address=192.168.1.30"), 3)

    def test_it_appends_rather_than_defines(self):
        # `(+)` is the whole mechanism: a bare `[<ext>]` would be a second
        # endpoint and res_pjsip would refuse the duplicate.
        self.assertIn("[4135612020](+)", ma.render_media_file(["4135612020"], "192.168.1.30"))
        self.assertNotIn("type=endpoint", ma.render_media_file(["4135612020"], "192.168.1.30"))

    def test_two_renders_are_byte_identical(self):
        one = ma.render_media_file(["12000", "15000"], "192.168.1.30")
        self.assertEqual(one, ma.render_media_file(["15000", "12000"], "192.168.1.30"))


class WithIncludeTest(unittest.TestCase):
    def test_added_once(self):
        once = ma.with_include("")
        twice = ma.with_include(once)
        self.assertEqual(once, twice)
        self.assertEqual(once.count(ma.INCLUDE_LINE), 1)

    def test_the_portals_blocks_survive_untouched(self):
        merged = ma.with_include(PORTAL_FILE)
        self.assertIn(PORTAL_FILE, merged)
        self.assertIn(ma.INCLUDE_LINE, merged)

    def test_the_include_is_a_prelude_before_any_section(self):
        # The portal's block parser extends its last `[<name>]` block to EOF and
        # cuts the whole range on a re-provision. An include line placed before
        # the first header is never inside a block, so it cannot be cut away;
        # appended after the portal's block, it would be.
        merged = ma.with_include(PORTAL_FILE)
        self.assertTrue(merged.startswith(ma.INCLUDE_LINE + "\n"))
        self.assertLess(merged.index(ma.INCLUDE_LINE), merged.index("["))

    def test_prepending_keeps_a_file_without_a_trailing_newline(self):
        merged = ma.with_include("[101](+)\nwebrtc=yes")
        self.assertEqual(merged, ma.INCLUDE_LINE + "\n[101](+)\nwebrtc=yes")

    def test_an_existing_include_is_never_duplicated(self):
        text = f"#include something_else.conf\n{ma.INCLUDE_LINE}\n"
        self.assertEqual(ma.with_include(text), text)


class MainTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="media-address-")
        self.tsv = os.path.join(self.tmp, "devices.tsv")
        with open(self.tsv, "w", encoding="utf-8") as fh:
            fh.write("4135612020\n12000\n")

    def _run(self, *args: str) -> tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = ma.main(list(args))
        return rc, out.getvalue(), err.getvalue()

    def _base(self) -> list[str]:
        return ["--asterisk-dir", self.tmp, "--address", "192.168.1.30",
                "--devices-tsv", self.tsv]

    def _read(self, *parts: str) -> str:
        with open(os.path.join(self.tmp, *parts), encoding="utf-8") as fh:
            return fh.read()

    def test_an_apply_then_a_check_is_in_sync(self):
        rc, _, _ = self._run(*self._base(), "--apply")
        self.assertEqual(rc, 0)
        self.assertIn(ma.INCLUDE_LINE, self._read(ma.INCLUDE_HOST))
        rc, out, _ = self._run(*self._base())
        self.assertEqual(rc, 0)
        self.assertIn("already advertises", out)

    def test_a_box_with_no_media_file_is_drift_not_a_pass(self):
        rc, _, err = self._run(*self._base())
        self.assertEqual(rc, 1)
        self.assertIn(ma.MEDIA_FILE, err)

    def test_check_is_accepted_and_writes_nothing(self):
        rc, _, _ = self._run(*self._base(), "--check")
        self.assertEqual(rc, 1)
        self.assertFalse(os.path.exists(os.path.join(self.tmp, ma.MEDIA_FILE)))

    def test_an_apply_is_idempotent(self):
        self._run(*self._base(), "--apply")
        first = self._read(ma.MEDIA_FILE)
        self._run(*self._base(), "--apply")
        self.assertEqual(first, self._read(ma.MEDIA_FILE))

    def test_an_apply_keeps_the_portals_blocks(self):
        host = os.path.join(self.tmp, ma.INCLUDE_HOST)
        with open(host, "w", encoding="utf-8") as fh:
            fh.write(PORTAL_FILE)
        self._run(*self._base(), "--apply")
        self.assertIn(PORTAL_FILE, self._read(ma.INCLUDE_HOST))

    def test_a_media_address_in_the_shared_file_does_not_stop_the_dedicated_write(self):
        # The legacy shape: the line was hand-added to the portal-shared file,
        # where the portal's own block surgery will cut it. The dedicated file
        # is the durable copy, so the tool must write the extension anyway.
        host = os.path.join(self.tmp, ma.INCLUDE_HOST)
        with open(host, "w", encoding="utf-8") as fh:
            fh.write("[4135612020](+)\nmedia_address=192.168.1.30\n")
        rc, _, _ = self._run(*self._base(), "--apply")
        self.assertEqual(rc, 0)
        self.assertIn("[4135612020](+)", self._read(ma.MEDIA_FILE))

    def test_a_wrong_address_already_on_disk_is_drift(self):
        self._run(*self._base(), "--apply")
        rc, _, _ = self._run("--asterisk-dir", self.tmp, "--address", "192.168.1.31",
                             "--devices-tsv", self.tsv)
        self.assertEqual(rc, 1)

    def test_no_address_is_cannot_tell_not_a_pass(self):
        rc, _, err = self._run("--asterisk-dir", self.tmp, "--address", "",
                               "--devices-tsv", self.tsv)
        self.assertEqual(rc, 2)
        self.assertIn("no address", err)

    def test_a_docker_address_is_refused_rather_than_written(self):
        rc, _, err = self._run("--asterisk-dir", self.tmp, "--address", "172.19.0.4",
                               "--devices-tsv", self.tsv)
        self.assertEqual(rc, 2)
        self.assertIn("docker", err)
        self.assertFalse(os.path.exists(os.path.join(self.tmp, ma.MEDIA_FILE)))

    def test_a_pbx_with_no_endpoint_is_cannot_tell(self):
        blank = os.path.join(self.tmp, "blank.tsv")
        open(blank, "w", encoding="utf-8").close()
        rc, _, err = self._run("--asterisk-dir", self.tmp, "--address", "192.168.1.30",
                               "--devices-tsv", blank)
        self.assertEqual(rc, 2)
        self.assertIn("names no sip/pjsip endpoint", err)

    def test_a_missing_config_dir_is_cannot_tell(self):
        rc, _, err = self._run("--asterisk-dir", os.path.join(self.tmp, "absent"),
                               "--address", "192.168.1.30", "--devices-tsv", self.tsv)
        self.assertEqual(rc, 2)
        self.assertIn("not a directory", err)

    def test_an_unreadable_device_table_is_cannot_tell(self):
        rc, _, err = self._run("--asterisk-dir", self.tmp, "--address", "192.168.1.30",
                               "--devices-tsv", os.path.join(self.tmp, "absent.tsv"))
        self.assertEqual(rc, 2)
        self.assertIn("cannot read", err)


if __name__ == "__main__":
    unittest.main()
