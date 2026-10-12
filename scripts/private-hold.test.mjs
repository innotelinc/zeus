/**
 * Private Hold's one real mechanism, and the wiring it depends on.
 *
 * "The caller is stuck listening to hold music and I can't hear them" has one
 * in-repo cause: the private-hold route used to send
 *
 *     Action: <active ? "MusicOnHold" : "MusicOnHold">
 *     State:  <active ? "on" : "off">
 *
 * — the same action for *both* directions, and an action Asterisk does not
 * have. `manager show commands` carries no `MusicOnHold` in any release from 12
 * through 22, so the request is answered `Response: Error`: engage could never
 * start music and, once anything did hold the far end, release could never take
 * them off it. The operation lives in ARI:
 *
 *     POST   /ari/channels/{channelId}/hold   — hold the channel (MOH to it)
 *     DELETE /ari/channels/{channelId}/hold   — remove it from hold
 *
 * Three things can go wrong silently here, none of them visible to a typecheck:
 *
 *   1. **The channel id is not encoded.** ARI resolves `channelId` with
 *      `ast_channel_get_by_name()`, so the name the AMI `Status` event carries
 *      (`PJSIP/4132643964-0000000a`) is accepted — but it is one path segment,
 *      and an unencoded `/` means the route never matches and the hold silently
 *      404s.
 *   2. **Release is not a release.** DELETE is what stops the music; a POST that
 *      merely says "off" leaves the caller on it.
 *   3. **The wiring is missing.** ARI needs its own credentials reaching the
 *      portal (they are not the AMI ones), or every hold answers 503.
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { REPO, load, transpile } from "./ts-probe.mjs";

const CHANNEL = "PJSIP/4132643964-0000000a";
const ENCODED = "PJSIP%2F4132643964-0000000a";

let ari;
let dir;
let server;
let baseUrl;
let requests;
// What the fake PBX lists for `GET /ari/bridges?type=holding`. Set per case.
let holdingBridges;

const AUTH = `Basic ${Buffer.from("pbxportal:s3cret").toString("base64")}`;

before(async () => {
  dir = transpile(["src/lib/ari.ts"]);
  ari = await load(dir, "ari");

  requests = [];
  holdingBridges = [];
  server = createServer((req, res) => {
    requests.push({
      method: req.method,
      url: req.url,
      auth: req.headers.authorization,
    });
    const json = (body, status = 200) => {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(body));
    };
    // ARI is authenticated, and the reachability check exists precisely to tell
    // "nothing is listening" apart from "these credentials were refused".
    if (req.headers.authorization !== AUTH) {
      json({ message: "Authentication required" }, 401);
      return;
    }
    if (req.url === "/ari/asterisk/info") {
      json({ build: { os: "Linux" } });
      return;
    }
    if (req.url.startsWith("/ari/bridges")) {
      // The detail read: a list row may omit `channels`, and the reader has to
      // ask for the bridge itself rather than conclude nobody is held.
      const detail = /^\/ari\/bridges\/([^/?]+)/.exec(req.url);
      if (detail) {
        json({ id: detail[1], bridge_type: "holding", channels: [`PJSIP/detail-${detail[1]}`] });
        return;
      }
      json(holdingBridges);
      return;
    }
    // One channel is "gone" so the failure path carries the PBX's own words.
    if (req.url.includes("gone")) {
      res.statusCode = 404;
      res.end("Channel not found");
      return;
    }
    res.statusCode = 204;
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  ({ port: baseUrl } = server.address());
});

after(() => {
  server?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** Run a case with exactly this ARI environment, then restore it. */
function withEnv(env, fn) {
  const keys = ["ASTERISK_ARI_BASE_URL", "ASTERISK_ARI_USERNAME", "ASTERISK_ARI_PASSWORD"];
  const saved = { ...process.env };
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, env);
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, saved);
    });
}

const configured = () => ({
  ASTERISK_ARI_BASE_URL: `http://127.0.0.1:${baseUrl}`,
  ASTERISK_ARI_USERNAME: "pbxportal",
  ASTERISK_ARI_PASSWORD: "s3cret",
});

