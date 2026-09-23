/**
 * Per-DID Capstone bindings: the mirrored rule, and the SQL it is stored by.
 *
 * `src/lib/voice-bindings.ts` is the write path for `voice_bindings`, the table
 * that says which interview workflow each of an account's numbers reaches. Two
 * things can go wrong silently here, and a typecheck sees neither:
 *
 *  1. **The rule drifts.** The stored target is interpolated into
 *     `DIALPLAN_EXISTS(dograh-inbound,${ZEUS_CAPSTONE_TARGET},1)`, and the
 *     renderer (`pbx/ava_routing.py`) refuses anything outside
 *     `^[A-Za-z0-9_.:-]{1,64}$`, aborting the whole plan — which leaves the PBX
 *     on its last good fragment. `src/lib/dialplan-values.ts` mirrors that
 *     charset, and the first test here runs the same candidates through both
 *     sides and compares. A comment claiming parity is not parity.
 *
 *  2. **The row is stored in a form nothing reads.** `pbx/ava_routing.py` keys
 *     bindings on `phone_numbers.did` as stored, so the write path resolves the
 *     account's own number rather than trusting what a form sent. A second
 *     check is that a stored value survives `render(validate(...))` — the
 *     renderer's own code, not just its regex.
 *
 * The database half runs against the project's real `scripts/schema.sql` and
 * migrations, in a throwaway working directory (the portal's `db.ts` reads them
 * from `process.cwd()`), so the join and the upsert are the ones that ship.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { REPO, load, transpile } from "./ts-probe.mjs";

/** The renderer, run as its own process — it is Python, and it is the authority. */
function python(script, arg) {
  return execFileSync("python3", ["-c", script, arg], { cwd: join(REPO, "pbx"), encoding: "utf8" });
}

const hasPython = (() => {
  try {
    execFileSync("python3", ["-c", "import sys"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

let values;
let bindings;
let db;
let cwd;

before(async () => {
  const gen = transpile([
    "src/lib/db.ts",
    "src/lib/dialplan-values.ts",
    "src/lib/voice-bindings.ts",
  ]);
  bindings = await load(gen, "voice-bindings");
  values = await load(gen, "dialplan-values");
  ({ default: db } = await load(gen, "db"));

  cwd = mkdtempSync(join(tmpdir(), "zeus-bindings-"));
  mkdirSync(join(cwd, "scripts"));
  mkdirSync(join(cwd, "data"));
  cpSync(join(REPO, "scripts", "schema.sql"), join(cwd, "scripts", "schema.sql"));
  cpSync(join(REPO, "scripts", "migrations"), join(cwd, "scripts", "migrations"), { recursive: true });

  const repo = process.cwd();
  process.chdir(cwd);
  process.on("exit", () => process.chdir(repo));

  db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)").run(
    "u1", "one@example.com", "One", "x",
  );
  db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)").run(
    "u2", "two@example.com", "Two", "x",
  );
  // u1 holds two active numbers and one suspended one; u2's number is the
  // "someone else's DID" case.
  for (const [id, user, did, status] of [
    ["n1", "u1", "7745057135", "active"],
    ["n2", "u1", "7745057136", "active"],
    ["n3", "u1", "7745057137", "suspended"],
    ["n4", "u2", "8605551234", "active"],
  ]) {
    db.prepare("INSERT INTO phone_numbers (id, user_id, did, status) VALUES (?, ?, ?, ?)").run(
      id, user, did, status,
    );
  }
});

after(() => {
  if (cwd) rmSync(cwd, { recursive: true, force: true });
});

describe("the mirrored Capstone target rule", () => {
  const candidates = [
    "8005", "a", "A", "0", "workflow-1", "a.b_c:d", "x".repeat(64),
    "", " ", "8005)", "(", "${X}", "$[1]", "#comment", ";x", "a b", "a/b",
    "x".repeat(65), "café", "8005\n8006", "8005,1", "*", "%{X}",
  ];

  it("is exactly the renderer's SAFE_TOKEN_RE", { skip: !hasPython }, () => {
    const tsVerdicts = Object.fromEntries(candidates.map((v) => [v, values.isSafeCapstoneTarget(v)]));
    const pyVerdicts = JSON.parse(
      python(
        [
          "import json, sys",
          "import ava_routing as r",
          "print(json.dumps({c: bool(r.SAFE_TOKEN_RE.match(c)) for c in json.loads(sys.argv[1])}))",
        ].join("\n"),
        JSON.stringify(candidates),
      ),
    );

    assert.deepEqual(tsVerdicts, pyVerdicts);
    // Guard against a candidate list that agrees because everything passes.
    assert.equal(pyVerdicts["8005"], true);
    assert.equal(pyVerdicts[""], false);
    assert.equal(pyVerdicts["8005)"], false);
  });
});

describe("accountLines", () => {
  it("returns only this account's active numbers, ordered", () => {
    assert.deepEqual(bindings.accountLines("u1").map((line) => line.did), [
      "7745057135",
      "7745057136",
    ]);
  });

  it("starts with no binding on any line", () => {
    assert.deepEqual(bindings.accountLines("u1").map((line) => line.capstone_binding), [null, null]);
  });
});

describe("resolveOwnedDid", () => {
  it("resolves the stored form from a punctuated, country-coded number", () => {
    assert.equal(bindings.resolveOwnedDid("u1", "7745057135"), "7745057135");
    assert.equal(bindings.resolveOwnedDid("u1", "+1 (774) 505-7135"), "7745057135");
  });

  it("refuses another account's number, an unknown one, a suspended one, and junk", () => {
    assert.equal(bindings.resolveOwnedDid("u1", "8605551234"), null);
    assert.equal(bindings.resolveOwnedDid("u1", "19995550000"), null);
    assert.equal(bindings.resolveOwnedDid("u1", "7745057137"), null);
    assert.equal(bindings.resolveOwnedDid("u1", "not a number"), null);
  });
});

describe("setBinding", () => {
  it("binds one line only, and updates in place", () => {
    bindings.setBinding("u1", "7745057135", "8005");
    assert.deepEqual(bindings.accountLines("u1").map((line) => line.capstone_binding), ["8005", null]);
    assert.equal(bindings.accountLines("u2")[0].capstone_binding, null);

    bindings.setBinding("u1", "7745057135", "8006");
    assert.equal(bindings.accountLines("u1")[0].capstone_binding, "8006");
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM voice_bindings").get().c, 1);
  });

  it("clears by deleting the row, so 'no row' and 'no target' stay one thing", () => {
    bindings.setBinding("u1", "7745057135", null);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM voice_bindings").get().c, 0);
    assert.equal(bindings.accountLines("u1")[0].capstone_binding, null);
  });

  it("stores a value the renderer accepts and emits", { skip: !hasPython }, () => {
    bindings.setBinding("u1", "7745057135", "8005");
    const stored = bindings.accountLines("u1")[0].capstone_binding;

    const rendered = python(
      [
        "import json, sys",
        "import ava_routing as r",
        "plan = json.loads(sys.argv[1])",
        "print(r.render(r.validate(plan)))",
      ].join("\n"),
      JSON.stringify({
        accounts: [
          { did: "7745057135", account: "u1", capstone_addon: true, capstone_target: stored },
        ],
      }),
    );

    assert.match(rendered, /Set\(ZEUS_CAPSTONE_TARGET=8005\)/);
  });
});
