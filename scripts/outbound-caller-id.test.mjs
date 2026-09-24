/**
 * Outbound caller ID: the syntax rule, and the ownership rule.
 *
 * `src/lib/outbound-caller-id.ts` decides what the originate route is allowed to
 * ask Asterisk to present. Two things can go wrong silently here:
 *
 *  1. **Syntax drifts.** A caller sends a formatted, country-coded number; the
 *     stored DID is a bare 10-digit string, and a comparison that does not
 *     normalize both sides rejects valid input. The pure `resolveOwnedCallerId`
 *     tests pin the accepted spellings.
 *
 *  2. **Ownership is not enforced.** The interesting case is not a number that
 *     belongs to nobody — it is a number that belongs to *someone else*, which a
 *     naive "does this DID exist?" check would happily allow. That answer comes
 *     from the database, so the ownership tests run the same
 *     `resolveCallerIdForUser` the route calls against the project's real
 *     `scripts/schema.sql` and migrations, in a throwaway working directory (the
 *     portal's `db.ts` reads them from `process.cwd()`).
 */
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { REPO, load, transpile } from "./ts-probe.mjs";

let callerId;
let db;
let cwd;

before(async () => {
  const gen = transpile(["src/lib/db.ts", "src/lib/outbound-caller-id.ts"]);
  callerId = await load(gen, "outbound-caller-id");
  ({ default: db } = await load(gen, "db"));

  cwd = mkdtempSync(join(tmpdir(), "zeus-caller-id-"));
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
  // u1 holds two active numbers and one suspended one; u2's number is the
  // "someone else's DID" case the ownership rule exists for.
  for (const [id, user, did, status] of [
    ["n1", "u1", "7745057135", "active"],
    ["n2", "u1", "7745057136", "active"],
    ["n3", "u1", "7745057137", "suspended"],
    ["n4", "u2", "8605551234", "active"],
  ]) {
    db.prepare("INSERT INTO phone_numbers (id, user_id, did, status) VALUES (?, ?, ?, ?)").run(
      id,
      user,
      did,
      status,
    );
  }
});

after(() => {
  if (cwd) rmSync(cwd, { recursive: true, force: true });
});

describe("resolveOwnedCallerId", () => {
  const dids = ["7745057135", "4132643964"];

  it("leaves caller ID selection to the outbound route when omitted", () => {
    assert.equal(callerId.resolveOwnedCallerId(undefined, dids), undefined);
  });

  it("accepts an active account DID in national, +1, or 1-prefixed form", () => {
    assert.equal(callerId.resolveOwnedCallerId("7745057135", dids), "7745057135");
    assert.equal(callerId.resolveOwnedCallerId("+1 (774) 505-7135", dids), "7745057135");
    assert.equal(callerId.resolveOwnedCallerId("14132643964", dids), "4132643964");
  });

  it("rejects a number not owned by the account", () => {
    assert.equal(callerId.resolveOwnedCallerId("4134210134", dids), null);
  });

  it("rejects malformed, non-US, and too-short caller IDs", () => {
    assert.equal(callerId.resolveOwnedCallerId("sip:7745057135", dids), null);
    assert.equal(callerId.resolveOwnedCallerId("+44 20 1234 5678", dids), null);
    assert.equal(callerId.resolveOwnedCallerId("7135", dids), null);
  });
});

describe("resolveCallerIdForUser (the route's own check)", () => {
  it("resolves an active DID the account owns, in any accepted spelling", () => {
    assert.equal(callerId.resolveCallerIdForUser("u1", "7745057135"), "7745057135");
    assert.equal(callerId.resolveCallerIdForUser("u1", "+1 (774) 505-7136"), "7745057136");
  });

  it("refuses a caller ID owned by a different account", () => {
    // u2 holds 8605551234. It exists, it is active — it is just not u1's, which
    // is exactly the case a "does this DID exist?" check would let through.
    assert.equal(callerId.resolveCallerIdForUser("u1", "8605551234"), null);
    assert.equal(callerId.resolveCallerIdForUser("u1", "+1 (860) 555-1234"), null);
    // And the reverse: u2 cannot present u1's number either.
    assert.equal(callerId.resolveCallerIdForUser("u2", "7745057135"), null);
  });

  it("refuses the account's own number while it is suspended", () => {
    assert.equal(callerId.resolveCallerIdForUser("u1", "7745057137"), null);
  });

  it("leaves the choice to the route when no caller ID is supplied", () => {
    assert.equal(callerId.resolveCallerIdForUser("u1", undefined), undefined);
  });
});
