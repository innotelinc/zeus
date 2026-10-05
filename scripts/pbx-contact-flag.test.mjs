/**
 * The extension row's live "no contact" flag, pinned where it can go wrong.
 *
 * `freepbx_extensions.device_state` is a cache the portal writes from AMI
 * events, so an extension that has *never* registered and one that is merely
 * idle both read "Offline" — the ambiguity an operator hits first. The live
 * answer is `pjsip show contacts`, and `/api/ami/status?contacts=1` is how the
 * row gets it.
 *
 * Two things here are silent if they break, and both are the point:
 *
 *   1. **Unknown must not render as absent.** A contact read that failed (AMI
 *      down, action timeout) and a PBX with no contact for a row are different
 *      facts, and only one means "no phone is registered". Everything unreadable
 *      must come back `contacts_known: false` with an empty list, so the chip is
 *      absent rather than wrong.
 *   2. **The read is opt-in.** The shell polls this endpoint every 15s for the
 *      AMI light alone; a list action on every poll would spend the PBX's time
 *      on a fact only the extensions screen shows.
 *
 * The route imports `@/lib/*` and `next/server`, so `transpile` rewrites those
 * and this file drops stubs beside the transpiled copy. `@/lib/pbx-health` is
 * aliased to its *real* transpiled self — the shaping is what the route's answer
 * is built out of, and stubbing it would test the stub.
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { before, describe, it } from "node:test";

import { REPO, load, transpile } from "./ts-probe.mjs";

let route;

const NEXT_SERVER_STUB = `
export const NextResponse = {
  json(body, init) {
    return {
      status: init && init.status ? init.status : 200,
      body,
      async json() { return body; },
    };
  },
};
`;

const API_HELPERS_STUB = `
export async function requireUser() {
  return globalThis.__contactFlagTest.session;
}
`;

const AMI_STUB = `
export function getAmiClient() {
  return globalThis.__contactFlagTest.ami;
}
`;

const DB_STUB = `
const db = {
  prepare(sql) {
    return {
      all() {
        if (sql.includes("freepbx_extensions")) {
          return globalThis.__contactFlagTest.extensions ?? [];
        }
        return [];
      },
      get() { return { c: 0 }; },
    };
  },
};
export default db;
`;

/** An AMI client that records whether the contact list was read at all. */
function fakeAmi({ connected = true, contacts = [], throwOnContacts = false } = {}) {
  return {
    isConnected: connected,
    contactReads: 0,
    async listContacts() {
      this.contactReads += 1;
      if (throwOnContacts) throw new Error("AMI action PJSIPShowContacts timed out");
      return contacts;
    },
  };
}

function contactEvent(endpoint) {
  return {
    Event: "ContactList",
    ObjectName: `${endpoint};@abc`,
    Endpoint: endpoint,
    Uri: `sip:${endpoint}@192.168.1.71:53678`,
    Status: "Reachable",
  };
}

function configure({ session, ami, extensions }) {
  globalThis.__contactFlagTest = { session, ami, extensions };
}

/** A Request stand-in: the route only reads `.url`. */
function request(query = "") {
  return { url: `http://portal.test/api/ami/status${query}` };
}

before(async () => {
  const dir = transpile(
    ["src/lib/pbx-health.ts", "src/app/api/ami/status/route.ts"],
    undefined,
    {
      "@/lib/api-helpers": "./api-helpers.mjs",
      "@/lib/ami": "./ami.mjs",
      "@/lib/db": "./db.mjs",
      "@/lib/pbx-health": "./pbx-health.mjs",
      "next/server": "./next-server.mjs",
    },
  );
  writeFileSync(join(dir, "next-server.mjs"), NEXT_SERVER_STUB);
  writeFileSync(join(dir, "api-helpers.mjs"), API_HELPERS_STUB);
  writeFileSync(join(dir, "ami.mjs"), AMI_STUB);
  writeFileSync(join(dir, "db.mjs"), DB_STUB);
  route = await load(dir, "route");
});

