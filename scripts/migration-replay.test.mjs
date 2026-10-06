/**
 * Every migration has to be safe to replay — not only the one that cleans
 * `voice_calls`.
 *
 * `src/lib/db.ts` is the migration runner, and it keeps no record of what has
 * already run: every boot reads `scripts/schema.sql` and then every
 * `scripts/migrations/*.sql` in name order and `exec`s each one, swallowing any
 * error as "already applied". The portal restarts far more often than the schema
 * changes, so each of those files runs again and again against a live database.
 *
 * `013_dedupe_voice_call_handoffs.sql` has its own probe
 * (`migration-idempotency.test.mjs`) because losing its `WHERE` guard is
 * invisible — it rewrites stored paths rather than failing. That is the general
 * hazard: an unguarded `UPDATE`, an `INSERT` without `ON CONFLICT`, a `DELETE`
 * that is not scoped to `WHERE NOT EXISTS` all leave the app serving while the
 * rows are quietly rewritten or duplicated on every restart, and the migration
 * that does it gets no closer look than any other.
 *
 * So this probe starts the *real* runner repeatedly against one throwaway
 * database and pins the two claims that make the whole set safe:
 *
 *   1. Once the database is migrated, a later startup changes nothing at all —
 *      every table's schema and every row, in order.
 *   2. Replaying any single migration file against that migrated database
 *      leaves it exactly as it was — whether the statement is applied (the
 *      `IF NOT EXISTS` and guarded files) or refused (the plain
 *      `ALTER TABLE … ADD COLUMN` files, which the runner is built to catch).
 *
 * A startup is a fresh load of `db.ts`: the module holds one connection for the
 * life of the process and replays the migrations when that connection opens, so
 * importing a fresh module instance — the same module under a new cache key — is
 * the restart as far as this file is concerned, and it turns the runner loose
 * again on the same data.
 */
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { pathToFileURL } from "node:url";

import { REPO, transpile } from "./ts-probe.mjs";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const SCRIPTS = join(REPO, "scripts");
const MIGRATIONS = join(SCRIPTS, "migrations");

// A little of every shape a migration might touch, so a replay that rewrites or
// duplicates rows has something to rewrite. Deliberately the pre-migration
// database: what `schema.sql` alone leaves behind, plus rows the data migrations
// (002/004/006 on `users`, 001 on `freepbx_extensions`, 003/012 on `faxes`, 007
// on `voicemails`, 013 on `voice_calls`) can act on.
const SEED_SQL = `
INSERT INTO users (id, email, name, password_hash, plan, plan_status, country, created_at, updated_at)
  VALUES ('u1', 'tenant@example.test', 'Tenant', '!oidc', 'business', 'active', 'US',
          '2026-01-01 00:00:00', '2026-01-01 00:00:00');

INSERT INTO freepbx_extensions (id, user_id, extension_id, extension_name, extension_secret,
                                voicemail_enabled, voicemail_pin, status, created_at, updated_at)
  VALUES ('e1', 'u1', '4135550001', 'Tenant Phone', 'DD@l1lama', 1, '0001', 'active',
          '2026-01-01 00:00:00', '2026-01-01 00:00:00');

INSERT INTO voicemails (id, user_id, extension_id, caller_id, duration_seconds, transcript, created_at)
  VALUES ('vm1', 'u1', '4135550001', '4135559999', 12, 'hello', '2026-01-01 00:00:00');

INSERT INTO faxes (id, user_id, direction, status, to_number, created_at)
  VALUES ('f1', 'u1', 'outbound', 'pending', '4135558888', '2026-01-01 00:00:00');

-- The shape 013 folds: a run of the same leg is one leg.
INSERT INTO voice_calls (call_id, account_id, did, agent_slug, started_at, handoffs, updated_at)
  VALUES ('1758500000.repeats', 'u1', '4135550000', 'ava', '2026-01-01 00:00:00',
          '[{"to":"ava","at":"t1"},{"to":"ava","at":"t2"},{"to":"capstone","at":"t3"}]',
          '2026-01-01 00:00:00');

-- And one with nothing to fold, which a guarded 013 must not touch.
INSERT INTO voice_calls (call_id, account_id, did, started_at, handoffs, updated_at)
  VALUES ('1758500000.settled', 'u1', '4135550000', '2026-01-01 00:00:00',
          '[{"to":"capstone","at":"t1"}]', '2026-01-01 00:00:00');
`;

