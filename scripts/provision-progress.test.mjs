/**
 * The create form says what it is waiting for, and says when the credential is
 * missing.
 *
 * `POST /api/phone/extensions` is not a fast write any more: it queues FreePBX's
 * Apply Config between writing the rows and reading back the secret the softphone
 * registers with, because until a reload runs there is no `[<ext>-auth]` to read
 * (`src/lib/freepbx-apply.ts`, measured 11-30s). Two things follow, and both are
 * invisible in a passing build:
 *
 *   1. The form has to change while it waits. A button holding "Provisioning..."
 *      for half a minute is indistinguishable from a hung request, and the
 *      operator's instinct is to click again.
 *   2. A create whose reload did NOT run is a success with a hole in it: the rows
 *      are live, the credential is not, and the softphone will sit Offline. The
 *      answer carries that as `apply_config`, and it has to reach the operator —
 *      holding it in the response body is how the old code's silent gap comes
 *      back.
 *
 * The thresholds below are the measured ones, pinned here so an edit that
 * shortens the "still working" window has to argue with a test rather than with a
 * stopwatch someone happens to be holding.
 *
 * There is no React test runner here (see `scripts/phone-section.test.mjs`), so
 * the component's wiring is pinned at the source: the panel renders the pure
 * module's output, and the notice is fed from the response rather than guessed.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { load, transpile, REPO } from "./ts-probe.mjs";

// `load` is a dynamic import, so it is awaited: importing lazily and reading the
// namespace before it resolves is how every assertion below would silently see
// `undefined` instead of the module.
const {
  provisionProgress,
  describeApplyConfig,
  APPLY_STARTS_MS,
  APPLY_TYPICAL_MAX_MS,
  APPLY_TIMEOUT_MS,
} = await load(transpile(["src/lib/provision-progress.ts"]), "provision-progress");

const COMPONENT = readFileSync(join(REPO, "src/components/dashboard/PhoneSection.tsx"), "utf8");

describe("the create form's progress line", () => {
  it("does not name the reload before the reload can have started", () => {
    const early = provisionProgress(0);
    assert.equal(early.stage, "writing");
    assert.doesNotMatch(early.title, /Apply/i);
    // FreePBX's own write is fast; the reload is the long part, and saying
    // "applying" during the write would be the wrong thing to blame.
    assert.match(early.detail, /FreePBX/);
  });

  it("names the reload and its measured range while it runs", () => {
    const applying = provisionProgress(APPLY_STARTS_MS);
    assert.equal(applying.stage, "applying");
    assert.match(applying.title, /Apply/i);
    // The number is the whole reassurance: 11-30s is what the operator is
    // waiting for, and without it the wait has no end in sight.
    assert.match(applying.detail, /11/);
    assert.match(applying.detail, /30/);
    assert.equal(applying.slow, false);
  });

  it("keeps saying so past the measured range, without calling it a failure", () => {
    const slow = provisionProgress(APPLY_TYPICAL_MAX_MS);
    assert.equal(slow.slow, true);
    assert.match(slow.title, /slower|past/i);
    // Only the server knows what the PBX actually said; a stopwatch that decided
    // "failed" here would contradict the answer that is about to arrive.
    assert.doesNotMatch(slow.title, /fail/i);
    assert.doesNotMatch(slow.detail, /fail/i);
  });

  it("counts whole seconds, so the panel's clock is monotonic", () => {
    assert.equal(provisionProgress(0).seconds, 0);
    assert.equal(provisionProgress(1_999).seconds, 1);
    assert.equal(provisionProgress(2_000).seconds, 2);
    // A negative or absent elapsed time is a tick before the start, not a stage.
    assert.equal(provisionProgress(-1).seconds, 0);
    assert.equal(provisionProgress(Number.NaN).stage, "writing");
  });

  it("orders the thresholds the server's budget actually uses", () => {
    assert.ok(APPLY_STARTS_MS < APPLY_TYPICAL_MAX_MS);
    assert.ok(APPLY_TYPICAL_MAX_MS < APPLY_TIMEOUT_MS);
    // The panel must stop promising a wait the server has already given up on.
    assert.equal(provisionProgress(APPLY_TIMEOUT_MS).stage, "slow");
  });
});

describe("the create form's reload notice", () => {
  it("says nothing when the reload ran", () => {
    assert.equal(describeApplyConfig({ applied: true, state: "applied" }), "");
    assert.equal(describeApplyConfig(undefined), "");
    assert.equal(describeApplyConfig(null), "");
  });

  it("names the state, the consequence and the remedy", () => {
    const notice = describeApplyConfig({ applied: false, state: "timeout", detail: "Processing" });
    // Why it did not apply…
    assert.match(notice, /45-second budget/);
    // …what that costs, in the words the row will show…
    assert.match(notice, /cannot register/);
    // …and the action that fixes it, which is the row's own Repair.
    assert.match(notice, /Repair/);
  });

  it("distinguishes an unreachable API from a reload that failed", () => {
    const unreachable = describeApplyConfig({ applied: false, state: "unreachable" });
    const failed = describeApplyConfig({ applied: false, state: "failed" });
    assert.match(unreachable, /could not be reached/);
    assert.match(failed, /ran the reload and it failed/);
    assert.notEqual(unreachable, failed);
  });

  it("carries the PBX's own detail when there is one", () => {
    const notice = describeApplyConfig({ applied: false, state: "failed", detail: "pjsip.conf: bad" });
    assert.match(notice, /pjsip\.conf: bad/);
  });
});

describe("the Phone screen's wiring", () => {
  it("renders the progress line from the pure module, not from state of its own", () => {
    assert.match(COMPONENT, /import\s*\{[^}]*provisionProgress[^}]*\}/);
    assert.match(COMPONENT, /provisionProgress\(provisionElapsed\)/);
    // A live region, because the whole point is that the text changes without a click.
    assert.match(COMPONENT, /aria-live="polite"/);
  });

  it("ticks the clock only while a create is in flight, and stops it after", () => {
    assert.match(COMPONENT, /if \(!provisioning\) return;/);
    assert.match(COMPONENT, /clearInterval\(provisionTickRef\.current\)/);
    // Torn down with the request, so a second create cannot inherit the first
    // one's elapsed time and claim the reload has been running for a minute.
    assert.match(COMPONENT, /\}, \[provisioning\]\);/);
  });

  it("reports the reload the server answered with, rather than assuming success", () => {
    assert.match(COMPONENT, /import\s*\{[^}]*describeApplyConfig[^}]*\}/);
    assert.match(COMPONENT, /describeApplyConfig\(res\.apply_config\)/);
    assert.match(COMPONENT, /apply_config\?:/);
  });

  it("does not let the form be dismissed out from under an in-flight create", () => {
    // Cancel while the request is running leaves a create the operator cannot
    // see the result of — and it takes 11-30s, so the temptation is real.
    const cancel = COMPONENT.match(/onClick=\{\(\) => setProvisionMode\(false\)\}[^>]*disabled=\{provisioning\}/);
    assert.ok(cancel, "the Cancel button must be disabled while provisioning");
  });
});
