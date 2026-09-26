/**
 * The media address a softphone created *now* is handed — the check, and the
 * deployment fact it depends on.
 *
 * The boot owner converges every endpoint, so the estate looks healthy on any
 * restart. But a phone created *between* boots is covered only by the create
 * path, and that path writes nothing when no reachable
 * `PJSIP_MEDIA_ADDRESS`/`LAN_IP` reaches the portal: it reports `written: false`
 * and defers to the next boot. Nothing fails — the extension is created, the
 * portal says it succeeded, and the phone loses its voice and every DTMF digit
 * until the box restarts. Measured on `.30`: the portal service was never passed
 * the address, so the create-time write had never once run.
 *
 * Two things can go wrong silently here, neither visible to a typecheck:
 *
 *   1. **The judgement drifts from the create path.** This check must ask the
 *      same question `provisionMediaAddress` asks (`mediaAddressFromEnv`), or a
 *      green health row and a phone that is handed nothing coexist.
 *   2. **The wiring is lost.** The address has to reach the *portal* container,
 *      not just the PBX's — and the probe has to be in the health vocabulary
 *      and response, or `/api/health` never reports it.
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { REPO, load, transpile } from "./ts-probe.mjs";

let live;
let endpoints;
let dir;

before(async () => {
  dir = transpile(["src/lib/pjsip-endpoint.ts", "src/lib/softphone-media-live.ts"]);
  live = await load(dir, "softphone-media-live");
  endpoints = await load(dir, "pjsip-endpoint");
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Run the check with exactly these env vars, then restore the environment. */
function withEnv(env, fn) {
  const saved = { ...process.env };
  for (const key of ["PJSIP_MEDIA_ADDRESS", "LAN_IP"]) delete process.env[key];
  Object.assign(process.env, env);
  try {
    return fn();
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

describe("the live check", () => {
  it("is green when the create path would write an address", () => {
    withEnv({ PJSIP_MEDIA_ADDRESS: "192.168.1.30" }, () => {
      const readiness = live.softphoneMediaReadiness();
      assert.equal(readiness.ok, true);
      assert.equal(readiness.address, "192.168.1.30");
      assert.match(readiness.detail, /192\.168\.1\.30/);
      assert.equal(readiness.error, "");
    });
  });

  it("accepts LAN_IP as the fallback, like the create path does", () => {
    withEnv({ LAN_IP: "192.168.1.30" }, () => {
      assert.equal(live.softphoneMediaReadiness().ok, true);
    });
  });

  it("asks the same question the create path asks", () => {
    // The pin that makes this a check of the real path rather than a second
    // opinion: for every value, the two answers agree.
    const cases = [
      { PJSIP_MEDIA_ADDRESS: "192.168.1.30" },
      { PJSIP_MEDIA_ADDRESS: "10.0.0.5" },
      { PJSIP_MEDIA_ADDRESS: "172.19.0.4" },
      { PJSIP_MEDIA_ADDRESS: "127.0.0.1" },
      { PJSIP_MEDIA_ADDRESS: "not-an-address" },
      { LAN_IP: "192.168.1.44" },
      {},
    ];
    for (const env of cases) {
      withEnv(env, () => {
        const expected = endpoints.mediaAddressFromEnv();
        const readiness = live.softphoneMediaReadiness();
        assert.equal(
          readiness.ok,
          expected !== "",
          `disagree about ${JSON.stringify(env)}: create path=${JSON.stringify(expected)}`,
        );
        assert.equal(readiness.address, expected);
      });
    }
  });

  it("is red, naming the repair, when no reachable address is configured", () => {
    withEnv({}, () => {
      const readiness = live.softphoneMediaReadiness();
      assert.equal(readiness.ok, false);
      assert.equal(readiness.address, "");
      assert.match(readiness.error, /PJSIP_MEDIA_ADDRESS/);
      assert.match(readiness.error, /next boot/);
    });
  });

  it("refuses a docker or loopback address, because the create path does", () => {
    // These are the exact defect the media work removes: Asterisk's own
    // container address in the answer SDP, which a phone cannot route to.
    for (const address of ["172.19.0.4", "172.16.0.1", "127.0.0.1", "169.254.1.1"]) {
      withEnv({ PJSIP_MEDIA_ADDRESS: address }, () => {
        assert.equal(live.softphoneMediaReadiness().ok, false, address);
      });
    }
  });
});

describe("the wiring it depends on", () => {
  it("hands the address to the portal service, not just the PBX's", () => {
    // Twice: the freepbx service (the boot owner) and the portal service (the
    // create path). One occurrence is the bug — a portal that cannot write.
    const compose = readFileSync(join(REPO, "docker-compose.full.yml"), "utf8");
    const occurrences = compose.match(/^\s*PJSIP_MEDIA_ADDRESS:/gm) ?? [];
    assert.ok(
      occurrences.length >= 2,
      `the portal service is not passed a media address (found ${occurrences.length} PJSIP_MEDIA_ADDRESS)`,
    );
  });

  it("reports the check from /api/health", () => {
    const route = readFileSync(join(REPO, "src/app/api/health/route.ts"), "utf8");
    assert.match(route, /probeSoftphoneMedia/);
    assert.match(route, /softphone_media: softphoneMediaResult/);
    assert.match(route, /softphone_media: ProbeResult/);
  });

  it("declares it in the health vocabulary every screen reads", () => {
    const services = readFileSync(join(REPO, "src/lib/health-services.ts"), "utf8");
    assert.match(services, /"softphone_media"/);
    assert.match(services, /softphone_media: \{/);
  });
});
