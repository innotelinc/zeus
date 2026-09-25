/**
 * Why a softphone will not register — the judgement, and that its reader agrees
 * with the PBX-side tool.
 *
 * "Offline" in the extensions list is one word for three different faults, and
 * the console's whole value here is telling them apart: no secret at all, a
 * secret FreePBX never rendered, or a fragment nothing loads. The order they
 * are reported in is a decision, not an implementation detail — telling an
 * operator to fix their softphone when the row has no credential is how this
 * screen wastes a day.
 *
 * Two things can go wrong silently, and neither is visible to a typecheck:
 *
 *   1. **The auth parser drifts.** `parseAuthSecrets` is a Node mirror of
 *      `parse_auth_conf` in `pbx/legacy_voice_migrate.py`, which is the tool
 *      that judges a migration on the live box. A copy that reads a different
 *      section, or accepts `secret` where the tool would not, would report a
 *      working endpoint as secretless (or the reverse). The same fixtures are
 *      run through both implementations and the maps are compared exactly.
 *
 *   2. **The ordering drifts.** The states are asserted one by one, and every
 *      state has to be reachable — a judgement that can never return
 *      `stale-secret` is a repair path nobody is ever offered.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { REPO, load, transpile } from "./ts-probe.mjs";

let readiness;
let readers;
let secret;
let dir;

before(async () => {
  // Transpiled together: they import each other by extensionless specifier.
  dir = transpile([
    "src/lib/pjsip-endpoint.ts",
    "src/lib/pjsip-secret.ts",
    "src/lib/extension-readiness.ts",
    "src/lib/extension-readiness-server.ts",
  ]);
  readiness = await load(dir, "extension-readiness");
  readers = await load(dir, "extension-readiness-server");
  secret = await load(dir, "pjsip-secret");
});

after(() => rmSync(dir, { recursive: true, force: true }));

/** The Python tool's own answer, for the same text. */
function pythonSecrets(text) {
  const script = [
    "import json, sys",
    "from legacy_voice_migrate import parse_auth_conf",
    "print(json.dumps(parse_auth_conf(sys.stdin.read())))",
  ].join("\n");
  const out = execFileSync("python3", ["-c", script], {
    cwd: join(REPO, "pbx"),
    input: text,
    encoding: "utf8",
  });
  return JSON.parse(out);
}

/** A fragment state as `readFragmentState` would return it. */
function fragmentState(overrides = {}) {
  return {
    provisioned: true,
    fragment: "pjsip_ext_8000.conf",
    includes: [{ file: "pjsip_custom_post.conf", operatorOwned: true }],
    requiredInclude: "#include pjsip_ext_8000.conf",
    operatorFiles: ["pjsip_custom_post.conf"],
    reason: "pjsip_custom_post.conf includes pjsip_ext_8000.conf",
    ...overrides,
  };
}

const AUTH_FIXTURES = [
  // The shape FreePBX renders for a PJSIP extension.
  ["[101]\ntype=endpoint\n\n[101-auth]\ntype=auth\nauth_type=userpass\nusername=101\npassword=abc123\n", { 101: "abc123" }],
  // `secret` is accepted too: a hand-written endpoint may use it.
  ["[200-auth]\nsecret=hunter2\n", { 200: "hunter2" }],
  // An auth section with no credential line in it renders no secret.
  ["[250-auth]\ntype=auth\nusername=250\n", {}],
  // A password outside an auth section must not be attributed to the extension.
  ["[300]\ntype=aor\npassword=not-a-credential\n", {}],
  ["[300-aor]\npassword=not-a-credential\n", {}],
  // Comments and blank lines, and the last value winning like Asterisk's loader.
  ["; comment\n\n[400-auth]\npassword=first\n# another comment\npassword=second\n", { 400: "second" }],
  // Two extensions in one file.
  ["[500-auth]\npassword=five\n[600-auth]\npassword=six\n", { 500: "five", 600: "six" }],
  // `#include` lines are not section headers, and an empty file has no secrets.
  ["#include pjsip_ext_700.conf\n", {}],
  ["", {}],
];

