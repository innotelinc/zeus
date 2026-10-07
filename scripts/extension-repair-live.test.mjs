/**
 * Repairing an extension a legacy merge adopted.
 *
 * `scripts/legacy_portal_merge.py` adopts rows out of the old portal. It moves
 * the account, the mailbox and the endpoint — and deliberately invents no
 * credential, because the only secret that authenticates the endpoint FreePBX
 * routes to is the one FreePBX renders. So an adopted row can be a live
 * extension whose softphone half is an empty string: `extension_secret = ''`,
 * no `[<ext>](+)` in the post file, and possibly a pre-decision
 * `pjsip_ext_<ext>.conf` left beside FreePBX's own `[<ext>]`. That file is a
 * *second* object with the extension's id, which is the duplicate the endpoint
 * decision exists to avoid, so its removal is a hazard fix and not a tidy-up.
 *
 * `POST /api/phone/extensions/repair` is the operator's one action for all of
 * it, and this pins the three writes it promises in that order, because the
 * order is the whole repair:
 *
 *   1. **Adopt the rendered secret** — the row's stored secret becomes the one
 *      `pbxSecretFor` read out of the config. A repair that rewrote the WebRTC
 *      section but left the row's portal-issued secret would produce a phone
 *      that still cannot register, with a green toast over it.
 *   2. **Remove the leftover endpoint file** — before the append is written, or
 *      the append lands beside a second `[<ext>]`.
 *   3. **Write `[<ext>](+)` and reload from the state just written** — logging
 *      the reload as based on the *pre-repair* read is the old bug: a repair that
 *      added a missing section reported success and reloaded nothing.
 *
 * Two refusals are pinned as well, because they are the cases an operator meets
 * on a real adopted row: nothing to adopt anywhere (409, and the leftover file
 * still goes), and a post file the portal cannot write (409, and the secret is
 * NOT adopted — a partial repair must not read as a whole one).
 *
 * The route's collaborators are stubs, so this tests the route's decisions. That
 * the append really lands in `pjsip.endpoint_custom_post.conf` is
 * `pjsip-endpoint.ts`'s own test, and that the rendered secret really comes out
 * of `pjsip.auth.conf` is `pjsip-secret.ts`'s.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { before, describe, it } from "node:test";

import { load, transpile } from "./ts-probe.mjs";

// ── The route: stub every collaborator, and record the order they are used ──

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
  return globalThis.__repairTest.session;
}
export function badRequest(message) {
  return {
    status: 400,
    body: { error: message },
    async json() { return { error: message }; },
  };
}
`;

const DB_STUB = `
const db = {
  prepare() {
    return {
      get() { return globalThis.__repairTest.row; },
      run(...args) {
        globalThis.__repairTest.calls.push(["db.run", ...args]);
        return { changes: 1 };
      },
    };
  },
};
export default db;
`;

const PJSIP_ENDPOINT_STUB = `
export const POST_FILE = "pjsip.endpoint_custom_post.conf";
export const MEDIA_FILE = "pjsip_media_custom.conf";
export function sectionHeader(ext) { return "[" + ext + "](+)"; }
export function provisionWebrtc(ext) {
  globalThis.__repairTest.calls.push(["provisionWebrtc", ext]);
  if (globalThis.__repairTest.writeThrows) {
    throw new Error("EACCES: permission denied, open '/etc/asterisk/" + POST_FILE + "'");
  }
  return { provisioned: true, file: POST_FILE, section: sectionHeader(ext), requiredSection: sectionHeader(ext) };
}
export function provisionMediaAddress(ext) {
  globalThis.__repairTest.calls.push(["provisionMediaAddress", ext]);
  if (globalThis.__repairTest.mediaThrows) {
    throw new Error("EACCES: pjsip_media_custom.conf");
  }
  return { written: true, file: MEDIA_FILE, address: "192.168.1.30", reason: "" };
}
export function readWebrtcState(ext) {
  return { provisioned: false, file: POST_FILE, section: "", requiredSection: sectionHeader(ext), reason: "no section yet" };
}
export function legacyFragmentRemoval(ext) {
  globalThis.__repairTest.calls.push(["removeLegacyFragment", ext]);
  return globalThis.__repairTest.legacy;
}
`;

const PJSIP_SECRET_STUB = `
export function pbxSecretFor(extensionId) {
  globalThis.__repairTest.calls.push(["pbxSecretFor", extensionId]);
  return globalThis.__repairTest.pbxSecret;
}
`;

const PJSIP_RELOAD_STUB = `
export async function reloadPjsipIfLive(state) {
  globalThis.__repairTest.reloads.push(state);
  return true;
}
`;

const EXTENSION_READINESS_STUB = `
export function assessSoftphone(extensionId, portalSecret, pbxSecret, state, mediaAddress) {
  return {
    state: "ready",
    extensionId,
    portalSecretPresent: Boolean(portalSecret),
    pbxSecretPresent: Boolean(pbxSecret),
    mediaAddress: mediaAddress || "",
  };
}
`;

let route;

/** What every collaborator does this test, and the order they were touched. */
function configure(over = {}) {
  globalThis.__repairTest = {
    session: { user: { id: "u1" }, error: null },
    // An extension the legacy merge adopted: a row, a live PBX endpoint, and no
    // credential of the row's own.
    row: {
      id: "row-legacy",
      user_id: "u1",
      extension_id: "9999",
      extension_secret: "",
      extension_name: "Adopted",
    },
    pbxSecret: "pbx-rendered-secret",
    legacy: { path: "/etc/asterisk/pjsip_ext_9999.conf", present: true, removed: true, reason: "" },
    writeThrows: false,
    mediaThrows: false,
    calls: [],
    reloads: [],
    ...over,
  };
}

