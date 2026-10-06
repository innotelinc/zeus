/**
 * The channel join behind "hang up": one extension's legs and their peers.
 *
 * `POST /api/ami/hangup` has to disconnect the party the caller is actually
 * talking to, and that party is never the extension's own channel — it is the
 * channel that channel is *bridged* to (the trunk leg, or the engine's own).
 * The join is the bridge id on a `CoreShowChannel` event.
 *
 * The bug this pins is a naming one: the code looked for `BridgedChannel` /
 * `BridgePeer` / `BridgeId` on an AMI `Status` row, whose field is spelled
 * `BridgeID` and only for a bridged channel — so `peerOf` found nothing on every
 * live call, and a hang-up (and a hold) acted on the portal's own leg alone.
 * `CoreShowChannels` is what the estate's Asterisk (22) actually answers with,
 * and the fixtures below are its shape.
 */
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import { load, transpile } from "./ts-probe.mjs";

let legs;

before(async () => {
  const gen = transpile(["src/lib/ami-channels.ts"]);
  legs = await load(gen, "ami-channels");
});

/** One `CoreShowChannel` event: the fields this join reads, and no more. */
function row(channel, bridgeId = "") {
  return { Event: "CoreShowChannel", Channel: channel, BridgeId: bridgeId };
}

describe("callLegs", () => {
  it("names the extension's own legs and the peer they are bridged to", () => {
    // The estate's own outbound CDR: the softphone leg bridged to the trunk.
    const rows = [
      row("PJSIP/4132643964-00000006", "bridge-1"),
      row("PJSIP/voipms_pjsip-00000007", "bridge-1"),
    ];
    assert.deepEqual(legs.callLegs(rows, "4132643964"), {
      local: ["PJSIP/4132643964-00000006"],
      remote: ["PJSIP/voipms_pjsip-00000007"],
    });
  });

  it("carries both legs of an inbound call", () => {
    const rows = [
      row("PJSIP/voipms-endpoint-00000008", "bridge-2"),
      row("PJSIP/4132643964-00000009", "bridge-2"),
    ];
    assert.deepEqual(legs.callLegs(rows, "4132643964"), {
      local: ["PJSIP/4132643964-00000009"],
      remote: ["PJSIP/voipms-endpoint-00000008"],
    });
  });

  it("contributes no peer for a channel that is not in a bridge", () => {
    // A ringing/held leg has an empty BridgeId; there is nobody to hang up.
    const rows = [row("PJSIP/4132643964-00000006")];
    assert.deepEqual(legs.callLegs(rows, "4132643964"), {
      local: ["PJSIP/4132643964-00000006"],
      remote: [],
    });
  });

  it("leaves another account's bridged call alone", () => {
    // Two unrelated bridges: only the one the extension is in is its call.
    const rows = [
      row("PJSIP/4132643964-00000006", "bridge-1"),
      row("PJSIP/voipms_pjsip-00000007", "bridge-1"),
      row("PJSIP/12000-00000010", "bridge-9"),
      row("PJSIP/voipms_pjsip-00000011", "bridge-9"),
    ];
    assert.deepEqual(legs.callLegs(rows, "4132643964"), {
      local: ["PJSIP/4132643964-00000006"],
      remote: ["PJSIP/voipms_pjsip-00000007"],
    });
  });

  it("does not match an extension that merely shares a prefix", () => {
    // The channel separator is the `-`, not the number: 41326439640 is a
    // different endpoint, so it is a peer here and never the extension's leg.
    const rows = [
      row("PJSIP/4132643964-00000006", "bridge-1"),
      row("PJSIP/41326439640-00000009", "bridge-1"),
    ];
    assert.deepEqual(legs.callLegs(rows, "4132643964"), {
      local: ["PJSIP/4132643964-00000006"],
      remote: ["PJSIP/41326439640-00000009"],
    });
  });

  it("is empty for an extension with no channel at all", () => {
    assert.deepEqual(legs.callLegs([row("PJSIP/voipms_pjsip-00000007", "b")], "4132643964"), {
      local: [],
      remote: [],
    });
  });
});
