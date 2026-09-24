/**
 * The portal's provisioning preflight: the judgement, and that it is the *same*
 * judgement the PBX-side tool makes.
 *
 * `POST /api/phone/extensions` was the one remaining second writer of PBX
 * objects (D6): it created an extension through FreePBX's API without asking
 * whether the number was safe to create over. It now consults
 * `src/lib/extension-preflight.ts`, a Node mirror of
 * `pbx/provision_extension.py`'s judgement, because the portal image has no
 * Python and no docker socket but does have the same three authorities the tool
 * reads (FreePBX's API, Asterisk's AMI, the mounted `/etc/asterisk`).
 *
 * Two things can go wrong silently, and neither is visible to a typecheck:
 *
 *   1. **The refusal drifts.** The *whole* advance of the tool over the old
 *      failure is a named reason and a repair line — `(1,'maxchans')` was
 *      unactionable. A mirror that refuses for a *different* reason, or the same
 *      reason worded differently, is a second opinion about a live switch. So
 *      the observed states below are run through both implementations and the
 *      verdict, reason and repair are compared exactly.
 *
 *   2. **The config scan drifts.** The two-owner endpoint check is a parser, and
 *      the portal's copy (`src/lib/pjsip-owners.ts`) must draw the same line the
 *      tool does: same `(id, type)`, template inheritance followed, `[101]` in
 *      `pjsip.endpoint.conf`/`pjsip.auth.conf`/`pjsip.aor.conf` benign. The same
 *      fixtures go through both parsers and the conflicted ids are compared.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { REPO, load, transpile } from "./ts-probe.mjs";

/** Run a Python snippet with one JSON argument, from the pbx directory. */
function python(script, arg) {
  return execFileSync("python3", ["-c", script, arg], {
    cwd: join(REPO, "pbx"),
    encoding: "utf8",
  });
}

