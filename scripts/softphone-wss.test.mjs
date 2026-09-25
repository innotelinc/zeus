/**
 * The softphone's WebSocket address — the resolution rule, pinned.
 *
 * Three surfaces needed this answer and each had its own: the softphone panel
 * (`wss://<hostname>:8089/ws`), the Settings override field (same, and it wrote
 * that value to localStorage, so a user's saved choice kept reproducing it), and
 * the compose default (`wss://ws.<domain>:8089/ws`). The `:8089` form is wrong
 * on every deployment here — it reaches Asterisk's self-signed socket, which a
 * browser refuses, and it is not open from outside the LAN. The estate serves
 * `wss://ws.<domain>/ws` behind NPM instead.
 *
 * So these tests exist to stop that port coming back: the regression assertion
 * below runs every branch the function has and fails if any of them emits one.
 */
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import { load, transpile } from "./ts-probe.mjs";

let wssHostFor;
let softphoneWssUrl;
let hostnameFromHostHeader;

before(async () => {
  const dir = transpile(["src/lib/softphone-wss.ts"]);
  ({ wssHostFor, softphoneWssUrl, hostnameFromHostHeader } = await load(dir, "softphone-wss"));
});

describe("wssHostFor", () => {
  it("swaps the subdomain label for `ws.`", () => {
    assert.equal(wssHostFor("app.zeus.innotel.us"), "ws.zeus.innotel.us");
    assert.equal(wssHostFor("portal.zeus.innotel.us"), "ws.zeus.innotel.us");
  });

  it("leaves a host that is already the socket's alone", () => {
    assert.equal(wssHostFor("ws.zeus.innotel.us"), "ws.zeus.innotel.us");
  });

  it("leaves hosts with no subdomain to trade, rather than inventing one", () => {
    // `ws.localhost` would resolve nowhere, and a bare address has no label to
    // swap (the first label being numeric is the tell).
    assert.equal(wssHostFor("localhost"), "localhost");
    assert.equal(wssHostFor("192.168.1.30"), "192.168.1.30");
    assert.equal(wssHostFor(""), "");
  });

  it("is case- and whitespace-insensitive", () => {
    assert.equal(wssHostFor("  App.Zeus.Innotel.US  "), "ws.zeus.innotel.us");
  });
});

describe("softphoneWssUrl", () => {
  it("takes an explicit FREEPBX_WSS_URL verbatim", () => {
    assert.equal(
      softphoneWssUrl({ FREEPBX_WSS_URL: "wss://ws.zeus.innotel.us/ws" }),
      "wss://ws.zeus.innotel.us/ws",
    );
    assert.equal(
      softphoneWssUrl({ FREEPBX_WSS_URL: "wss://pbx.example.com:7443/socket" }, "app.zeus.innotel.us"),
      "wss://pbx.example.com:7443/socket",
    );
  });

  it("finishes FREEPBX_WSS_HOST into a port-less path URL", () => {
    assert.equal(softphoneWssUrl({ FREEPBX_WSS_HOST: "ws.zeus.innotel.us" }), "wss://ws.zeus.innotel.us/ws");
    // A leftover port must not survive: the whole defect was a port that is
    // closed behind the proxy.
    assert.equal(softphoneWssUrl({ FREEPBX_WSS_HOST: "ws.zeus.innotel.us:8089" }), "wss://ws.zeus.innotel.us/ws");
  });

  it("prefers the explicit URL over the host", () => {
    assert.equal(
      softphoneWssUrl({ FREEPBX_WSS_URL: "wss://a.example/ws", FREEPBX_WSS_HOST: "b.example" }),
      "wss://a.example/ws",
    );
  });

  it("derives from the dashboard's own hostname when nothing is configured", () => {
    assert.equal(softphoneWssUrl({}, "app.zeus.innotel.us"), "wss://ws.zeus.innotel.us/ws");
    // White-label: a reseller's domain resolves on its own name.
    assert.equal(softphoneWssUrl({}, "portal.acme.example"), "wss://ws.acme.example/ws");
  });

  it("does not fall back to a closed port", () => {
    // The regression. Every branch, and none may emit `:8089`.
    const branches = [
      softphoneWssUrl({}, "app.zeus.innotel.us"),
      softphoneWssUrl({ FREEPBX_WSS_HOST: "ws.zeus.innotel.us:8089" }),
      softphoneWssUrl({ FREEPBX_WSS_HOST: "ws.zeus.innotel.us" }),
      softphoneWssUrl({}, ""),
      softphoneWssUrl(),
    ];
    for (const url of branches) {
      assert.ok(
        !url.includes(":8089"),
        `${url} still names port 8089, which is not reachable from a browser behind the proxy`,
      );
      assert.ok(url.startsWith("wss://"), `${url} must be a secure socket`);
      assert.ok(url.endsWith("/ws"), `${url} must name the /ws path`);
    }
  });
});

describe("hostnameFromHostHeader", () => {
  it("strips the port", () => {
    assert.equal(hostnameFromHostHeader("app.zeus.innotel.us:3001"), "app.zeus.innotel.us");
    assert.equal(hostnameFromHostHeader("app.zeus.innotel.us"), "app.zeus.innotel.us");
  });

  it("keeps an IPv6 literal whole rather than splitting its colons", () => {
    assert.equal(hostnameFromHostHeader("[::1]:3001"), "[::1]");
    assert.equal(hostnameFromHostHeader("[2001:db8::1]"), "[2001:db8::1]");
  });

  it("is empty-safe", () => {
    assert.equal(hostnameFromHostHeader(""), "");
    assert.equal(hostnameFromHostHeader(undefined), "");
  });
});
