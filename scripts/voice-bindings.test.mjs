/**
 * Per-DID Capstone bindings: the rule the target is held to, and the SQL it is
 * stored by.
 *
 * `src/lib/voice-bindings.ts` is the write path for `voice_bindings`, the table
 * that says which interview workflow each of an account's numbers reaches. Two
 * things can go wrong silently here, and a typecheck sees neither:
 *
 *  1. **The rule widens.** The stored target is interpolated into
 *     `DIALPLAN_EXISTS(dograh-inbound,${ZEUS_CAPSTONE_TARGET},1)`, so a value
 *     containing `)` or `}` can close that call and inject the rest. The
 *     charset used to be mirrored by the renderer that wrote the plan
 *     (`pbx/ava_routing.py`, retired with the AVA engine) and this file ran the
 *     same candidates through both sides. With the renderer gone,
 *     `src/lib/dialplan-values.ts` is the only definition, so the test below
 *     pins its verdicts one candidate at a time — a `{1,64}` that became
 *     `{1,}` still has to fail it.
 *
 *  2. **The row is stored in a form nothing reads.** The plan lookup keys
 *     bindings on `phone_numbers.did` as stored, so the write path resolves the
 *     account's own number rather than trusting what a form sent. A second
 *     check is that what the API accepted is what comes back out of the table.
 *
 * The database half runs against the project's real `scripts/schema.sql` and
 * migrations, in a throwaway working directory (the portal's `db.ts` reads them
 * from `process.cwd()`), so the join and the upsert are the ones that ship.
 */
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { REPO, load, transpile } from "./ts-probe.mjs";

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

describe("the Capstone target rule", () => {
  // Every candidate is a way of closing `DIALPLAN_EXISTS(...)` early or of
  // naming something the dialplan cannot look up; the accepted ones are the
  // workflow extensions the provider actually hands out.
  const verdicts = [
    ["8005", true],
    ["a", true],
    ["A", true],
    ["0", true],
    ["workflow-1", true],
    ["a.b_c:d", true],
    ["x".repeat(64), true],
    ["", false],
    [" ", false],
    ["8005)", false],
    ["(", false],
    ["${X}", false],
    ["$[1]", false],
    ["#comment", false],
    [";x", false],
    ["a b", false],
    ["a/b", false],
    ["x".repeat(65), false],
    ["café", false],
    ["8005\n8006", false],
    ["8005,1", false],
    ["*", false],
    ["%{X}", false],
  ];

  it("accepts exactly the workflow targets and refuses the rest", () => {
    for (const [value, accepted] of verdicts) {
      assert.equal(
        values.isSafeCapstoneTarget(value),
        accepted,
        `${JSON.stringify(value)} should ${accepted ? "" : "not "}be a target`,
      );
    }
  });

  it("is the same charset the refusal message quotes", () => {
    // `/api/voice/agent-mapping` refuses with "must be [A-Za-z0-9_.:-], max 64".
    // A second copy of the rule here would be a second definition, so this
    // asserts the one definition against the promise made to the operator.
    assert.deepEqual(values.CAPSTONE_TARGET_RE.source, "^[A-Za-z0-9_.:-]{1,64}$");
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

  it("stores a target the API accepts, and reads it back verbatim", () => {
    bindings.setBinding("u1", "7745057135", "8005");
    const stored = bindings.accountLines("u1")[0].capstone_binding;

    // What the PUT route let through is what the plan lookup will read: no
    // normalisation on the way in, and none on the way out.
    assert.equal(stored, "8005");
    assert.ok(values.isSafeCapstoneTarget(stored));
  });
});
