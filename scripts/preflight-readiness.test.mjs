/**
 * Readiness of the provisioning preflight's sources.
 *
 * `POST /api/phone/extensions` refuses a create with a 503 when any of the three
 * authorities it reads — FreePBX's API, Asterisk's AMI, the mounted
 * `/etc/asterisk` — cannot answer. That refusal is correct but late: an operator
 * meets it only when they click Add extension. `/api/health` now reports the same
 * three reads up front (`extension_preflight`), and this pins the two properties
 * that make the report worth trusting:
 *
 *   1. **Each source is probed independently.** A failure in the first must not
 *      hide the state of the other two, or a whole box reads as one error.
 *   2. **A missing source is named, with its repair.** The point of the preflight
 *      over the old blind create is a *named* refusal; a readiness line that only
 *      said "unavailable" would be the same unactionable dialog back again.
 *
 * The probes run against the real (unconfigured) environment here: FREEPBX_URL and
 * AMI are absent in a test process, which is exactly the "could not read" case
 * the check exists for. No network is touched — an unset FREEPBX_URL fails in the
 * API client before any fetch.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { load, transpile } from "./ts-probe.mjs";

let live;
let freepbx;
const dirs = [];

before(async () => {
  const gen = transpile([
    "src/lib/extension-preflight-live.ts",
    "src/lib/extension-preflight.ts",
    "src/lib/pjsip-owners.ts",
    "src/lib/ami.ts",
    "src/lib/freepbx.ts",
  ]);
  live = await load(gen, "extension-preflight-live");
  freepbx = await load(gen, "freepbx");
  // The portal's env has these set on a real host; a test must exercise the
  // unreadable case deterministically rather than inherit the runner's.
  delete process.env.FREEPBX_URL;
  delete process.env.FREEPBX_CLIENT_ID;
  delete process.env.FREEPBX_CLIENT_SECRET;
});

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const byName = (sources, name) => sources.find((s) => s.source === name);

describe("preflight source readiness", () => {
  it("probes all three authorities, not just the first to fail", async () => {
    const missing = join(tmpdir(), "zeus-no-such-asterisk-dir");
    const readiness = await live.preflightReadiness(missing);

    assert.deepEqual(
      readiness.sources.map((s) => s.source),
      ["freepbx_api", "asterisk_ami", "asterisk_config"],
    );
    assert.equal(readiness.ok, false);
    // AMI is not connected in a test process; the FreePBX client has no URL.
    assert.equal(byName(readiness.sources, "asterisk_ami").ok, false);
    assert.equal(byName(readiness.sources, "freepbx_api").ok, false);
  });

  it("reads a mounted config dir as available", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zeus-asterisk-"));
    dirs.push(dir);
    const readiness = await live.preflightReadiness(dir);
    assert.equal(byName(readiness.sources, "asterisk_config").ok, true);
  });

  it("names the missing mount and its repair, not just 'unavailable'", async () => {
    const missing = join(tmpdir(), "zeus-no-such-asterisk-dir");
    const readiness = await live.preflightReadiness(missing);
    const config = byName(readiness.sources, "asterisk_config");

    assert.match(config.detail, /not mounted/);
    assert.match(config.detail, /endpoint ownership/);
    assert.match(config.detail, /provision_extension\.py/);
  });

  it("names why each unreadable source failed, and the shared repair once", async () => {
    const readiness = await live.preflightReadiness(join(tmpdir(), "zeus-no-such-dir"));
    const line = live.preflightReadinessError(readiness);

    assert.match(line, /adding an extension would be refused/);
    assert.match(line, /FREEPBX_/); // the FreePBX client's own cause
    assert.match(line, /AMI is not connected/);
    assert.match(line, /not mounted/);
    // The repair is stated once, not repeated per source.
    assert.equal(line.match(/provision_extension\.py/g).length, 1);
  });
});

describe("the extension list read", () => {
  /** Answer the token call and the GQL call from one stub. */
  function stub(payload) {
    const saved = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const target = String(url);
      if (target.includes("/api/token")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: "test-token", expires_in: 3600 }),
        };
      }
      if (target.includes("command=gql")) {
        return { ok: true, status: 200, json: async () => payload };
      }
      throw new Error(`unexpected fetch: ${target}`);
    };
    return () => {
      globalThis.fetch = saved;
    };
  }

  before(() => {
    process.env.FREEPBX_URL = "http://pbx.test";
    process.env.FREEPBX_CLIENT_ID = "pbxportal-api";
    process.env.FREEPBX_CLIENT_SECRET = "a-test-secret";
  });

  after(() => {
    delete process.env.FREEPBX_URL;
    delete process.env.FREEPBX_CLIENT_ID;
    delete process.env.FREEPBX_CLIENT_SECRET;
  });

  it("reads the wrapper FreePBX 17 actually returns", async () => {
    // Measured on `.30`: `data.fetchAllExtensions` is `{"extension":[…]}`. An
    // `Array.isArray` on that object threw, so `/api/health` reported the create
    // gate degraded and every Add refused with a 503 while the PBX answered the
    // query perfectly well.
    const restore = stub({
      data: {
        fetchAllExtensions: {
          extension: [
            { extensionId: "12000", tech: "pjsip" },
            { extensionId: "1500", tech: "pjsip" },
          ],
        },
      },
    });
    try {
      const rows = await freepbx.fetchAllExtensions();
      assert.deepEqual(
        rows.map((r) => r.extensionId),
        ["12000", "1500"],
      );
      assert.equal(rows[0].tech, "pjsip");
    } finally {
      restore();
    }
  });

  it("still reads a bare list, and the row either way", async () => {
    const restore = stub({
      data: { fetchAllExtensions: [{ extension: { extensionId: "101", tech: "pjsip" } }] },
    });
    try {
      const rows = await freepbx.fetchAllExtensions();
      assert.deepEqual(
        rows.map((r) => r.extensionId),
        ["101"],
      );
    } finally {
      restore();
    }
  });

  it("refuses a shape it cannot trust instead of reading it as no extensions", async () => {
    const restore = stub({ data: { fetchAllExtensions: null } });
    try {
      await assert.rejects(() => freepbx.fetchAllExtensions(), /did not return a list/);
    } finally {
      restore();
    }
  });
});
