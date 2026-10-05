/**
 * The outbound-trunk alert, pinned where it is easy to lose.
 *
 * Every extension can be green and outbound calling still be dead: the phones'
 * contacts and the provider registrations are separate facts
 * (`PJSIPShowContacts` vs `PJSIPShowRegistrationsOutbound`), and a `Rejected`
 * registration appears on no extension row — only as calls that will not leave.
 * So the health probe and the Today overview both read it live.
 *
 * The distinction this file exists to protect is `trunks: null` (the portal
 * could not ask the PBX) against `trunks: []` (a box with no outbound
 * registrations). They look the same downstream and mean opposite things, and
 * reporting the first as healthy is the false green the whole surface is meant
 * to remove. A source-level pass then checks that both surfaces are actually
 * wired — the shaping being right is worth nothing if no screen calls it.
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { before, describe, it } from "node:test";

import { REPO, load, transpile } from "./ts-probe.mjs";

let server;

const AMI_STUB = `
export function getAmiClient() {
  return globalThis.__trunkAlertTest.ami;
}
`;

function registration(name, status, serverUri = "sip:newyork1.voip.ms") {
  return {
    Event: "OutboundRegistrationDetail",
    ObjectType: "registration",
    ObjectName: name,
    Status: status,
    ServerUri: serverUri,
  };
}

function fakeAmi({ connected = true, events = [], throwOnRead = false } = {}) {
  return {
    isConnected: connected,
    async listOutboundRegistrations() {
      if (throwOnRead) throw new Error("AMI action PJSIPShowRegistrationsOutbound timed out");
      return events;
    },
  };
}

before(async () => {
  // `pbx-health.ts` is transpiled alongside so the server reader runs against
  // the real shaping; only the AMI client is stubbed.
  const dir = transpile(["src/lib/pbx-health.ts", "src/lib/pbx-health-server.ts"]);
  writeFileSync(join(dir, "ami.mjs"), AMI_STUB);
  server = await load(dir, "pbx-health-server");
});

describe("readTrunkHealth", () => {
  it("names the registrations the PBX rejected", async () => {
    globalThis.__trunkAlertTest = {
      ami: fakeAmi({
        events: [registration("voipms-reg", "Rejected"), registration("voipms_pjsip", "Registered")],
      }),
    };

    const health = await server.readTrunkHealth();
    assert.equal(health.trunks.length, 2);
    assert.deepEqual(health.failing.map((t) => t.name), ["voipms-reg"]);
    assert.equal(health.error, undefined);
  });

  it("is healthy — an empty list, not null — when every trunk is registered", async () => {
    globalThis.__trunkAlertTest = {
      ami: fakeAmi({ events: [registration("voipms_pjsip", "Registered")] }),
    };

    const health = await server.readTrunkHealth();
    assert.equal(health.trunks.length, 1);
    assert.equal(health.trunks[0].failing, false);
    assert.equal(health.failing.length, 0);
    assert.equal(health.error, undefined);
  });

  it("keeps 'could not ask' apart from 'no trunks'", async () => {
    globalThis.__trunkAlertTest = { ami: fakeAmi({ connected: false }) };
    const offline = await server.readTrunkHealth();
    assert.equal(offline.trunks, null);
    assert.match(offline.error, /AMI not connected/);

    globalThis.__trunkAlertTest = { ami: fakeAmi({ throwOnRead: true }) };
    const failed = await server.readTrunkHealth();
    assert.equal(failed.trunks, null);
    assert.match(failed.error, /timed out/);
    assert.deepEqual(failed.failing, []);
  });
});

describe("trunkHealthError", () => {
  it("names the fault and says what it costs", async () => {
    globalThis.__trunkAlertTest = {
      ami: fakeAmi({ events: [registration("voipms-reg", "Rejected")] }),
    };
    const health = await server.readTrunkHealth();
    const line = server.trunkHealthError(health);
    assert.match(line, /voipms-reg \(Rejected\)/);
    assert.match(line, /outbound calls .* will fail/);
  });

  it("reports an unreadable PBX as unverifiable, not as fine", async () => {
    globalThis.__trunkAlertTest = { ami: fakeAmi({ connected: false }) };
    const line = server.trunkHealthError(await server.readTrunkHealth());
    assert.match(line, /cannot tell whether outbound trunks are registered/);
  });
});

/**
 * The two surfaces the alert is meant to reach. Source-level because the
 * behaviour is wiring: the probe and the overview row both delegate to the same
 * reader, and the Health screen maps `SERVICE_KEYS` — so a key that is missing
 * from that list leaves the page silently short one row.
 */
describe("the trunk alert's surfaces", () => {
  const healthRoute = readFileSync(join(REPO, "src/app/api/health/route.ts"), "utf8");
  const healthServices = readFileSync(join(REPO, "src/lib/health-services.ts"), "utf8");
  const today = readFileSync(join(REPO, "src/app/dashboard/page.tsx"), "utf8");

  it("is a service on /api/health", () => {
    assert.match(healthRoute, /probeTrunkRegistrations/);
    assert.match(healthRoute, /outbound_trunks: trunkResult/);
  });

  it("is declared in the health vocabulary, so the Health page renders it", () => {
    assert.match(healthServices, /"outbound_trunks",/);
    assert.match(healthServices, /outbound_trunks: \{/);
  });

  it("is a row on the Today overview", () => {
    assert.match(today, /readTrunkHealth/);
    assert.match(today, /Outbound trunks/);
  });
});