describe("the auth parser", () => {
  it("reads the secret FreePBX renders, in the same cases the PBX tool does", () => {
    for (const [text, expected] of AUTH_FIXTURES) {
      const ours = Object.fromEntries(secret.parseAuthSecrets(text));
      assert.deepEqual(ours, expected, `for ${JSON.stringify(text)}`);
      // The tool's own answer for the same text, in string keys.
      const theirs = pythonSecrets(text);
      assert.deepEqual(
        ours,
        theirs,
        `portal and pbx/legacy_voice_migrate.py disagree about ${JSON.stringify(text)}`,
      );
    }
  });
});

describe("reading a secret off the box", () => {
  let confDir;

  before(() => {
    confDir = mkdtempSync(join(tmpdir(), "zeus-conf-"));
  });
  after(() => rmSync(confDir, { recursive: true, force: true }));

  it("prefers the generated auth file", () => {
    writeFileSync(join(confDir, "pjsip.auth.conf"), "[8000-auth]\npassword=generated\n");
    writeFileSync(join(confDir, "pjsip_custom_post.conf"), "[8000-auth]\npassword=handwritten\n");
    assert.equal(secret.pbxSecretFor("8000", confDir), "generated");
  });

  it("falls back to an operator-written endpoint", () => {
    // A box where the portal owns the endpoint has no generated auth section.
    rmSync(join(confDir, "pjsip.auth.conf"), { force: true });
    assert.equal(secret.pbxSecretFor("8000", confDir), "handwritten");
  });

  it("says so, rather than throwing, when the PBX renders none", () => {
    assert.equal(secret.pbxSecretFor("9999", confDir), "");
    assert.equal(secret.pbxSecretFor("8000", join(confDir, "no-such-dir")), "");
  });
});

describe("the readiness judgement", () => {
  const ID = "8000";

  it("is ready when the secret matches and something loads the fragment", () => {
    const verdict = readiness.assessSoftphone(ID, "same", "same", fragmentState());
    assert.equal(verdict.state, "ready");
    assert.equal(verdict.secretDiffers, false);
    assert.match(verdict.summary, /pjsip_custom_post\.conf/);
  });

  it("reports a missing secret first, and names where to get one", () => {
    const verdict = readiness.assessSoftphone(ID, null, "rendered", fragmentState({ provisioned: false }));
    assert.equal(verdict.state, "missing-secret");
    assert.match(verdict.summary, /Repair adopts it/);
    // Even with a broken fragment, the missing credential is the thing to fix.
    assert.equal(verdict.secretPresent, false);
  });

  it("knows a missing secret from a PBX that renders none either", () => {
    const verdict = readiness.assessSoftphone(ID, "", "", fragmentState({ provisioned: false }));
    assert.equal(verdict.state, "missing-secret");
    assert.match(verdict.summary, /renders none for it either/);
  });

  it("reports a stale secret before it blames the fragment", () => {
    const verdict = readiness.assessSoftphone(
      ID,
      "portal-secret",
      "pbx-secret",
      fragmentState({ provisioned: false }),
    );
    assert.equal(verdict.state, "stale-secret");
    assert.equal(verdict.secretDiffers, true);
    assert.match(verdict.summary, /refused/);
  });

  it("reports the fragment only when the credential is right", () => {
    const verdict = readiness.assessSoftphone(
      ID,
      "same",
      "same",
      fragmentState({ provisioned: false, reason: "written but nothing includes it" }),
    );
    assert.equal(verdict.state, "not-loaded");
    // The fragment's own words, so the file and line cannot drift from it.
    assert.equal(verdict.summary, "written but nothing includes it");
    assert.equal(verdict.requiredInclude, "#include pjsip_ext_8000.conf");
  });

  it("treats a portal secret with no rendered one as fine", () => {
    // A portal-owned endpoint: the portal wrote the secret, so nothing else
    // renders it, and that is not a mismatch.
    const verdict = readiness.assessSoftphone(ID, "portal-secret", "", fragmentState());
    assert.equal(verdict.state, "ready");
    assert.equal(verdict.secretDiffers, false);
  });

  it("labels every state it can return", () => {
    const states = new Set([
      readiness.assessSoftphone(ID, "s", "s", fragmentState()).state,
      readiness.assessSoftphone(ID, "", "", fragmentState()).state,
      readiness.assessSoftphone(ID, "a", "b", fragmentState()).state,
      readiness.assessSoftphone(ID, "s", "s", fragmentState({ provisioned: false })).state,
    ]);
    for (const state of states) {
      const label = readiness.readinessLabel({ state });
      assert.equal(typeof label, "string");
      assert.ok(label.length > 0, `no label for ${state}`);
    }
    assert.equal(states.size, 4, "a state is unreachable, so its repair is never offered");
  });
});