/**
 * The whole database as one comparable string: schema and every row.
 *
 * `sqlite_master` is the schema (tables, indexes, their `CREATE` text), and each
 * table is read as stored — a plain table scan returns rows in rowid order, so
 * "unchanged" means the same rows in the same places, not merely the same set.
 * That is the stricter claim, and the one a rewrite-on-every-boot has to fail.
 */
function snapshot(db) {
  const master = db
    .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name")
    .all();
  const tables = master
    .filter((row) => row.type === "table" && !row.name.startsWith("sqlite_"))
    .map((row) => row.name);
  const rows = {};
  for (const table of tables) {
    rows[table] = db.prepare(`SELECT * FROM "${table}"`).all();
  }
  return JSON.stringify({ master, rows }, null, 2);
}

let cwd;
let repo;
let dbUrl;
let bootSeq = 0;
let unmigrated;
let firstBoot;
let secondBoot;
let thirdBoot;

/** Start the runner afresh, let it replay every migration, and read the whole file. */
async function startup() {
  const { default: db } = await import(`${dbUrl}?boot=${bootSeq++}`);
  // Touching the proxy opens the file, which is what runs the schema and every
  // migration — exactly as the first query after a restart does.
  db.prepare("SELECT COUNT(*) AS c FROM users").get();
  const state = snapshot(db);
  db.close();
  return state;
}

before(async () => {
  cwd = mkdtempSync(join(tmpdir(), "zeus-migration-replay-"));
  mkdirSync(join(cwd, "scripts"), { recursive: true });
  cpSync(join(SCRIPTS, "schema.sql"), join(cwd, "scripts", "schema.sql"));
  cpSync(MIGRATIONS, join(cwd, "scripts", "migrations"), { recursive: true });
  mkdirSync(join(cwd, "data"), { recursive: true });

  // The database a *fresh install* leaves behind: what `schema.sql` alone
  // creates, plus rows for the migrations to act on. The runner then applies
  // every migration on top — the upgrade path, which has to converge.
  const seed = new Database(join(cwd, "data", "pbx.db"));
  seed.exec(readFileSync(join(SCRIPTS, "schema.sql"), "utf8"));
  seed.exec(SEED_SQL);
  seed.close();

  // Read before the runner has ever seen the file, so the first startup's effect
  // can be told from "it did nothing".
  const pre = new Database(join(cwd, "data", "pbx.db"), { readonly: true });
  unmigrated = snapshot(pre);
  pre.close();

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

describe("the whole migration set across repeated startups", () => {
  it("applies the migrations the first startup finds", () => {
    assert.notEqual(
      firstBoot,
      unmigrated,
      "the runner left the database untouched — the migrations did not run",
    );
    // 005 both creates a table and writes rows, so it is the one migration whose
    // first run is visible in the data and whose replay could duplicate it.
    const plans = JSON.parse(firstBoot).rows.plans;
    assert.deepEqual(
      plans.map((plan) => plan.id).sort(),
      ["business", "consumer"],
    );
  });

  it("changes nothing on the second startup, or the third", async () => {
    // The claim under test: a later restart replays every migration, and a set
    // that is safe to replay has nothing left to do — every table's schema and
    // every row, in order.
    secondBoot = await startup();
    thirdBoot = await startup();

    assert.equal(secondBoot, firstBoot);
    assert.equal(thirdBoot, secondBoot);
  });
});

describe("replaying any single migration against a migrated database", () => {
  // Read from disk rather than listed, so a migration added later is judged
  // without this file being edited.
  const files = readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  it("has migrations to judge", () => {
    assert.ok(files.length > 0, `${MIGRATIONS} holds no .sql migration`);
  });

  for (const file of files) {
    it(`${file} leaves the database as it was`, () => {
      const sql = readFileSync(join(MIGRATIONS, file), "utf8");
      const scratch = mkdtempSync(join(tmpdir(), "zeus-migration-replay-one-"));
      try {
        // Replay against a private copy, so one file's effects cannot colour the
        // next one's judgement.
        const copy = join(scratch, "pbx.db");
        cpSync(join(cwd, "data", "pbx.db"), copy);
        const db = new Database(copy);
        try {
          const before = snapshot(db);
          try {
            db.exec(sql);
          } catch {
            // The expected shape for `ALTER TABLE … ADD COLUMN` on an
            // already-migrated file: the column is there, SQLite refuses, and
            // `db.ts` swallows it. A refusal must leave the file as it was too.
          }
          assert.equal(
            snapshot(db),
            before,
            `${file} changed the database when it was replayed`,
          );
        } finally {
          db.close();
        }
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    });
  }
});
