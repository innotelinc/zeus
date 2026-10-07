/**
 * A created extension has to be applied, not just written.
 *
 * `POST /api/phone/extensions` calls FreePBX's `addExtension`, which writes a
 * user and a device and returns success — and nothing regenerates
 * `pjsip.endpoint.conf` / `pjsip.auth.conf` from them. So for as long as the
 * portal did not apply config itself there was no `[<ext>-auth]` for
 * `pbxSecretFor` to read, the row stored a portal-issued secret, and the
 * extension was a row: it routed, it held a mailbox, and every registration was
 * a 401 until an operator went into FreePBX, pressed Apply Config, and came back
 * to press Repair. The readiness chip did say `stale-secret`, but naming a fault
 * is not the same as not creating one.
 *
 * The defect is an **ordering** one, and that is what the first block pins: the
 * apply has to run between the create that needs it and the read that depends on
 * it. The rest of the route is left as it was, because a create that cannot
 * apply for some other reason still has to create — the extension is real, and
 * the honest answer is `apply_config.applied: false` next to the readiness the
 * console already draws, never a silent fallback to a secret that authenticates
 * nothing.
 *
 * The two halves are tested apart on purpose. The route's *order* is pinned
 * against stubs; `freepbx-apply.ts`'s own *policy* — which transaction states
 * mean done, what a timeout is worth, and why applies are chained rather than
 * shared — is pinned against the real module with only the GraphQL client
 * replaced.
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
  return globalThis.__extApplyTest.session;
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
      all() { return []; },
      get() { return globalThis.__extApplyTest.row; },
      run(...args) {
        globalThis.__extApplyTest.calls.push(["db.run", ...args]);
        return { changes: 1 };
      },
    };
  },
};
export default db;
`;

const FREEPBX_STUB = `
export async function addExtension(input) {
  globalThis.__extApplyTest.calls.push(["addExtension", input && input.extensionId]);
  return globalThis.__extApplyTest.addExtension;
}
export async function deleteExtension(extensionId) {
  globalThis.__extApplyTest.calls.push(["deleteExtension", extensionId]);
  return { deleteExtension: { status: true, message: "Extension has been deleted" } };
}
`;

const FREEPBX_APPLY_STUB = `
export async function applyConfigAndWait() {
  globalThis.__extApplyTest.calls.push(["applyConfigAndWait"]);
  return globalThis.__extApplyTest.apply;
}
`;

const PJSIP_ENDPOINT_STUB = `
export const POST_FILE = "pjsip.endpoint_custom_post.conf";
export function sectionHeader(ext) { return "[" + ext + "](+)"; }
export function provisionWebrtc(ext) {
  globalThis.__extApplyTest.calls.push(["provisionWebrtc", ext]);
  return { provisioned: true, file: POST_FILE, section: sectionHeader(ext), requiredSection: sectionHeader(ext), includes: [], legacyFragment: false, reason: "" };
}
export function provisionMediaAddress(ext) {
  globalThis.__extApplyTest.calls.push(["provisionMediaAddress", ext]);
  return { written: true, file: "pjsip_media_custom.conf", address: "192.168.1.30", reason: "" };
}
export function readWebrtcState(ext) {
  return { provisioned: true, file: POST_FILE, section: sectionHeader(ext), requiredSection: sectionHeader(ext), includes: [], legacyFragment: false, reason: "" };
}
export function removeWebrtc(ext) {
  globalThis.__extApplyTest.calls.push(["removeWebrtc", ext]);
}
export function removeLegacyFragment(ext) {
  globalThis.__extApplyTest.calls.push(["removeLegacyFragment", ext]);
  return false;
}
export function removeMediaAddress(ext) {
  globalThis.__extApplyTest.calls.push(["removeMediaAddress", ext]);
  return globalThis.__extApplyTest.mediaRemoved;
}
`;

const PJSIP_SECRET_STUB = `
export function pbxSecretFor(extensionId) {
  globalThis.__extApplyTest.calls.push(["pbxSecretFor", extensionId]);
  return globalThis.__extApplyTest.pbxSecret;
}
`;

const PJSIP_RELOAD_STUB = `
export async function reloadPjsipIfLive() {
  globalThis.__extApplyTest.calls.push(["reloadPjsipIfLive"]);
  return true;
}
`;

const EXTENSION_PREFLIGHT_STUB = `
export function isValidExtension(id) { return /^\\d{2,8}$/.test(id); }
export function judgeExtension() { return globalThis.__extApplyTest.verdict; }
`;

const EXTENSION_READINESS_SERVER_STUB = `
export function withSoftphoneReadiness(rows) { return rows; }
`;

const EXTENSION_PREFLIGHT_LIVE_STUB = `
export async function readObservedExtensions() { return globalThis.__extApplyTest.observed; }
`;

let route;

/** What every collaborator does this test, and the order they were touched. */
function configure(over = {}) {
  globalThis.__extApplyTest = {
    session: { user: { id: "u1" }, error: null },
    verdict: { state: "create" },
    observed: { ok: true, observed: [] },
    addExtension: { addExtension: { status: true, message: "Extension has been created Successfully" } },
    apply: { applied: true, state: "applied", detail: "", transactionId: "1" },
    pbxSecret: "",
    row: { id: "row-1", user_id: "u1", extension_id: "9998", extension_secret: "portal-issued" },
    mediaRemoved: true,
    calls: [],
    ...over,
  };
}

