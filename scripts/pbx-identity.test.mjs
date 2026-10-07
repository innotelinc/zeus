/**
 * The PBX signs its own SIP requests with its hostname, so the hostname has to
 * be one a browser will accept.
 *
 * For a client inside the transport's `local_net` — a browser on the LAN, which
 * is where the dashboard softphone is opened when someone walks up to the box —
 * Asterisk's `external_signaling_address` / `external_signaling_hostname` pair
 * does not apply, and the identity it falls back on is `gethostname()`. That
 * lands in the `From` and `Contact` of every OPTIONS, NOTIFY and INVITE the PBX
 * sends, and Docker's default hostname is the twelve-hex-char container id.
 *
 * SIP.js does not accept that as a host: RFC 3261's `hostname` ABNF ends in a
 * `toplabel`, and a `toplabel` must begin with a letter, so a bare label like
 * `5b1817aa4d31` is not a hostname. The browser's answer is total and silent
 * from the PBX's side — it logs
 *
 *   sip.Parser | error parsing header 'From'
 *   sip.UserAgent | Failed to parse incoming message. Dropping.
 *
 * for every inbound request, so registration succeeds, the panel says
 * "Registered with the PBX", and the phone can never receive a call at all.
 * (Measured, not inferred: with `hostname: zeus-pbx` the same call produced
 * 100 Trying -> 180 Ringing -> established on the first attempt.)
 *
 * `external_signaling_hostname` cannot be the fix here — it is mutually
 * exclusive with the `external_signaling_address` FreePBX already renders onto
 * the transport, and configuring both makes res_pjsip refuse the whole
 * transport ("has both ... set. Only one may be configured at a time"), which
 * takes the WSS listener down with it. The hostname is the lever that works.
 *
 * Deleting one line in a compose file restores the breakage exactly, so it is
 * pinned here rather than left to the comment that explains it.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { REPO } from "./ts-probe.mjs";

const COMPOSE = readFileSync(join(REPO, "docker-compose.full.yml"), "utf8");

/**
 * Is `name` a host a SIP URI may carry?
 *
 * RFC 3261: `hostname = *(domainlabel ".") toplabel ["."]`, where a
 * `domainlabel` is alphanumeric with internal hyphens and a `toplabel` must
 * start with a letter. So only the *last* label has to begin with a letter —
 * `1.example.com` is legal — but a single label must be a `toplabel`, which is
 * what rules out the container id. An IPv4 literal is also a host.
 */
export function isSipHost(name) {
  if (typeof name !== "string" || name.trim() !== name || name === "") return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(name)) {
    return name.split(".").every((o) => Number(o) <= 255);
  }
  const labels = name.split(".");
  if (labels.some((l) => !/^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$/.test(l))) return false;
  // The toplabel — and therefore a bare single-label host — must start with a
  // letter. This is the rule the container id fails.
  return /^[A-Za-z]/.test(labels[labels.length - 1]);
}

/** The text of one top-level service block in the compose file. */
function serviceBlock(name) {
  const lines = COMPOSE.split("\n");
  const start = lines.findIndex((l) => l === `  ${name}:`);
  assert.notEqual(start, -1, `docker-compose.full.yml has no '${name}:' service`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    // A service key is exactly two spaces of indent; anything else (a key
    // inside the block, a top-level key) is not the end of it.
    if (/^ {2}[A-Za-z0-9_.-]+:\s*$/.test(lines[i])) { end = i; break; }
    if (/^[A-Za-z0-9_.-]+:/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join("\n");
}

describe("the PBX container's SIP identity", () => {
  it("declares a hostname for the freepbx service", () => {
    const block = serviceBlock("freepbx");
    const match = /^\s*hostname:\s*(.+?)\s*$/m.exec(block);
    assert.ok(
      match,
      "the freepbx service must set `hostname:` — without it Asterisk signs its " +
        "From/Contact with the Docker container id and every browser softphone " +
        "drops every inbound request",
    );
    assert.ok(
      isSipHost(match[1]),
      `freepbx hostname ${JSON.stringify(match[1])} is not a legal SIP host: ` +
        "SIP.js rejects a bare label that starts with a digit, so the PBX's own " +
        "From and Contact headers become unparseable",
    );
  });

  it("rejects the shape Docker defaults to, and accepts the shapes that work", () => {
    // The defect, as it was actually seen in the browser.
    assert.equal(isSipHost("5b1817aa4d31"), false);
    // What the fix uses, and the other identities this box is reachable by.
    assert.equal(isSipHost("zeus-pbx"), true);
    assert.equal(isSipHost("ws.zeus.innotel.us"), true);
    assert.equal(isSipHost("1.example.com"), true);
    assert.equal(isSipHost("192.168.1.30"), true);
    // Still not hostnames: empty, digit-final, stray punctuation, bad octet.
    assert.equal(isSipHost(""), false);
    assert.equal(isSipHost("-pbx"), false);
    assert.equal(isSipHost("zeus-pbx-"), false);
    assert.equal(isSipHost("zeus_pbx"), false);
    assert.equal(isSipHost("999.1.1.1"), false);
  });

  it("keeps hostname and container_name distinct concerns", () => {
    // The container name is how every other service on the box dials the PBX;
    // the hostname is only the SIP identity. Changing one must not be mistaken
    // for changing the other, so the name stays put.
    assert.match(serviceBlock("freepbx"), /^\s*container_name:\s*zeus-freepbx\s*$/m);
  });
});
