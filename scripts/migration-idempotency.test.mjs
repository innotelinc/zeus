/**
 * A restart must not keep rewriting the calls it already cleaned.
 *
 * `src/lib/db.ts` is the migration runner: on every boot — `docker-entrypoint`
 * starts the server, the first query opens the file — it reads
 * `scripts/schema.sql` and then every `scripts/migrations/*.sql` in name order
 * and `exec`s each one, with no record of what has already run. So a migration
 * is only safe if replaying it on an already-migrated database is a no-op, and
 * the portal restarts far more often than the schema changes.
 *
 * `013_dedupe_voice_call_handoffs.sql` folds runs of the same leg in
 * `voice_calls.handoffs`. It is meant to be guarded: its `WHERE` writes to a
 * row only while the stored path still holds a consecutive repeat, so the
 * second and every later boot finds nothing to do. That guard is doing real
 * work, and losing it is invisible — the app keeps serving, the old rows are
 * just rewritten on each boot, and any `handoffs` the rebuild does not fully
 * understand (not an array at all, or carrying a field it does not know) gets
 * mangled rather than skipped.
 *
 * So this probe starts up the *real* runner repeatedly against one throwaway
 * database and pins that:
 *
 *   1. The startup that first sees the legacy repeats folds them, once.
 *   2. Every later startup leaves every stored path byte-identical, including
 *      the shapes the migration has no business touching. Those are what fail
 *      if the `WHERE` guard is dropped.
 *
 * A startup is a fresh load of `db.ts`. The module holds one connection for the
 * life of the process and replays the migrations when that connection opens, so
 * importing a fresh module instance — the same module under a new cache key —
 * is the restart as far as this file is concerned, and it turns the runner
 * loose again on the same data.
 */
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { pathToFileURL } from "node:url";

import { REPO, transpile } from "./ts-probe.mjs";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

// A leg, as `noteHandoff` writes it — the two fields the migration rebuilds.
const leg = (to, at) => ({ to, at });

// The paths the database holds the moment 013 first runs against it. Only the
// first is the migration's business; the rest are the shapes it must leave
// exactly as it found them.
const SEEDED = [
  {
    call_id: "1758500000.repeats",
    // Four `Newexten` events for one move into Capstone, two for AVA, then a
    // return: the live shape, and the reason the migration exists.
    handoffs: JSON.stringify([
      leg("capstone", "t1"),
      leg("capstone", "t2"),
      leg("capstone", "t3"),
      leg("capstone", "t4"),
      leg("ava", "t5"),
      leg("ava", "t6"),
      leg("capstone", "t7"),
    ]),
  },
  {
    call_id: "1758500000.settled",
    // Already a leg list with no consecutive repeat: nothing to fold, so a
    // guarded migration never writes to it.
    handoffs: JSON.stringify([leg("capstone", "t1"), leg("ava", "t2")]),
  },
  {
    call_id: "1758500000.detailed",
    // A path with a field the rebuild does not carry. The guard is what keeps
    // that field: drop the `WHERE` and this row is slimmed to `to`/`at`.
    handoffs: JSON.stringify([{ to: "capstone", at: "t1", reason: "warm" }, leg("ava", "t2")]),
  },
  {
    call_id: "1758500000.broken",
    // Unreadable. `json_valid` is part of the guard, so this is never a row the
    // migration touches — it must not become `[]` or `[{"to":null,...}]`.
    handoffs: "not json",
  },
  {
    call_id: "1758500000.stray",
    // Valid JSON that is not a list of legs. Without the guard's length test
    // the rebuild turns this into `[{"to":null,"at":null}]`.
    handoffs: '{"stray":true}',
  },
];

let cwd;
let repo;
let dbUrl;
let bootSeq = 0;
let firstBoot;
let secondBoot;
let thirdBoot;

/** Start the runner afresh, let it replay every migration, and read the rows. */
async function startup() {
  const { default: db } = await import(`${dbUrl}?boot=${bootSeq++}`);
  // Touching the proxy opens the file, which is what runs the schema and every
  // migration — exactly as the first query after a restart does.
  db.prepare("SELECT COUNT(*) AS c FROM voice_calls").get();
  const rows = db
    .prepare("SELECT call_id, handoffs, updated_at FROM voice_calls ORDER BY call_id")
    .all();
  db.close();
  return rows;
}

before(async () => {
  cwd = mkdtempSync(join(tmpdir(), "zeus-startup-"));
  mkdirSync(join(cwd, "scripts"), { recursive: true });
  cpSync(join(REPO, "scripts", "schema.sql"), join(cwd, "scripts", "schema.sql"));
  cpSync(join(REPO, "scripts", "migrations"), join(cwd, "scripts", "migrations"), {
    recursive: true,
  });
  mkdirSync(join(cwd, "data"), { recursive: true });

  // A database from before this migration: base schema only, holding the paths
  // above. The runner reapplies `schema.sql` (all `IF NOT EXISTS`) and every
  // migration on top — the upgrade a restart performs.
  const seed = new Database(join(cwd, "data", "pbx.db"));
  seed.exec(readFileSync(join(REPO, "scripts", "schema.sql"), "utf8"));
  const insert = seed.prepare("INSERT INTO voice_calls (call_id, handoffs) VALUES (?, ?)");
  for (const row of SEEDED) insert.run(row.call_id, row.handoffs);
  seed.close();

  dbUrl = pathToFileURL(join(transpile(["src/lib/db.ts"]), "db.mjs")).href;

  // `db.ts` resolves `data/` and `scripts/` from the working directory, so the
  // runner has to run from the throwaway root.
  repo = process.cwd();
  process.chdir(cwd);
  process.on("exit", () => process.chdir(repo));

  firstBoot = await startup();
});

after(() => {
  if (cwd) rmSync(cwd, { recursive: true, force: true });
});

describe("the voice_calls migration across repeated startups", () => {
  it("folds the repeats the first startup finds into one leg per visit", () => {
    const row = firstBoot.find((r) => r.call_id === "1758500000.repeats");
    // A run of the same leg is one leg; leaving and returning is two visits.
    assert.deepEqual(
      JSON.parse(row.handoffs).map((h) => h.to),
      ["capstone", "ava", "capstone"],
    );
    // The keeper is the first entry of each run — the moment the call arrived,
    // not the last `Newexten` that restated it.
    assert.deepEqual(
      JSON.parse(row.handoffs).map((h) => h.at),
      ["t1", "t5", "t7"],
    );
  });

  it("leaves every shape that needed no change exactly as it was", () => {
    const byId = new Map(firstBoot.map((r) => [r.call_id, r.handoffs]));
    for (const row of SEEDED) {
      if (row.call_id === "1758500000.repeats") continue;
      assert.equal(byId.get(row.call_id), row.handoffs, `${row.call_id} must be untouched`);
    }
  });

  it("changes nothing on the second startup, or the third", async () => {
    // The claim under test: a restart replays 013, and a properly guarded 013
    // has nothing left to do — byte-for-byte, every column of every row.
    secondBoot = await startup();
    thirdBoot = await startup();

    assert.deepEqual(secondBoot, firstBoot);
    assert.deepEqual(thirdBoot, secondBoot);
    assert.equal(thirdBoot.length, SEEDED.length);
  });
});