const callNames = () => globalThis.__extApplyTest.calls.map((c) => c[0]);
const callIndex = (name) => callNames().indexOf(name);
/** The secret the INSERT bound — arg 5 of (id, user_id, ext, name, secret, vm, pin). */
const storedSecrets = () =>
  globalThis.__extApplyTest.calls.filter((c) => c[0] === "db.run").map((c) => c[5]);

function post(body = {}) {
  return route.POST({
    json: async () => ({ extensionId: "9998", name: "Probe", email: "p@example.com", ...body }),
  });
}

function del(id = "row-1") {
  return route.DELETE({ url: `http://portal.test/api/phone/extensions?id=${id}` });
}

before(async () => {
  const dir = transpile(["src/app/api/phone/extensions/route.ts"], undefined, {
    "next/server": "./next-server.mjs",
    "@/lib/api-helpers": "./api-helpers.mjs",
    "@/lib/db": "./db.mjs",
    "@/lib/freepbx": "./freepbx.mjs",
    "@/lib/pjsip-endpoint": "./pjsip-endpoint.mjs",
    "@/lib/pjsip-secret": "./pjsip-secret.mjs",
    "@/lib/pjsip-reload": "./pjsip-reload.mjs",
    "@/lib/extension-preflight": "./extension-preflight.mjs",
    "@/lib/extension-readiness-server": "./extension-readiness-server.mjs",
    "@/lib/extension-preflight-live": "./extension-preflight-live.mjs",
    "@/lib/freepbx-apply": "./freepbx-apply.mjs",
  });
  writeFileSync(join(dir, "next-server.mjs"), NEXT_SERVER_STUB);
  writeFileSync(join(dir, "api-helpers.mjs"), API_HELPERS_STUB);
  writeFileSync(join(dir, "db.mjs"), DB_STUB);
  writeFileSync(join(dir, "freepbx.mjs"), FREEPBX_STUB);
  writeFileSync(join(dir, "freepbx-apply.mjs"), FREEPBX_APPLY_STUB);
  writeFileSync(join(dir, "pjsip-endpoint.mjs"), PJSIP_ENDPOINT_STUB);
  writeFileSync(join(dir, "pjsip-secret.mjs"), PJSIP_SECRET_STUB);
  writeFileSync(join(dir, "pjsip-reload.mjs"), PJSIP_RELOAD_STUB);
  writeFileSync(join(dir, "extension-preflight.mjs"), EXTENSION_PREFLIGHT_STUB);
  writeFileSync(join(dir, "extension-readiness-server.mjs"), EXTENSION_READINESS_SERVER_STUB);
  writeFileSync(join(dir, "extension-preflight-live.mjs"), EXTENSION_PREFLIGHT_LIVE_STUB);
  route = await load(dir, "route");
});

