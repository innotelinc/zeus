/**
 * `POST /api/pbx/restart` — the admin's remedy for a PBX whose live state has
 * gone stale, exercised for real rather than pinned at the source.
 *
 * The route is thin, but every one of its branches is a *refusal* that has to
 * hold, and a refusal that silently turns into an action is the failure this
 * whole surface exists to prevent:
 *
 *   * no session        → 401 (not a reload on an anonymous request),
 *   * not an admin      → 403 (a reload is estate-wide, not account-scoped),
 *   * AMI disconnected  → 503 (a reload that cannot be sent is not a reload,
 *                         and reporting success would be the silent no-op),
 *   * an unknown mode   → 400, never a default that fires `core restart now`.
 *
 * The two modes are then checked for *how* they are sent, because that is where
 * the route's one non-obvious decision lives: `reload` awaits `sendAction`
 * (a `Follows` reply carries the output), while `restart` must use
 * `sendActionAsync` — `core restart now` tears down the AMI connection the
 * command arrived on, so waiting for a reply can only ever time out.
 *
 * The handler imports `@/lib/auth`, `@/lib/ami` and `next/server`, none of which
 * load outside the Next runtime, so `transpile` rewrites those specifiers and
 * this file drops stubs beside the transpiled route. The collaborators are
 * controlled through one global, and the stubs read it: the route under test is
 * the real one.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { before, describe, it } from "node:test";

import { load, transpile } from "./ts-probe.mjs";

let route;

// A minimal `NextResponse.json`: enough shape for the route (`.status` and a
// body the test can read back), with no Next runtime behind it.
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

const AUTH_STUB = `
export async function getCurrentUser() {
  return globalThis.__pbxRestartTest.user;
}
`;

const AMI_STUB = `
export function getAmiClient() {
  return globalThis.__pbxRestartTest.ami;
}
`;

/** An AMI client whose two send paths record what they were handed. */
function fakeAmi({ connected = true } = {}) {
  const sent = [];
  const asyncSent = [];
  return {
    isConnected: connected,
    sent,
    asyncSent,
    async sendAction(action) {
      sent.push(action);
      return { Output: "res_pjsip.so reloaded" };
    },
    sendActionAsync(action) {
      asyncSent.push(action);
    },
  };
}

function configure({ user, ami }) {
  globalThis.__pbxRestartTest = { user, ami };
}

/** A Request stand-in: the route only calls `.json()`. */
function request(body) {
  return { json: async () => body };
}

before(async () => {
  const dir = transpile(
    ["src/app/api/pbx/restart/route.ts"],
    undefined,
    {
      "@/lib/auth": "./auth.mjs",
      "@/lib/ami": "./ami.mjs",
      "next/server": "./next-server.mjs",
    },
  );
  writeFileSync(join(dir, "next-server.mjs"), NEXT_SERVER_STUB);
  writeFileSync(join(dir, "auth.mjs"), AUTH_STUB);
  writeFileSync(join(dir, "ami.mjs"), AMI_STUB);
  route = await load(dir, "route");
});

describe("POST /api/pbx/restart — refusals", () => {
  it("is 401 without a session", async () => {
    configure({ user: null, ami: fakeAmi() });
    const res = await route.POST(request({ mode: "reload" }));
    assert.equal(res.status, 401);
  });

  it("is 403 for a signed-in non-admin", async () => {
    configure({ user: { id: "u1", role: "user" }, ami: fakeAmi() });
    const res = await route.POST(request({ mode: "restart" }));
    assert.equal(res.status, 403);
  });

  it("is 503 when AMI is not connected — and sends nothing", async () => {
    const ami = fakeAmi({ connected: false });
    configure({ user: { id: "a1", role: "admin" }, ami });
    const res = await route.POST(request({ mode: "reload" }));
    assert.equal(res.status, 503);
    assert.equal(ami.sent.length, 0);
    assert.equal(ami.asyncSent.length, 0);
  });

  it("is 400 for an unknown mode, and never falls back to a restart", async () => {
    const ami = fakeAmi();
    configure({ user: { id: "a1", role: "admin" }, ami });
    const res = await route.POST(request({ mode: "nuke" }));
    assert.equal(res.status, 400);
    assert.equal(ami.asyncSent.length, 0);
  });
});

describe("POST /api/pbx/restart — the two modes", () => {
  it("reload sends `module reload res_pjsip.so` synchronously", async () => {
    const ami = fakeAmi();
    configure({ user: { id: "a1", role: "admin" }, ami });
    const res = await route.POST(request({ mode: "reload" }));

    assert.equal(res.status, 200);
    assert.equal((await res.json()).mode, "reload");
    assert.equal(ami.sent.length, 1);
    assert.equal(ami.sent[0].Action, "Command");
    assert.equal(ami.sent[0].Command, "module reload res_pjsip.so");
    assert.equal(ami.asyncSent.length, 0);
  });

  it("restart is fire-and-forget — sent async, so it survives the reply socket", async () => {
    const ami = fakeAmi();
    configure({ user: { id: "a1", role: "admin" }, ami });
    const res = await route.POST(request({ mode: "restart" }));

    assert.equal(res.status, 200);
    assert.equal(ami.asyncSent.length, 1);
    assert.equal(ami.asyncSent[0].Command, "core restart now");
    // Never the synchronous path: that wait can only time out.
    assert.equal(ami.sent.length, 0);
  });

  it("defaults to a restart when no mode is given", async () => {
    const ami = fakeAmi();
    configure({ user: { id: "a1", role: "admin" }, ami });
    const res = await route.POST(request({}));

    assert.equal(res.status, 200);
    assert.equal((await res.json()).mode, "restart");
    assert.equal(ami.asyncSent[0].Command, "core restart now");
  });
});