describe("holding a channel", () => {
  it("encodes the channel name into one path segment", () => {
    withEnv(configured(), () => {
      assert.equal(ari.holdUrl(CHANNEL), `http://127.0.0.1:${baseUrl}/ari/channels/${ENCODED}/hold`);
    });
  });

  it("POSTs to engage, with the portal's ARI credentials", async () => {
    await withEnv(configured(), async () => {
      requests.length = 0;
      await ari.setChannelHold(CHANNEL, true);
      assert.equal(requests.length, 1);
      assert.equal(requests[0].method, "POST");
      assert.equal(requests[0].url, `/ari/channels/${ENCODED}/hold`);
      assert.equal(
        requests[0].auth,
        `Basic ${Buffer.from("pbxportal:s3cret").toString("base64")}`,
      );
    });
  });

  it("DELETEs to release — a release is not another POST", async () => {
    await withEnv(configured(), async () => {
      requests.length = 0;
      await ari.setChannelHold(CHANNEL, false);
      assert.equal(requests.length, 1);
      assert.equal(requests[0].method, "DELETE");
      assert.equal(requests[0].url, `/ari/channels/${ENCODED}/hold`);
    });
  });

  it("reports the PBX's own reason when the hold is refused", async () => {
    await withEnv(configured(), async () => {
      await assert.rejects(
        ari.setChannelHold("PJSIP/gone-0000000b", true),
        /HTTP 404.*Channel not found/s,
      );
    });
  });

  it("refuses, naming the variables, when ARI is not configured", async () => {
    await withEnv({}, async () => {
      assert.equal(ari.ariConfigured(), false);
      await assert.rejects(ari.setChannelHold(CHANNEL, true), /ASTERISK_ARI_BASE_URL/);
    });
  });

  it("needs all three values, not just an address", async () => {
    await withEnv({ ASTERISK_ARI_BASE_URL: `http://127.0.0.1:${baseUrl}` }, () => {
      assert.equal(ari.ariConfigured(), false);
    });
  });
});

describe("reading hold state from the PBX", () => {
  it("lists the channels Asterisk is holding", async () => {
    await withEnv(configured(), async () => {
      holdingBridges = [
        {
          id: "b1",
          bridge_type: "holding",
          channels: ["PJSIP/voipms-endpoint-0000000b", "PJSIP/other-0000000c"],
        },
      ];
      requests.length = 0;
      const held = await ari.listHoldingChannels();
      assert.deepEqual(
        [...held].sort(),
        ["PJSIP/other-0000000c", "PJSIP/voipms-endpoint-0000000b"],
      );
      assert.equal(requests[0].url, "/ari/bridges?type=holding");
      assert.equal(requests[0].auth, AUTH);
    });
  });

  it("asks the bridge itself when a list row omits its channels", async () => {
    // Reporting "nobody is held" because one field was absent is how a caller
    // stays on music while the console offers to hold them again.
    await withEnv(configured(), async () => {
      holdingBridges = [{ id: "b9", bridge_type: "holding" }];
      requests.length = 0;
      const held = await ari.listHoldingChannels();
      assert.deepEqual([...held], ["PJSIP/detail-b9"]);
      assert.ok(requests.some((r) => r.url === "/ari/bridges/b9"));
    });
  });

  it("reports nobody held when the PBX holds no bridges", async () => {
    await withEnv(configured(), async () => {
      holdingBridges = [];
      assert.equal((await ari.listHoldingChannels()).size, 0);
    });
  });

  it("refuses to invent a state when ARI is not configured", async () => {
    await withEnv({}, async () => {
      await assert.rejects(ari.listHoldingChannels(), /ASTERISK_ARI_BASE_URL/);
    });
  });
});