describe("POST /api/phone/extensions — apply config before reading what it rendered", () => {
  it("applies the create before it reads the credential the create produced", async () => {
    configure({ pbxSecret: "7ddce90c0f9e75f40bd65488d2071565" });
    const res = await post();
    assert.equal(res.status, 201);

    const order = callNames();
    const create = callIndex("addExtension");
    const apply = callIndex("applyConfigAndWait");
    const read = callIndex("pbxSecretFor");
    // This ordering *is* the defect: reading the secret first is what stored one
    // FreePBX had never rendered.
    assert.ok(create !== -1 && apply !== -1 && read !== -1, `missing a step: ${order.join(" -> ")}`);
    assert.ok(create < apply, `the apply must follow the create: ${order.join(" -> ")}`);
    assert.ok(apply < read, `the secret must be read after the apply: ${order.join(" -> ")}`);
  });

  it("stores the secret the PBX rendered, not a portal-issued one", async () => {
    configure({ pbxSecret: "7ddce90c0f9e75f40bd65488d2071565" });
    const body = await (await post()).json();
    assert.equal(body.secret, "7ddce90c0f9e75f40bd65488d2071565");
    assert.deepEqual(storedSecrets(), ["7ddce90c0f9e75f40bd65488d2071565"]);
    assert.equal(body.apply_config.applied, true);
  });

  it("still creates when the apply did not run, and says so", async () => {
    // The extension is real the moment FreePBX wrote it. A reload that could not
    // be applied is not a failed create — it is a phone that cannot register
    // yet, which is exactly the state `stale-secret` + Repair exists for.
    configure({
      pbxSecret: "",
      apply: { applied: false, state: "timeout", detail: "Processing", transactionId: "9" },
    });
    const res = await post();
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.apply_config.applied, false);
    assert.equal(body.apply_config.state, "timeout");
    // Nothing was rendered, so there is nothing to adopt — but the row must
    // still carry *a* secret rather than null, and it must not be the PBX's.
    assert.ok(typeof body.secret === "string" && body.secret.length > 0);
    assert.deepEqual(storedSecrets(), [body.secret]);
  });

  it("does not apply when the create itself failed", async () => {
    configure({ addExtension: { addExtension: { status: false, message: "Failed to create extension" } } });
    const res = await post();
    assert.equal(res.status, 500);
    assert.equal(callIndex("applyConfigAndWait"), -1);
    assert.equal(callIndex("pbxSecretFor"), -1);
  });

  it("does not apply when the preflight refuses the number", async () => {
    configure({ verdict: { state: "in-sync", reason: "already exists" } });
    const res = await post();
    assert.equal(res.status, 409);
    assert.equal(callIndex("applyConfigAndWait"), -1);
  });

  it("does not apply when the PBX could not be read, so nothing may be written", async () => {
    configure({ observed: { ok: false, reason: "AMI down" } });
    const res = await post();
    assert.equal(res.status, 503);
    assert.equal(callIndex("applyConfigAndWait"), -1);
  });
});

describe("DELETE /api/phone/extensions — apply config so the endpoint goes too", () => {
  it("applies after deleting, because the rows going is not the endpoint going", async () => {
    configure();
    const res = await del();
    assert.equal(res.status, 200);
    const body = await res.json();
    const order = callNames();
    const remove = callIndex("deleteExtension");
    const apply = callIndex("applyConfigAndWait");
    assert.ok(remove !== -1 && apply !== -1, `expected both: ${order.join(" -> ")}`);
    assert.ok(remove < apply, `the delete must precede the apply: ${order.join(" -> ")}`);
    assert.equal(body.apply_config.applied, true);
  });

  it("reports an apply that did not run rather than implying the endpoint is gone", async () => {
    configure({ apply: { applied: false, state: "failed", detail: "reload failed", transactionId: "4" } });
    const body = await (await del()).json();
    assert.equal(body.success, true);
    assert.equal(body.apply_config.applied, false);
    assert.equal(body.apply_config.detail, "reload failed");
  });

  it("takes back the media append it wrote, and says whether there was one", async () => {
    // The append outlives its endpoint, and Asterisk answers an append to a
    // category that no longer exists with `Category addition requested, but
    // category '<ext>' does not exist` on every config load — so the delete has
    // to remove it, not leave it for the boot owner to re-derive.
    configure();
    const body = await (await del()).json();
    assert.equal(callNames().includes("removeMediaAddress"), true, callNames().join(" -> "));
    assert.equal(body.removed_media_address, true);

    configure({ mediaRemoved: false });
    const none = await (await del()).json();
    assert.equal(none.removed_media_address, false, "a row with no append must not claim one");
  });
});

// ── freepbx-apply.ts: the waiting policy, with only the client replaced ──

/** The GraphQL client the module imports relatively, replaced wholesale. */
const FREEPBX_CLIENT_STUB = `
export async function applyConfiguration() {
  const t = globalThis.__applyTest;
  t.gqlCalls.push("doreload");
  if (t.throwOnQueue) throw new Error("FreePBX OAuth error: 401 Unauthorized");
  t.queued += 1;
  return t.queueResult;
}
export async function fetchApiStatus(txnId) {
  const t = globalThis.__applyTest;
  t.gqlCalls.push("poll:" + txnId);
  if (t.throwOnPoll) throw new Error("FreePBX GQL error: 502 Bad Gateway");
  return t.statuses.shift() ?? { status: true, message: "Processing" };
}
`;

