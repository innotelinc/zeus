import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import { load, transpile } from "./ts-probe.mjs";

let callerId;

before(async () => {
  callerId = await load(
    transpile(["src/lib/outbound-caller-id.ts"]),
    "outbound-caller-id",
  );
});

describe("resolveOwnedCallerId", () => {
  const dids = ["7745057135", "4132643964"];

  it("leaves caller ID selection to the outbound route when omitted", () => {
    assert.equal(callerId.resolveOwnedCallerId(undefined, dids), undefined);
  });

  it("accepts an active account DID in national, +1, or 1-prefixed form", () => {
    assert.equal(callerId.resolveOwnedCallerId("7745057135", dids), "7745057135");
    assert.equal(callerId.resolveOwnedCallerId("+1 (774) 505-7135", dids), "7745057135");
    assert.equal(callerId.resolveOwnedCallerId("14132643964", dids), "4132643964");
  });

  it("rejects a number not owned by the account", () => {
    assert.equal(callerId.resolveOwnedCallerId("4134210134", dids), null);
  });

  it("rejects malformed, non-US, and too-short caller IDs", () => {
    assert.equal(callerId.resolveOwnedCallerId("sip:7745057135", dids), null);
    assert.equal(callerId.resolveOwnedCallerId("+44 20 1234 5678", dids), null);
    assert.equal(callerId.resolveOwnedCallerId("7135", dids), null);
  });
});