describe("the reachability check", () => {
  it("passes silently when ARI answers", async () => {
    await withEnv(configured(), async () => {
      assert.equal(await ari.ariReachable(), "");
    });
  });

  it("names the credentials when they are refused, not the URL", async () => {
    // A healthy AMI next to a 401 here is the exact state that reads as
    // "Private Hold does nothing": the two interfaces have separate users.
    await withEnv({ ...configured(), ASTERISK_ARI_PASSWORD: "wrong" }, async () => {
      const reason = await ari.ariReachable();
      assert.match(reason, /rejected/);
      assert.match(reason, /ASTERISK_ARI_USERNAME/);
    });
  });

  it("names the address when nothing is listening", async () => {
    await withEnv({ ...configured(), ASTERISK_ARI_BASE_URL: "http://127.0.0.1:9" }, async () => {
      const reason = await ari.ariReachable();
      assert.match(reason, /unreachable/);
      assert.match(reason, /127\.0\.0\.1:9/);
    });
  });

  it("says what is missing rather than probing nothing", async () => {
    await withEnv({}, async () => {
      assert.match(await ari.ariReachable(), /ASTERISK_ARI_BASE_URL/);
    });
  });
});

describe("the console shows the PBX's state, not its own", () => {
  it("reads hold state before holding and after", () => {
    const route = readFileSync(join(REPO, "src/app/api/ami/private-hold/route.ts"), "utf8");
    assert.match(route, /export async function GET/);
    assert.match(route, /listHoldingChannels\(\)/);
    assert.match(route, /ariReachable\(\)/);
    // The POST answers with the PBX's read-back, not with the request.
    assert.match(route, /active: active \?\? parsed\.data\.active/);
  });

  it("takes the state from the endpoint instead of a local boolean", () => {
    const ui = readFileSync(
      join(REPO, "src/components/dashboard/SoftphoneSection.tsx"),
      "utf8",
    );
    assert.match(ui, /pbxHold/);
    assert.match(ui, /private-hold\?extension_id=/);
    // The PBX's value decides what is shown and what the button toggles; the
    // local boolean is only a fallback for a read the PBX could not answer.
    assert.match(ui, /const holdState = callState === "in-call" \? pbxHold : null/);
    assert.match(ui, /const holdActive = holdState\?\.active \?\? privateHold/);
    assert.match(ui, /const next = !holdActive/);
  });

  it("reports the check live from /api/health", () => {
    const route = readFileSync(join(REPO, "src/app/api/health/route.ts"), "utf8");
    assert.match(route, /probePrivateHold/);
    assert.match(route, /private_hold: privateHoldResult/);
    assert.match(route, /private_hold: ProbeResult/);
  });

  it("declares it in the health vocabulary every screen reads", () => {
    const services = readFileSync(join(REPO, "src/lib/health-services.ts"), "utf8");
    assert.match(services, /"private_hold"/);
    assert.match(services, /private_hold: \{/);
  });
});

describe("the wiring it depends on", () => {
  it("holds through ARI, never through an AMI action that does not exist", () => {
    const route = readFileSync(join(REPO, "src/app/api/ami/private-hold/route.ts"), "utf8");
    assert.match(route, /setChannelHold\(/);
    assert.match(route, /ariConfigured\(\)/);
    assert.doesNotMatch(route, /Action:\s*"MusicOnHold"/);
    assert.doesNotMatch(route, /StopMusicOnHold/);
  });

  it("hands the portal service its own ARI credentials", () => {
    const compose = readFileSync(join(REPO, "docker-compose.full.yml"), "utf8");
    assert.match(compose, /^\s*ASTERISK_ARI_BASE_URL:/m);
    assert.match(compose, /^\s*ASTERISK_ARI_USERNAME:/m);
    assert.match(compose, /^\s*ASTERISK_ARI_PASSWORD:/m);
  });

  it("declares them for an operator in the env template", () => {
    const example = readFileSync(join(REPO, ".env.example"), "utf8");
    assert.match(example, /^ASTERISK_ARI_BASE_URL=$/m);
    assert.match(example, /^ASTERISK_ARI_USERNAME=$/m);
    assert.match(example, /^ASTERISK_ARI_PASSWORD=$/m);
  });
});