describe("applyConfigAndWait", () => {
  let apply;

  before(async () => {
    const dir = transpile(["src/lib/freepbx-apply.ts"]);
    // The module imports `./freepbx`, so the stub takes the place the transpiled
    // specifier resolves to.
    writeFileSync(join(dir, "freepbx.mjs"), FREEPBX_CLIENT_STUB);
    apply = await load(dir, "freepbx-apply");
  });

  function world(over = {}) {
    globalThis.__applyTest = {
      queueResult: { status: true, message: "queued", transaction_id: "7" },
      statuses: [
        { status: true, message: "Processing" },
        { status: true, message: "Executed" },
      ],
      gqlCalls: [],
      queued: 0,
      throwOnQueue: false,
      throwOnPoll: false,
      ...over,
    };
    return globalThis.__applyTest;
  }

  it("resolves applied once the transaction reads Executed", async () => {
    world();
    const out = await apply.applyConfigAndWait({ pollMs: 1, timeoutMs: 5_000 });
    assert.equal(out.applied, true);
    assert.equal(out.state, "applied");
    assert.equal(out.transactionId, "7");
  });

  it("does not treat Processing as done", async () => {
    world({ statuses: [{ status: true, message: "Processing" }] });
    const out = await apply.applyConfigAndWait({ pollMs: 1, timeoutMs: 25 });
    assert.equal(out.applied, false);
    assert.equal(out.state, "timeout");
    assert.equal(out.detail, "Processing");
  });

  it("carries FreePBX's own failure detail through", async () => {
    world({ statuses: [{ status: true, message: "Failed", details: "fwconsole reload exited 1" }] });
    const out = await apply.applyConfigAndWait({ pollMs: 1, timeoutMs: 5_000 });
    assert.equal(out.applied, false);
    assert.equal(out.state, "failed");
    assert.equal(out.detail, "fwconsole reload exited 1");
  });

  it("reports a reload the PBX would not queue, instead of polling a transaction that is not there", async () => {
    world({ queueResult: { status: false, message: "Doreload is not required" } });
    const out = await apply.applyConfigAndWait({ pollMs: 1, timeoutMs: 5_000 });
    assert.equal(out.state, "refused");
    assert.equal(out.detail, "Doreload is not required");
    assert.deepEqual(globalThis.__applyTest.gqlCalls, ["doreload"]);
  });

  it("separates an unreachable PBX from a reload that failed", async () => {
    world({ throwOnQueue: true });
    const out = await apply.applyConfigAndWait({ pollMs: 1, timeoutMs: 5_000 });
    assert.equal(out.applied, false);
    assert.equal(out.state, "unreachable");
    assert.match(out.detail, /401/);
  });

  it("does not let a poll that failed become a reload that succeeded", async () => {
    world({ throwOnPoll: true });
    const out = await apply.applyConfigAndWait({ pollMs: 1, timeoutMs: 25 });
    assert.equal(out.applied, false);
    assert.equal(out.state, "timeout");
    assert.match(out.detail, /last poll failed/);
  });

  it("chains applies instead of sharing one, so a later caller is not told applied for config that predates it", async () => {
    const w = world({
      statuses: [
        { status: true, message: "Processing" },
        { status: true, message: "Executed" },
        { status: true, message: "Processing" },
        { status: true, message: "Executed" },
      ],
    });
    const [a, b] = await Promise.all([
      apply.applyConfigAndWait({ pollMs: 1, timeoutMs: 5_000 }),
      apply.applyConfigAndWait({ pollMs: 1, timeoutMs: 5_000 }),
    ]);
    assert.equal(a.applied, true);
    assert.equal(b.applied, true);
    // Two reloads ran — not one shared — and the second was not queued until the
    // first had finished, so no caller is told "applied" about config that was
    // generated before its own rows existed.
    assert.equal(w.queued, 2);
    assert.deepEqual(w.gqlCalls, [
      "doreload", "poll:7", "poll:7",
      "doreload", "poll:7", "poll:7",
    ]);
  });

  it("does not let one caller's failure poison the next", async () => {
    world({ throwOnQueue: true });
    const bad = await apply.applyConfigAndWait({ pollMs: 1, timeoutMs: 25 });
    assert.equal(bad.state, "unreachable");
    world();
    const good = await apply.applyConfigAndWait({ pollMs: 1, timeoutMs: 5_000 });
    assert.equal(good.applied, true);
  });
});
