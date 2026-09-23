/**
 * The entitlement audit trail: written whole, and read without inventing an
 * answer.
 *
 * `src/lib/addon-cache.ts` is the only writer of `account_addons`, the table the
 * call path reads (`src/lib/voice-context.ts`) and the plan route refreshes.
 * Three properties can fail silently and none of them is visible to a typecheck:
 *
 *  1. **The batch is all-or-nothing.** The routing plan is published whole, so
 *     the trail behind it must be written whole: a loop that upserts row by row
 *     leaves a partial record under a complete plan after a failure. The test
 *     forces a real failure (a row for a user that does not exist — the table
 *     has a foreign key and `db.ts` enables it) and asserts the *earlier* rows in
 *     the same batch were not written either.
 *
 *  2. **`null` is not `false`.** "Nothing has ever been asked" and "asked, and
 *     refused" lead to the same routing decision (fail closed) but are different
 *     operator facts, and one of them is what a reader must not fabricate.
 *
 *  3. **Re-recording updates in place.** The table is keyed `(user_id, addon)`,
 *     so a second answer must not accumulate rows — otherwise the "last
 *     decision" a reader gets is whichever row SQLite happens to return.
 *
 * The database half runs against the project's real `scripts/schema.sql` and
 * migrations in a throwaway working directory (the portal's `db.ts` reads them
 * from `process.cwd()`), so the constraints under test are the ones that ship.
 */
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { REPO, load, transpile } from "./ts-probe.mjs";

let cache;
let db;
let cwd;

before(async () => {
  const gen = transpile(["src/lib/db.ts", "src/lib/addon-cache.ts"]);
  cache = await load(gen, "addon-cache");
  ({ default: db } = await load(gen, "db"));

  cwd = mkdtempSync(join(tmpdir(), "zeus-addon-cache-"));
  mkdirSync(join(cwd, "scripts"));
  mkdirSync(join(cwd, "data"));
  cpSync(join(REPO, "scripts", "schema.sql"), join(cwd, "scripts", "schema.sql"));
  cpSync(join(REPO, "scripts", "migrations"), join(cwd, "scripts", "migrations"), {
    recursive: true,
  });

  const repo = process.cwd();
  process.chdir(cwd);
  process.on("exit", () => process.chdir(repo));

  db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)").run(
    "u1",
    "one@example.com",
    "One",
    "x",
  );
  db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)").run(
    "u2",
    "two@example.com",
    "Two",
    "x",
  );
});

after(() => {
  if (cwd) rmSync(cwd, { recursive: true, force: true });
});

const rows = () => db.prepare("SELECT user_id, addon, entitled FROM account_addons").all();

describe("cachedAddonDecision", () => {
  it("is null — not false — for an account nothing has ever been recorded for", () => {
    assert.equal(cache.cachedAddonDecision("u1", "capstone"), null);
  });

  it("reports a recorded refusal as false, which is a different thing", () => {
    cache.recordAddonDecision("u1", "capstone", false);
    assert.equal(cache.cachedAddonDecision("u1", "capstone"), false);
  });
});

describe("recordAddonDecision", () => {
  it("records a true answer and updates it in place rather than accumulating", () => {
    cache.recordAddonDecision("u1", "capstone", true);
    assert.equal(cache.cachedAddonDecision("u1", "capstone"), true);

    // A second answer replaces the first: the table is keyed per (user, SKU),
    // so "the last decision" has exactly one row to be.
    cache.recordAddonDecision("u1", "capstone", false);
    assert.equal(cache.cachedAddonDecision("u1", "capstone"), false);
    assert.equal(rows().filter((r) => r.user_id === "u1").length, 1);
  });

  it("keeps the two SKUs apart", () => {
    cache.recordAddonDecision("u2", "agents", true);
    assert.equal(cache.cachedAddonDecision("u2", "agents"), true);
    assert.equal(cache.cachedAddonDecision("u2", "capstone"), null);
  });
});

describe("recordAddonDecisions", () => {
  it("writes every row of a batch", () => {
    cache.recordAddonDecisions([
      { userId: "u1", sku: "agents", entitled: true },
      { userId: "u2", sku: "capstone", entitled: true },
    ]);
    assert.equal(cache.cachedAddonDecision("u1", "agents"), true);
    assert.equal(cache.cachedAddonDecision("u2", "capstone"), true);
  });

  it("writes none of them when one row cannot be written", () => {
    // A real failure, not a mocked one: `account_addons.user_id` is a foreign
    // key into `users` and `db.ts` turns enforcement on, so a record for an
    // account that does not exist aborts the transaction.
    // The first row is a *change* (u1/agents is true from the test above), so a
    // partial write is visible rather than hidden behind an upsert that would
    // not have moved the row count either way.
    assert.equal(cache.cachedAddonDecision("u1", "agents"), true);
    assert.throws(() =>
      cache.recordAddonDecisions([
        { userId: "u1", sku: "agents", entitled: false },
        { userId: "ghost", sku: "agents", entitled: true },
      ]),
    );

    // The first row of that batch was already written when the second failed —
    // unless the batch really was one transaction.
    assert.equal(cache.cachedAddonDecision("u1", "agents"), true);
    assert.equal(cache.cachedAddonDecision("ghost", "agents"), null);
  });

  it("is a no-op for an empty plan, not an empty transaction", () => {
    const before = rows().length;
    cache.recordAddonDecisions([]);
    assert.equal(rows().length, before);
  });
});
