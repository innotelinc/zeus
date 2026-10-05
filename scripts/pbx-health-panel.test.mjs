/**
 * The health panel's live contact list, pinned where it can silently vanish.
 *
 * `/api/pbx/health` already answers with every live contact (`PJSIPShowContacts`
 * shaped by `summarizeContacts`) — the device and address each extension is
 * registered *from*. If the panel stops consuming that field, the panel still
 * renders: the trunks and the "no registration" chips come from other fields, so
 * an operator loses the one positive fact ("this phone is registered, here") and
 * nothing on screen says it is gone.
 *
 * There is no React test runner here, so the wiring is pinned at the source: the
 * response shape must keep `contacts`, the panel's interface must declare it, and
 * the panel must actually map it — naming the extension, its address, and
 * Asterisk's reachability word, which is the whole reason to show it.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { REPO } from "./ts-probe.mjs";

const route = readFileSync(join(REPO, "src/app/api/pbx/health/route.ts"), "utf8");
const panel = readFileSync(
  join(REPO, "src/components/dashboard/PbxHealthPanel.tsx"),
  "utf8",
);

describe("the PBX health response's contacts", () => {
  it("returns the live contacts, shaped so no password can ride along", () => {
    assert.match(route, /summarizeContacts/);
    assert.match(route, /contacts,/);
  });

  it("still returns them when AMI is down, so 'unreadable' stays distinguishable", () => {
    assert.match(route, /ami_connected: false[\s\S]*?contacts: \[\]/);
  });

  it("judges only the mirror rows the PBX defines as endpoints", () => {
    // Without the join, every mirror row is treated as a phone — and the fax
    // service lines, which have no endpoint and never will, are reported as
    // unregistered on every load.
    assert.match(route, /summarizeEndpoints/);
    assert.match(route, /phoneExtensions/);
  });

  it("carries endpoints_known, so 'no phone anywhere' stays distinguishable", () => {
    assert.match(route, /endpoints_known: endpointsKnown/);
    // A failed endpoint read must not read as an empty endpoint list.
    assert.match(route, /ami\.listEndpoints\(\)\.catch\(\(\) => null\)/);
  });
});

describe("the panel's contact list", () => {
  it("declares the contacts field it is handed", () => {
    assert.match(panel, /interface Contact \{[\s\S]*?extension: string;[\s\S]*?uri: string;[\s\S]*?status: string;/);
    assert.match(panel, /contacts: Contact\[\];/);
  });

  it("reads and renders them", () => {
    assert.match(panel, /const contacts = health\?\.contacts \?\? \[\];/);
    assert.match(panel, /Registered contacts/);
    assert.match(panel, /contacts\.map\(/);
  });

  it("shows where each contact is registered from, not just that it exists", () => {
    // The address is the point: it tells an operator which device/network the
    // phone registered over, which a bare reachability word cannot.
    assert.match(panel, /contact\.uri/);
    assert.match(panel, /contact\.extension/);
  });

  it("marks a contact unreachable distinctly from a reachable one", () => {
    assert.match(panel, /contact\.status\.trim\(\)\.toLowerCase\(\) === "reachable"/);
  });

  it("says so plainly when there are no contacts at all", () => {
    assert.match(panel, /No phone is registered against any endpoint/);
  });

  it("declares whether the PBX's endpoint list could be read", () => {
    assert.match(panel, /endpoints_known: boolean;/);
  });

  it("says it cannot tell — not that everything is fine — when it could not", () => {
    assert.match(panel, /!health\.endpoints_known \?/);
    assert.match(panel, /could not read the PBX&apos;s endpoint list/);
  });
});