describe("attaching readiness to rows", () => {
  it("answers for every row without a PBX", () => {
    const empty = mkdtempSync(join(tmpdir(), "zeus-conf-empty-"));
    process.env.PJSIP_CONF_DIR = empty;
    try {
      const rows = readers.withSoftphoneReadiness([
        { id: "a", extension_id: "4132643964", extension_secret: null },
        { id: "b", extension_id: "101", extension_secret: "a-secret" },
      ]);
      assert.equal(rows.length, 2);
      // The 10-digit extension has no secret and no fragment: the first fault.
      assert.equal(rows[0].softphone.state, "missing-secret");
      assert.equal(rows[1].softphone.state, "not-loaded");
      // The row's own fields are untouched.
      assert.equal(rows[1].extension_secret, "a-secret");
    } finally {
      delete process.env.PJSIP_CONF_DIR;
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("what the client may import", () => {
  it("keeps the filesystem out of the module the extensions list renders", () => {
    // The extensions list is a client component: it imports the pure module for
    // its labels. A runtime import there — even of a helper — drags `node:fs`
    // into the page's bundle, and Turbopack then refuses to write the endpoint
    // ("the chunking context does not support external modules (node:fs)").
    // That failed at build time and nowhere else: `node --test` runs in Node,
    // where node:fs exists, so nothing here would notice.
    const source = readFileSync(join(REPO, "src/lib/extension-readiness.ts"), "utf8");
    const imports = source
      .split("\n")
      .filter((line) => /^\s*import\b/.test(line));
    assert.ok(imports.length > 0, "the module lost its imports entirely");
    for (const line of imports) {
      assert.match(
        line,
        /^import\s+type\b/,
        `only type imports are safe here, found: ${line.trim()}`,
      );
    }
    // And the reader it was split away from is the one that touches the disk.
    const server = readFileSync(join(REPO, "src/lib/extension-readiness-server.ts"), "utf8");
    assert.match(server, /from "\.\/pjsip-secret"/);
  });
});

/** A row as the server attaches readiness to it. */
function row(extensionId, softphone) {
  return { id: `row-${extensionId}`, extension_id: extensionId, extension_secret: 's', softphone };
}

const READY = { state: 'ready' };
const NO_SECRET = { state: 'missing-secret' };
const NOT_LOADED = { state: 'not-loaded' };

describe('what the softphone may offer', () => {
  it('offers only extensions that can register', () => {
    const rows = [row('8000', READY), row('8001', NO_SECRET), row('8002', NOT_LOADED)];
    assert.deepEqual(
      readiness.connectable(rows).map((r) => r.extension_id),
      ['8000'],
    );
  });

  it('offers an extension nobody has judged', () => {
    // Absent readiness means no reader ran, which is not the same as unusable:
    // dropping it would remove a working phone from the list with no reason.
    const rows = [row('8000', undefined), row('8001', READY)];
    assert.deepEqual(
      readiness.connectable(rows).map((r) => r.extension_id),
      ['8000', '8001'],
    );
    assert.deepEqual(readiness.notConnectable(rows), []);
  });

  it('names what it withholds, and why', () => {
    // A list that merely omits an extension reads as "it was never created".
    const blocked = readiness.notConnectable([row('8000', READY), row('4132643964', NO_SECRET)]);
    assert.equal(blocked.length, 1);
    assert.equal(blocked[0].extension.extension_id, '4132643964');
    assert.equal(blocked[0].reason, 'No SIP secret');
  });

  it('leaves nothing out between the two halves', () => {
    const rows = [row('8000', READY), row('8001', NO_SECRET), row('8002', undefined)];
    const offered = readiness.connectable(rows).map((r) => r.extension_id);
    const withheld = readiness.notConnectable(rows).map((r) => r.extension.extension_id);
    assert.deepEqual([...offered, ...withheld].sort(), rows.map((r) => r.extension_id).sort());
  });
});
