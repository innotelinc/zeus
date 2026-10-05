/**
 * The PBX-health shaping, pinned without a PBX.
 *
 * Three things here are easy to get wrong and all three are silent:
 *
 *   1. **The trunk password must never be read.** `PJSIPShowRegistrationsOutbound`
 *      interleaves `AuthDetail` events with the registrations, and those carry the
 *      trunk's clear-text `Password`. Only `ObjectType: registration` is kept, so
 *      a credential cannot reach a route response.
 *   2. **Only `Registered` is healthy.** Everything else (`Rejected`, `Stopped`,
 *      an empty status) is a finding; treating "not Registered" as fine is how a
 *      dead trunk reads green.
 *   3. **"No contact" is per AoR, not per contact.** An extension with two
 *      devices is registered if *any* contact names it.
 */
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import { load, transpile } from "./ts-probe.mjs";

let health;

before(async () => {
  health = await load(transpile(["src/lib/pbx-health.ts"]), "pbx-health");
});

describe("summarizeTrunks", () => {
  it("keeps registrations and drops the AuthDetail that carries a password", () => {
    const events = [
      {
        Event: "OutboundRegistrationDetail",
        ObjectType: "registration",
        ObjectName: "voipms-reg",
        Status: "Rejected",
        ServerUri: "sip:newyork1.voip.ms",
      },
      {
        Event: "AuthDetail",
        ObjectType: "auth",
        ObjectName: "voipms-auth",
        Username: "235662_capstone",
        Password: "SECRET-MUST-NOT-LEAK",
      },
      {
        Event: "OutboundRegistrationDetail",
        ObjectType: "registration",
        ObjectName: "voipms_pjsip",
        Status: "Registered",
        ServerUri: "sip:newyork1.voip.ms:5080",
      },
    ];

    const trunks = health.summarizeTrunks(events);
    assert.deepEqual(
      trunks.map((t) => t.name),
      ["voipms-reg", "voipms_pjsip"],
    );
    // The credential is nowhere in the shaped output.
    assert.ok(!JSON.stringify(trunks).includes("SECRET-MUST-NOT-LEAK"));
  });

  it("flags everything that is not Registered, and only that", () => {
    const trunks = health.summarizeTrunks([
      { Event: "OutboundRegistrationDetail", ObjectType: "registration", ObjectName: "a", Status: "Registered" },
      { Event: "OutboundRegistrationDetail", ObjectType: "registration", ObjectName: "b", Status: "Rejected" },
      { Event: "OutboundRegistrationDetail", ObjectType: "registration", ObjectName: "c", Status: "Stopped" },
      { Event: "OutboundRegistrationDetail", ObjectType: "registration", ObjectName: "d", Status: "" },
    ]);
    assert.deepEqual(trunks.map((t) => t.failing), [false, true, true, false]);
    assert.deepEqual(health.failingTrunks(trunks).map((t) => t.name), ["b", "c"]);
  });
});

describe("summarizeContacts", () => {
  it("keys a contact by the endpoint it serves", () => {
    const contacts = health.summarizeContacts([
      { Event: "ContactList", ObjectName: "15000;@abc", Endpoint: "15000", Uri: "sip:15000@192.168.1.12:26164", Status: "Reachable" },
      { Event: "ContactListComplete" },
    ]);
    assert.equal(contacts.length, 1);
    assert.deepEqual(contacts[0], {
      extension: "15000",
      uri: "sip:15000@192.168.1.12:26164",
      status: "Reachable",
    });
  });
});

describe("summarizeEndpoints", () => {
  it("keeps the endpoint names and nothing else", () => {
    const names = health.summarizeEndpoints([
      { Event: "EndpointList", ObjectType: "endpoint", ObjectName: "12000" },
      { Event: "EndpointList", ObjectType: "endpoint", ObjectName: " 15000 " },
      { Event: "EndpointListComplete" },
      { Event: "SomethingElse", ObjectName: "not-an-endpoint" },
      { Event: "EndpointList", ObjectType: "endpoint", ObjectName: "  " },
    ]);
    assert.deepEqual(names, ["12000", "15000"]);
  });
});

describe("phoneExtensions", () => {
  it("keeps only the mirror rows the PBX defines as endpoints", () => {
    // 3291–3294 are the fax service lines: IAX2 modems the PBX has no endpoint
    // for, so no contact can ever exist. They are not phones that failed to
    // register, and must not be judged as such.
    assert.deepEqual(
      health.phoneExtensions(["15000", "3291", "3292", "12000"], ["15000", "12000"]),
      ["15000", "12000"],
    );
  });

  it("judges nothing when the box defines no endpoints", () => {
    assert.deepEqual(health.phoneExtensions(["15000", "12000"], []), []);
  });
});

describe("withoutContacts", () => {
  it("reports an extension only when no contact names it", () => {
    const contacts = [
      { extension: "15000", uri: "", status: "Reachable" },
      { extension: "4132951200", uri: "", status: "Reachable" },
    ];
    assert.deepEqual(
      health.withoutContacts(["15000", "4132951200", "4132643964"], contacts),
      ["4132643964"],
    );
  });

  it("counts an extension with any of several contacts as registered", () => {
    const contacts = [
      { extension: "1001", uri: "a", status: "Reachable" },
      { extension: "1001", uri: "b", status: "Reachable" },
    ];
    assert.deepEqual(health.withoutContacts(["1001"], contacts), []);
  });
});
