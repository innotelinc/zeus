/**
 * A leftover endpoint fragment: gone, absent, or still there and why.
 *
 * `removeLegacyFragment` used to answer `false` to two different questions, and
 * they need different things from the operator:
 *
 *   * nothing was on disk  — the normal case, nothing to do;
 *   * it is on disk and this process may not unlink it — a live fault, because
 *     `pjsip_ext_<ext>.conf` defines a second `[<ext>]` and two objects with one
 *     id is what makes res_pjsip refuse a whole configuration.
 *
 * The second case is not hypothetical. Measured on `.30`: the portal's Node
 * server runs as `1001:1001`, and `/etc/asterisk` is `0775` owned by the PBX's
 * own uid — so the portal is "other" on that directory and cannot unlink
 * anything in it, however the file itself is owned. Unlinking needs a write bit
 * on the *directory*; that is the bit that is missing, and it is why the live
 * check's Repair left the fragment on disk while reporting success.
 *
 * The failure is reproduced here with a directory named like the fragment rather
 * than with `chmod`, because these tests run as root on the CI image: root
 * ignores permission bits, and an `EACCES` test written with `chmod` would pass
 * for the wrong reason — or worse, pass while testing nothing.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { load, transpile } from "./ts-probe.mjs";

const { legacyFragmentRemoval, removeLegacyFragment, legacyFragmentName } = await load(
  transpile(["src/lib/pjsip-endpoint.ts"]),
  "pjsip-endpoint",
);

const dirs = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "zeus-legacy-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("removing a leftover endpoint fragment", () => {
  it("names the fragment whether or not it is on disk", () => {
    const dir = tempDir();
    assert.equal(legacyFragmentName("9999"), "pjsip_ext_9999.conf");
    assert.equal(legacyFragmentRemoval("9999", dir).path, join(dir, "pjsip_ext_9999.conf"));
  });

  it("separates 'nothing was there' from 'it is still there'", () => {
    const dir = tempDir();
    const absent = legacyFragmentRemoval("9999", dir);
    assert.equal(absent.present, false);
    assert.equal(absent.removed, false);
    assert.equal(absent.reason, "");

    writeFileSync(join(dir, "pjsip_ext_9999.conf"), `[9999]\ntype=endpoint\n`);
    const present = legacyFragmentRemoval("9999", dir);
    assert.equal(present.present, true);
    assert.equal(present.removed, true, "a fragment in a writable dir must go");
    assert.equal(present.reason, "");
    // And the second call is the "nothing was there" case, not a failure.
    assert.equal(legacyFragmentRemoval("9999", dir).removed, false);
    assert.equal(legacyFragmentRemoval("9999", dir).reason, "");
  });

  it("carries the errno when the unlink is refused, not a bare false", () => {
    const dir = tempDir();
    // A directory where the fragment should be: `rmSync` without `recursive`
    // refuses it with EISDIR/ERR_FS_EISDIR whatever uid this runs as, which is
    // the root-proof stand-in for the EACCES the live box produces.
    mkdirSync(join(dir, "pjsip_ext_9999.conf"));
    const result = legacyFragmentRemoval("9999", dir);
    assert.equal(result.present, true, "it is on disk — that is the fault");
    assert.equal(result.removed, false);
    assert.notEqual(result.reason, "", "a refused removal must say why");
    assert.match(result.path, /pjsip_ext_9999\.conf$/);
  });

  it("keeps the boolean form, so a caller that only needs the fact still works", () => {
    const dir = tempDir();
    assert.equal(removeLegacyFragment("9999", dir), false);
    writeFileSync(join(dir, "pjsip_ext_9999.conf"), `[9999]\n`);
    assert.equal(removeLegacyFragment("9999", dir), true);
    // The old signature answered `false` here too — but now a caller that reads
    // it can ask `legacyFragmentRemoval` which of the two it was.
    mkdirSync(join(dir, "pjsip_ext_9999.conf"));
    assert.equal(removeLegacyFragment("9999", dir), false);
    assert.equal(legacyFragmentRemoval("9999", dir).present, true);
  });
});