const hasPython = (() => {
  try {
    execFileSync("python3", ["-c", "import sys"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

let preflight;
let owners;
const dirs = [];

before(async () => {
  const gen = transpile(["src/lib/extension-preflight.ts", "src/lib/pjsip-owners.ts"]);
  preflight = await load(gen, "extension-preflight");
  owners = await load(gen, "pjsip-owners");
});

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** The observed states every property below is asserted against. */
const EXTENSION = "101";
const CASES = [
  {
    label: "the PBX's Core module is not usable",
    observed: { modules_ok: false, modules_note: "" },
  },
  {
    label: "a distinctive module note is carried through",
    observed: { modules_ok: false, modules_note: "core is disabled" },
  },
  { label: "a complete extension exists", observed: { users: [EXTENSION], devices: [EXTENSION] } },
  { label: "a user object without a device", observed: { users: [EXTENSION] } },
  { label: "a device without a user object", observed: { devices: [EXTENSION] } },
  { label: "a two-owner PJSIP endpoint", observed: { endpoint_two_owner: [EXTENSION] } },
  { label: "an orphaned pjsip row", observed: { pjsip_ids: [EXTENSION] } },
  { label: "orphaned sip and pjsip rows", observed: { sip_ids: [EXTENSION], pjsip_ids: [EXTENSION] } },
  { label: "leftover AMPUSER state", observed: { astdb: [EXTENSION] } },
  { label: "a clean number", observed: {} },
  // Precedence: the most damaging state wins, as it does in the tool.
  {
    label: "a two-owner endpoint beside a half-created extension",
    observed: { users: [EXTENSION], endpoint_two_owner: [EXTENSION] },
  },
  {
    label: "orphan rows beside leftover state",
    observed: { pjsip_ids: [EXTENSION], astdb: [EXTENSION] },
  },
  // Other numbers must not leak into this one's verdict.
  { label: "another extension's problems are ignored", observed: { astdb: ["999"], pjsip_ids: ["999"] } },
];

function observedFor(observed) {
  return preflight.observedFromJson({
    users: [],
    devices: [],
    sip_ids: [],
    pjsip_ids: [],
    astdb: [],
    endpoint_two_owner: [],
    modules_ok: true,
    modules_note: "",
    ...observed,
  });
}

describe("the judgement", () => {
  it("names each state, and refuses rather than creating over it", () => {
    const expected = {
      "a complete extension exists": "in-sync",
      "a clean number": "create",
      "another extension's problems are ignored": "create",
    };
    for (const { label, observed } of CASES) {
      const verdict = preflight.judgeExtension({ extension: EXTENSION, name: "Ada" }, observedFor(observed));
      const wanted = expected[label] ?? "refuse";
      assert.equal(verdict.state, wanted, `${label}: expected ${wanted}, got ${verdict.state}`);
      if (wanted === "refuse") {
        assert.ok(verdict.reason.length > 0, `${label}: a refusal must carry its reason`);
        assert.ok(verdict.repair.length > 0, `${label}: a refusal must carry its repair`);
      }
    }
  });

  it("carries the repair that clears each refusal", () => {
    const repairs = Object.fromEntries(
      CASES.map(({ label, observed }) => [
        label,
        preflight.judgeExtension({ extension: EXTENSION, name: "Ada" }, observedFor(observed)).repair,
      ]),
    );
    assert.match(repairs["leftover AMPUSER state"], /database deltree AMPUSER 101/);
    assert.match(repairs["a two-owner PJSIP endpoint"], /pjsip_owner_check\.py --live --extension 101/);
    assert.match(repairs["an orphaned pjsip row"], /\(1,'maxchans'\)/);
    assert.match(repairs["a user object without a device"], /Applications → Extensions/);
    assert.match(repairs["the PBX's Core module is not usable"], /fwconsole ma enable core/);
  });
});

describe("parity with pbx/provision_extension.py", () => {
  it("agrees on verdict, reason and repair for every observed state", { skip: !hasPython }, () => {
    const ts = CASES.map(({ observed }) => {
      const verdict = preflight.judgeExtension({ extension: EXTENSION, name: "Ada" }, observedFor(observed));
      return { state: verdict.state, reason: verdict.reason, repair: verdict.repair };
    });

    const py = JSON.parse(
      python(
        [
          "import json, sys",
          "import provision_extension as p",
          "cases = json.loads(sys.argv[1])",
          "out = []",
          "for c in cases:",
          "    o = p.Observed(",
          "        users=frozenset(c.get('users', [])), devices=frozenset(c.get('devices', [])),",
          "        sip_ids=frozenset(c.get('sip_ids', [])), pjsip_ids=frozenset(c.get('pjsip_ids', [])),",
          "        astdb=frozenset(c.get('astdb', [])),",
          "        endpoint_two_owner=frozenset(c.get('endpoint_two_owner', [])),",
          "        modules_ok=c.get('modules_ok', True), modules_note=c.get('modules_note', ''),",
          "    )",
          "    rep = p.judge([p.Intent(extension=c['extension'], name='Ada')], o)",
          "    if rep.in_sync: out.append({'state': 'in-sync', 'reason': '', 'repair': ''})",
          "    elif rep.create: out.append({'state': 'create', 'reason': '', 'repair': ''})",
          "    else:",
          "        r = rep.refused[0]",
          "        out.append({'state': 'refuse', 'reason': r.reason, 'repair': r.repair})",
          "print(json.dumps(out))",
        ].join("\n"),
        JSON.stringify(CASES.map(({ observed }) => ({ extension: EXTENSION, ...observed }))),
      ),
    );

    assert.deepEqual(ts, py);
    // Guard against a case list that agrees because everything is 'create'.
    assert.equal(py.some((entry) => entry.state === "refuse"), true);
    assert.equal(py.some((entry) => entry.state === "create"), true);
  });

  it("agrees on which AstDB keys name an extension", { skip: !hasPython }, () => {
    const sample = [
      "/AMPUSER/1001/callwaiting : enabled",
      "/AMPUSER/1001/device : 1001",
      "/AMPUSER/1002/cfb : 5551234",
      "/AMPUSER/ : family value",
      "/DEVICE/1001/default_user : 1001",
      "garbage",
      "",
    ].join("\n");

    const ts = [...preflight.parseAstdb(sample)].sort();
    const py = JSON.parse(
      python(
        [
          "import json, sys",
          "import provision_extension as p",
          "print(json.dumps(sorted(p.parse_astdb(sys.argv[1]))))",
        ].join("\n"),
        sample,
      ),
    );
    assert.deepEqual(ts, py);
    assert.deepEqual(ts, ["1001", "1002"]);
  });
});

describe("endpoint ownership parity with pbx/pjsip_owner_check.py", () => {
  const GENERATED = "; Do NOT edit this file as it is auto-generated by FreePBX.\n";
  const FIXTURES = [
    {
      label: "one endpoint id across the generated files is benign",
      files: {
        "pjsip.endpoint.conf": `${GENERATED}[101]\ntype = endpoint\n`,
        "pjsip.auth.conf": `${GENERATED}[101]\ntype = auth\n`,
        "pjsip.aor.conf": `${GENERATED}[101]\ntype = aor\n`,
      },
      expected: [],
    },
    {
      label: "the same id as an endpoint in two files is a duplicate",
      files: {
        "pjsip.endpoint.conf": `${GENERATED}[101]\ntype = endpoint\n`,
        "pjsip_ext_101.conf": "[101]\ntype = endpoint\n",
      },
      expected: ["101"],
    },
    {
      label: "the portal's templated endpoint beside FreePBX's is a duplicate",
      files: {
        "pjsip.endpoint.conf": `${GENERATED}[101]\ntype = endpoint\n`,
        "pjsip_custom_post.conf": "[webrtc-template](!)\ntype = endpoint\n\n[101](webrtc-template)\nauth = 101\n",
      },
      expected: ["101"],
    },
    {
      label: "a section whose base template is missing is untyped, not an endpoint",
      files: {
        "pjsip.endpoint.conf": `${GENERATED}[101]\ntype = endpoint\n`,
        "pjsip_ext_101.conf": "[101](gone-template)\n",
      },
      expected: [],
    },
  ];

  it("makes the same duplicate call as the PBX-side parser", { skip: !hasPython }, () => {
    for (const { label, files, expected } of FIXTURES) {
      const dir = mkdtempSync(join(tmpdir(), "pjsip-owners-"));
      dirs.push(dir);
      for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);

      const ts = [...owners.endpointTwoOwner(dir)].sort();
      const py = JSON.parse(
        python(
          [
            "import json, sys",
            "import pjsip_owner_check as o",
            "files = o.load_files(json.loads(sys.argv[1]))",
            "defs = o.definitions(files)",
            "print(json.dumps(sorted({i for (i, k), p in defs.items() if k == 'endpoint' and len(p) > 1})))",
          ].join("\n"),
          JSON.stringify(files),
        ),
      );

      assert.deepEqual(ts, py, `${label}: the two parsers disagree`);
      assert.deepEqual(ts, expected, `${label}: expected ${expected.join(",")}`);
    }
  });
});