const callNames = () => globalThis.__repairTest.calls.map((c) => c[0]);
const callIndex = (name) => callNames().indexOf(name);
// `UPDATE freepbx_extensions SET extension_secret = ? WHERE id = ? AND user_id = ?`
// — so arg 1 is the secret, 2 the row id, 3 the owner.
const storedSecrets = () =>
  globalThis.__repairTest.calls.filter((c) => c[0] === "db.run").map((c) => c[1]);

function repair(body = {}) {
  return route.POST({ json: async () => ({ id: "row-legacy", ...body }) });
}

before(async () => {
  const dir = transpile(["src/app/api/phone/extensions/repair/route.ts"], undefined, {
    "next/server": "./next-server.mjs",
    "@/lib/api-helpers": "./api-helpers.mjs",
    "@/lib/db": "./db.mjs",
    "@/lib/pjsip-endpoint": "./pjsip-endpoint.mjs",
    "@/lib/pjsip-secret": "./pjsip-secret.mjs",
    "@/lib/pjsip-reload": "./pjsip-reload.mjs",
    "@/lib/extension-readiness": "./extension-readiness.mjs",
  });
  writeFileSync(join(dir, "next-server.mjs"), NEXT_SERVER_STUB);
  writeFileSync(join(dir, "api-helpers.mjs"), API_HELPERS_STUB);
  writeFileSync(join(dir, "db.mjs"), DB_STUB);
  writeFileSync(join(dir, "pjsip-endpoint.mjs"), PJSIP_ENDPOINT_STUB);
  writeFileSync(join(dir, "pjsip-secret.mjs"), PJSIP_SECRET_STUB);
  writeFileSync(join(dir, "pjsip-reload.mjs"), PJSIP_RELOAD_STUB);
  writeFileSync(join(dir, "extension-readiness.mjs"), EXTENSION_READINESS_STUB);
  route = await load(dir, "route");
  configure();
});

