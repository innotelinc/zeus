/**
 * The order that decides whether the far end is actually disconnected.
 *
 * The bug this pins is not in the PBX call, it is in the sequence around it: the
 * panel sent this leg's SIP BYE first and then asked the PBX as an
 * afterthought, without waiting and with the failure swallowed. Because the
 * extension's own channel is the only handle on the peer
 * (`src/lib/ami-channels.ts` joins the far end by the bridge that leg is in),
 * clearing it first is how the party the caller was talking to stays connected —
 * and a swallowed failure made that indistinguishable from a hang-up that
 * worked.
 *
 * Run:  node --test scripts/*.test.mjs
 */
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import { load, transpile } from "./ts-probe.mjs";

let teardown;

before(async () => {
  const dir = transpile(["src/lib/call-teardown.ts"]);
  teardown = await load(dir, "call-teardown");
});

/** Records the order the two halves were asked in. */
function harness(answer, { rejects = null, hangMs = 0 } = {}) {
  const calls = [];
  const errors = [];
  const plan = {
    requestPbxTeardown: async () => {
      calls.push("pbx");
      if (hangMs) await new Promise((r) => setTimeout(r, hangMs));
      if (rejects) throw rejects;
      return answer;
    },
    sendBye: () => calls.push("bye"),
    onError: (error) => errors.push(error),
  };
  return { plan, calls, errors };
}

describe("teardownCall", () => {
  it("asks the PBX before this leg's BYE goes out", async () => {
    const { plan, calls } = harness({ success: true, hung_up_local: 1, hung_up_remote: 1 }, {
      hangMs: 20,
    });
    const outcome = await teardown.teardownCall(plan);
    assert.equal(outcome, "pbx");
    // The PBX was asked, and it was asked *first*: the BYE never raced it.
    assert.deepEqual(calls, ["pbx"]);
  });

  it("sends the BYE when the PBX answered but cleared nothing", async () => {
    // What a hang-up that ran after the browser's own BYE looks like: there is no
    // channel left to name, so this leg still has to be cleared.
    const { plan, calls } = harness({ success: true, hung_up_local: 0, hung_up_remote: 0 });
    const outcome = await teardown.teardownCall(plan);
    assert.equal(outcome, "bye");
    assert.deepEqual(calls, ["pbx", "bye"]);
  });

  it("does not treat a far-end-only teardown as this leg's own", async () => {
    const { plan, calls } = harness({ success: true, hung_up_local: 0, hung_up_remote: 1 });
    assert.equal(await teardown.teardownCall(plan), "bye");
    assert.deepEqual(calls, ["pbx", "bye"]);
  });

  it("sends the BYE when the PBX cannot be reached, and reports why", async () => {
    const failure = new Error("Unauthorized");
    const { plan, calls, errors } = harness(null, { rejects: failure });
    const outcome = await teardown.teardownCall(plan);
    assert.equal(outcome, "bye");
    assert.deepEqual(calls, ["pbx", "bye"]);
    // Was `.catch(() => {})`: the reason has to survive somewhere.
    assert.deepEqual(errors, [failure]);
  });

  it("does not wait on a PBX that never answers", async () => {
    const { plan, calls } = harness({ success: true, hung_up_local: 1 }, { hangMs: 60 });
    const outcome = await teardown.teardownCall({ ...plan, timeoutMs: 10 });
    assert.equal(outcome, "bye");
    assert.deepEqual(calls, ["pbx", "bye"]);
  });

  it("accepts an answer with no fields at all", async () => {
    // An older image's route answers `{ success: true, hung_up: n }`; the BYE is
    // the safe reading of a response that cannot say this leg was cleared.
    const { plan, calls } = harness({ success: true });
    assert.equal(await teardown.teardownCall(plan), "bye");
    assert.deepEqual(calls, ["pbx", "bye"]);
  });
});
