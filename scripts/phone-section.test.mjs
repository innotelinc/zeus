/**
 * The Phone screen shows the address a phone is handed, and says why it matters.
 *
 * The media-address failure is silent by construction: the extension is fine,
 * the dialplan is fine, and the phone still answers — it just sends its voice
 * and every DTMF digit into a subnet it cannot reach, so the caller hears the
 * prompts and nothing comes back. Nothing on a row that only says "Ready" can
 * tell that apart from a working phone, which is why the row carries the address
 * (`mediaAddress` on the readiness answer) and names its absence.
 *
 * There is no React test runner here (the deps have none, and `ts-probe.mjs`
 * transpiles modules, not JSX), so this pins the wiring at the source: the
 * component renders the one label, and the label's value comes from the row
 * rather than a second read. That is the regression an edit would introduce —
 * dropping the line, or reading the media file again in the component and
 * disagreeing with the server's answer.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { REPO } from "./ts-probe.mjs";

const COMPONENT = readFileSync(join(REPO, "src/components/dashboard/PhoneSection.tsx"), "utf8");
const READINESS = readFileSync(join(REPO, "src/lib/extension-readiness.ts"), "utf8");

describe("the Phone screen's media address line", () => {
  it("renders the label from the readiness row", () => {
    assert.match(COMPONENT, /import\s*\{[^}]*mediaAddressLabel[^}]*\}/);
    assert.match(COMPONENT, /mediaAddressLabel\(ext\.softphone\)/);
  });

  it("is silent when there is no address, because the summary names that case", () => {
    // A row with no media address is the one-way-audio state; the readiness
    // summary above the label is what explains it, so the label itself only
    // shows when there is an address to show.
    const block = COMPONENT.slice(COMPONENT.indexOf("mediaAddressLabel(ext.softphone)") - 400);
    assert.match(block, /mediaAddressLabel\(ext\.softphone\)\s*&&/);
  });

  it("says why it matters, in case the phone looks fine", () => {
    assert.match(COMPONENT, /voice and DTMF/i);
  });

  it("takes the value from the pure module, not a second read", () => {
    // The label lives in `extension-readiness.ts`, which is deliberately free of
    // `node:fs` (the extensions list is a client component). A component that
    // read `pjsip_media_custom.conf` itself would put `node:fs` in the bundle and
    // disagree with the server's answer.
    assert.match(READINESS, /export function mediaAddressLabel/);
    assert.match(READINESS, /mediaAddress: string/);
    assert.doesNotMatch(READINESS, /from\s+["']node:fs["']/);
  });
});