describe("GET /api/ami/status — the live contact flag", () => {
  it("is 401 without a session", async () => {
    configure({
      session: { user: null, error: { status: 401, body: { error: "Unauthorized" } } },
      ami: fakeAmi(),
    });
    const res = await route.GET(request("?contacts=1"));
    assert.equal(res.status, 401);
  });

  it("names the extensions the PBX holds no contact for", async () => {
    const ami = fakeAmi({
      contacts: [contactEvent("15000"), contactEvent("4132951200")],
    });
    configure({
      session: { user: { id: "u1" }, error: null },
      ami,
      extensions: [
        { extension_id: "15000", device_state: "idle" },
        { extension_id: "4132951200", device_state: "idle" },
        { extension_id: "12000", device_state: "offline" },
      ],
    });

    const body = await (await route.GET(request("?contacts=1"))).json();
    assert.equal(body.contacts_known, true);
    assert.deepEqual(body.unregistered, ["12000"]);
    assert.equal(ami.contactReads, 1);
  });

  it("does not read the PBX unless asked — the shell polls this for the AMI light", async () => {
    const ami = fakeAmi({ contacts: [contactEvent("15000")] });
    configure({
      session: { user: { id: "u1" }, error: null },
      ami,
      extensions: [{ extension_id: "12000", device_state: "offline" }],
    });

    const body = await (await route.GET(request())).json();
    assert.equal(ami.contactReads, 0);
    // Nothing read means nothing known — not "every row is unregistered".
    assert.equal(body.contacts_known, false);
    assert.deepEqual(body.unregistered, []);
  });

  it("reports a failed read as unknown, never as no-contact", async () => {
    configure({
      session: { user: { id: "u1" }, error: null },
      ami: fakeAmi({ throwOnContacts: true }),
      extensions: [{ extension_id: "12000", device_state: "offline" }],
    });

    const body = await (await route.GET(request("?contacts=1"))).json();
    assert.equal(body.contacts_known, false);
    assert.deepEqual(body.unregistered, []);
  });

  it("reports a disconnected AMI as unknown too, and sends no action", async () => {
    const ami = fakeAmi({ connected: false });
    configure({
      session: { user: { id: "u1" }, error: null },
      ami,
      extensions: [{ extension_id: "12000", device_state: "offline" }],
    });

    const body = await (await route.GET(request("?contacts=1"))).json();
    assert.equal(body.ami_connected, false);
    assert.equal(body.contacts_known, false);
    assert.deepEqual(body.unregistered, []);
    assert.equal(ami.contactReads, 0);
  });
});

/**
 * What the row does with the answer. There is no React test runner here, so the
 * wiring is pinned at the source: the component must ask for the live read, and
 * it must gate the chip on the read having succeeded.
 */
describe("the extension row's no-contact chip", () => {
  const component = readFileSync(
    join(REPO, "src/components/dashboard/PhoneSection.tsx"),
    "utf8",
  );

  it("asks the status endpoint for the live contact read", () => {
    assert.match(component, /\/api\/ami\/status\?contacts=1/);
  });

  it("shows the chip only when the PBX answered", () => {
    assert.match(component, /contactsKnown\s*&&\s*noContact\.includes\(ext\.extension_id\)/);
  });

  it("clears the flag when the PBX could not be asked, so nothing stale is drawn", () => {
    // `unregistered` is emptied in the same branch that decides `contactsKnown`,
    // so a dropped AMI link cannot leave last poll's chips on screen.
    const block = component.slice(component.indexOf("contacts_known === true"));
    assert.match(block.slice(0, 400), /setContactsKnown\(known\)/);
    assert.match(block.slice(0, 400), /known \? \[\.\.\.\(data\.unregistered \?\? \[\]\)\]\.sort\(\) : \[\]/);
  });

  it("says what the chip means, in words the operator can act on", () => {
    assert.match(component, /No contact/);
    assert.match(component, /no phone or softphone is registered/i);
  });
});
