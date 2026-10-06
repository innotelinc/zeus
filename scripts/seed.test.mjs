/**
 * A fresh database seeds the estate's own infrastructure, and nothing else.
 *
 * `scripts/seed.mjs` runs on a first boot (`docker-entrypoint.sh`) and by hand
 * (`npm run seed`), against `scripts/schema.sql` alone — before the app's
 * migrations run. It used to insert a demo dataset: a `demo@zeus.innotel.us`
 * account with a phone number, contacts, an SMS thread and a "demo extension"
 * that named a phone no PBX had. Every screen then started full of fixtures an
 * operator had to learn to ignore, and the health panel could only ever report
 * the phantom extension as unregistered.
 *
 * That dataset is gone, and this pins it. Two properties are worth asserting,
 * and both fail silently if a demo row is ever reintroduced:
 *
 *   1. **No demo account, in any spelling.** The seed must not create a user,
 *      and must not create the number/contact/conversation fixtures either —
 *      they all depend on a user, so a stray account is the canary.
 *   2. **The fax service lines are seeded, and they are not a demo.** `3291`–
 *      `3294` are the IAX2 fax modems the estate really runs; a first boot with
 *      no rows for them leaves the portal unable to manage the lines it runs.
 *
 * The seed is executed as its own process against a throwaway working directory
 * — the same way `docker-entrypoint.sh` runs it — so the probe exercises the
 * real entry point, not a re-imported copy of its logic.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { REPO } from "./ts-probe.mjs";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

let cwd;
let db;

before(() => {
  cwd = mkdtempSync(join(tmpdir(), "zeus-seed-"));
  // The seed reads `scripts/schema.sql` from `process.cwd()`; the app's own
  // `db.ts` also reads `scripts/migrations` the same way, so give the throwaway
  // root both. (The seed itself runs against the schema alone.)
  mkdirSync(join(cwd, "scripts"), { recursive: true });
  cpSync(join(REPO, "scripts", "schema.sql"), join(cwd, "scripts", "schema.sql"));
  cpSync(join(REPO, "scripts", "migrations"), join(cwd, "scripts", "migrations"), {
    recursive: true,
  });

  execFileSync(process.execPath, [join(REPO, "scripts", "seed.mjs")], {
    cwd,
    stdio: "pipe",
  });

  db = new Database(join(cwd, "data", "pbx.db"));
});

after(() => {
  try {
    db?.close();
  } catch {
    // Nothing to clean up if the file was never opened.
  }
  if (cwd) rmSync(cwd, { recursive: true, force: true });
});

describe("a fresh seed", () => {
  it("creates no demo account, in any spelling", () => {
    const demo = db
      .prepare(
        `SELECT id, email FROM users
          WHERE email LIKE '%demo%' OR LOWER(name) LIKE '%demo%'`,
      )
      .all();
    assert.deepEqual(demo, []);
    // The old fixture's exact address, in case the pattern above is ever
    // loosened: this one must never come back.
    assert.equal(
      db.prepare("SELECT COUNT(*) AS c FROM users WHERE email = 'demo@zeus.innotel.us'").get().c,
      0,
    );
  });

  it("leaves every fixture-bearing table empty", () => {
    // Only the fax owner's own rows would ever be legitimate, and the seed
    // writes none of these: a fresh estate has no numbers, contacts, SMS, faxes
    // or calls — only the fax lines it actually runs.
    const empty = ["phone_numbers", "contacts", "sms_conversations", "sms_messages", "faxes", "voicemails", "call_history"];
    for (const table of empty) {
      assert.equal(
        db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c,
        0,
        `${table} must be empty on a fresh seed`,
      );
    }
  });

  it("seeds exactly its own account, and it is not a password account", () => {
    const users = db.prepare("SELECT email, password_hash, plan, plan_status FROM users").all();
    assert.equal(users.length, 1);
    assert.equal(users[0].email, "denovo-credit-corporation@innotel.us");
    // The OIDC marker the app's login path recognises: there is no local
    // password to guess, which is the point.
    assert.equal(users[0].password_hash, "!oidc");
    assert.equal(users[0].plan, "business");
    assert.equal(users[0].plan_status, "active");
  });

  it("seeds the four fax service lines, owned by that account", () => {
    const owner = db
      .prepare("SELECT id FROM users WHERE email = 'denovo-credit-corporation@innotel.us'")
      .get();
    const lines = db
      .prepare(
        "SELECT extension_id, extension_name, user_id, extension_secret, voicemail_enabled FROM freepbx_extensions ORDER BY extension_id",
      )
      .all();
    assert.deepEqual(
      lines.map((line) => line.extension_id),
      ["3291", "3292", "3293", "3294"],
    );
    for (const line of lines) {
      assert.equal(line.user_id, owner.id, `${line.extension_id} belongs to the fax owner`);
      assert.equal(line.extension_secret, "329fax");
      assert.equal(line.voicemail_enabled, 0, "a fax modem has no mailbox");
    }
  });

  it("is idempotent: a second run adds no rows", () => {
    execFileSync(process.execPath, [join(REPO, "scripts", "seed.mjs")], {
      cwd,
      stdio: "pipe",
    });
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM users").get().c, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM freepbx_extensions").get().c, 4);
  });
});