describe("repairing a legacy-merged extension", () => {
  it("adopts the secret FreePBX renders onto the row", async () => {
    configure();
    const res = await repair();
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.adopted_pbx_secret, true);
    // The row is what the softphone reads its password from; adopting it in the
    // answer but not on the row would be a repair that only looks repaired.
    assert.deepEqual(storedSecrets(), ["pbx-rendered-secret"]);
    const update = globalThis.__repairTest.calls.find((c) => c[0] === "db.run");
    assert.equal(update[2], "row-legacy");
    assert.equal(update[3], "u1");
  });

  it("removes the leftover endpoint file before it appends to FreePBX's", async () => {
    configure();
    await repair();
    // Reading the rendered secret first is fine — it is a read. The *write*
    // order is what matters: the leftover file names a second `[<ext>]`, and
    // appending FreePBX's section before removing it leaves both on the box.
    assert.ok(callIndex("removeLegacyFragment") >= 0);
    assert.ok(
      callIndex("removeLegacyFragment") < callIndex("provisionWebrtc"),
      "the second [<ext>] must go before the append section is written",
    );
    assert.equal((await repair()).body.removed_leftover_endpoint_file, true);
    // And a removal that worked paints no fault.
    assert.equal(globalThis.__repairTest.calls.filter((c) => c[0] === "removeLegacyFragment").length > 0, true);
  });

  it("names a leftover it could not unlink, instead of reporting a clean repair", async () => {
    // The failure the live check found: `/etc/asterisk` is 0775 owned by the
    // PBX's uid, so the portal's own identity cannot unlink in it. A bare `false`
    // here reads as "nothing to remove", which is a different fact and hides a
    // config res_pjsip will refuse.
    configure({
      legacy: {
        path: "/etc/asterisk/pjsip_ext_9999.conf",
        present: true,
        removed: false,
        reason: "EACCES: permission denied, unlink '/etc/asterisk/pjsip_ext_9999.conf'",
      },
    });
    const res = await repair();
    assert.equal(res.status, 200);
    assert.equal(res.body.removed_leftover_endpoint_file, false);
    assert.equal(res.body.legacy_fragment_path, "/etc/asterisk/pjsip_ext_9999.conf");
    assert.match(res.body.legacy_fragment_reason, /EACCES/);
  });

  it("stays quiet when there was no leftover to remove", async () => {
    configure({ legacy: { path: "/etc/asterisk/pjsip_ext_9999.conf", present: false, removed: false, reason: "" } });
    const res = await repair();
    assert.equal(res.body.removed_leftover_endpoint_file, false);
    // "Nothing was there" is not a fault, so it must not paint one.
    assert.equal(res.body.legacy_fragment_reason, "");
    assert.equal(res.body.legacy_fragment_path, "");
  });

  it("reloads from the state it just wrote, not from the pre-repair read", async () => {
    configure();
    await repair();
    assert.equal(globalThis.__repairTest.reloads.length, 1);
    // `readWebrtcState` in this harness reports provisioned:false / no section.
    // A reload decided from that read would be skipped, which is exactly the old
    // "wrote the section, reloaded nothing" bug.
    assert.equal(globalThis.__repairTest.reloads[0].provisioned, true);
    assert.equal(globalThis.__repairTest.reloads[0].section, "[9999](+)");
  });

  it("is idempotent: a second repair changes nothing but the answer", async () => {
    configure();
    const first = await repair();
    // Now the row already holds what the PBX renders, so there is nothing to
    // adopt — but the writes still have to happen, because the *files* are what
    // a later FreePBX write can drop.
    const before = { ...globalThis.__repairTest };
    configure({ row: { ...before.row, extension_secret: "pbx-rendered-secret" } });
    const second = await repair();
    assert.equal(first.body.adopted_pbx_secret, true);
    assert.equal(second.body.adopted_pbx_secret, false);
    assert.equal(second.body.success, true);
    assert.equal(globalThis.__repairTest.calls.filter((c) => c[0] === "db.run").length, 0);
    assert.equal(callIndex("provisionWebrtc") >= 0, true);
  });
});

describe("the repair's refusals", () => {
  it("still removes the leftover endpoint file when there is no secret to adopt", async () => {
    configure({ pbxSecret: "", row: { id: "row-legacy", user_id: "u1", extension_id: "9999", extension_secret: "" } });
    const res = await repair();
    assert.equal(res.status, 409);
    assert.equal(res.body.error, "no_secret_to_repair_with");
    // A second [<ext>] breaks the whole PBX, not just this softphone, so it goes
    // whether or not there is a credential to repair with — before the refusal
    // returns, and before any append section is written beside it.
    assert.ok(callIndex("removeLegacyFragment") >= 0, "the leftover file must still go");
    assert.equal(callIndex("provisionWebrtc"), -1);
    // Nothing was adopted, so nothing may be written to the row.
    assert.deepEqual(storedSecrets(), []);
    assert.ok(res.body.repair.length > 0, "the refusal must carry the remedy");
  });

  it("refuses, without adopting, when the post file cannot be written", async () => {
    configure({ writeThrows: true });
    const res = await repair();
    assert.equal(res.status, 409);
    assert.equal(res.body.error, "webrtc_settings_not_writable");
    // The adoption must not have happened: a row that took a secret nothing
    // registered against is the state this route exists to end.
    assert.deepEqual(storedSecrets(), []);
    // And it names the cause the operator can act on — the group-write bit — not
    // the raw EACCES.
    assert.match(res.body.repair, /portal_config_access|group/i);
  });

  it("reports a half repair as a half repair, not as a failure", async () => {
    configure({ mediaThrows: true });
    const res = await repair();
    // The WebRTC half landed, so the repair happened; only the media address did
    // not, and saying "failed" would make an operator re-run a repair that worked.
    assert.equal(res.status, 200);
    assert.equal(res.body.media_address_written, false);
    assert.match(res.body.media_address_reason, /pjsip_media_custom\.conf|media address/);
    assert.equal(res.body.adopted_pbx_secret, true);
  });

  it("will not repair an extension the signed-in account does not own", async () => {
    configure({ row: undefined });
    const res = await repair();
    assert.equal(res.status, 404);
    assert.equal(callIndex("provisionWebrtc"), -1);
  });
});
