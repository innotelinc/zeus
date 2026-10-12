/**
 * Assigning a number to an account that bought one.
 *
 * `src/lib/phone-provisioning.ts` is what runs when a purchase webhook fires, so
 * everything it can get wrong it gets wrong silently and on someone else's
 * money: an allocation that hands out a line the PBX trunk routes, a retry that
 * allocates a *second* number, a pool read that fails and is answered as though
 * the customer had been given one. Each is pinned here.
 *
 * The database half runs against the project's real `scripts/schema.sql` and
 * migrations in a throwaway working directory (the portal's `db.ts` reads them
 * from `process.cwd()`), and the provider half is injected — nothing in this
 * file can order, enable or touch a real line. Each case names its own pool, so
 * no case depends on what an earlier one allocated.
 */
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { REPO, load, transpile } from "./ts-probe.mjs";

let provisioning;
let db;
let cwd;

/** A line on the VoIP.ms account, as `getDIDsInfo` reports one. */
const did = (number, extra = {}) => ({
  did: number,
  description: "SPRINGFLD, MA",
  sms_available: "1",
  ...extra,
});

/** The provider half, with a pool this case owns. */
const deps = (pool, overrides = {}) => ({
  listOwned: async () => ({ dids: pool }),
  enableSms: async () => {},
  ...overrides,
});

before(async () => {
  const gen = transpile([
    "src/lib/db.ts",
    "src/lib/voipms.ts",
    "src/lib/dialplan-values.ts",
    "src/lib/phone-provisioning.ts",
  ]);
  provisioning = await load(gen, "phone-provisioning");
  ({ default: db } = await load(gen, "db"));

  cwd = mkdtempSync(join(tmpdir(), "zeus-provision-"));
  mkdirSync(join(cwd, "scripts"));
  mkdirSync(join(cwd, "data"));
  cpSync(join(REPO, "scripts", "schema.sql"), join(cwd, "scripts", "schema.sql"));
  cpSync(join(REPO, "scripts", "migrations"), join(cwd, "scripts", "migrations"), {
    recursive: true,
  });

  const repo = process.cwd();
  process.chdir(cwd);
  process.on("exit", () => process.chdir(repo));

  // An account that is already a customer, holding the one line a consumer plan
  // allows — the ledger the pool rules read.
  db.prepare(
    "INSERT INTO users (id, email, name, password_hash, plan) VALUES (?, ?, ?, ?, ?)",
  ).run("u-existing", "already@example.com", "Already", "!oidc", "consumer");
  db.prepare(
    "INSERT INTO phone_numbers (id, user_id, did, status) VALUES (?, ?, ?, 'active')",
  ).run("n-existing", "u-existing", "4132955890");
});

after(() => {
  delete process.env.VOIPMS_DIDS;
  delete process.env.CLOUDONIX_DIDS;
  delete process.env.ZEUS_PROVISION_AREA_CODE;
  if (cwd) rmSync(cwd, { recursive: true, force: true });
});

describe("the plan allowance", () => {
  it("is the one the manual order path already enforced", () => {
    assert.equal(provisioning.maxNumbersForPlan("consumer"), 1);
    assert.equal(provisioning.maxNumbersForPlan("business"), 5);
    assert.equal(provisioning.maxNumbersForPlan(null), 1);
    assert.equal(provisioning.maxNumbersForPlan(undefined), 1);
  });
});

describe("reading a DID's area code", () => {
  it("takes the NANP code out of 10- and 11-digit numbers, punctuation and all", () => {
    assert.equal(provisioning.areaCodeOf("14132642700"), "413");
    assert.equal(provisioning.areaCodeOf("4132642700"), "413");
    assert.equal(provisioning.areaCodeOf("+1 (413) 264-2700"), "413");
  });

  it("is null for anything that is not a NANP number", () => {
    assert.equal(provisioning.areaCodeOf(""), null);
    assert.equal(provisioning.areaCodeOf("12345"), null);
    assert.equal(provisioning.areaCodeOf("not a number"), null);
  });
});

describe("the trunk's reserved lines", () => {
  it("reads the did:target pairs the trunk setup writes", () => {
    process.env.VOIPMS_DIDS = "4132643964:8000,4132642700:8001";
    process.env.CLOUDONIX_DIDS = "7745057135:8002";
    const reserved = provisioning.reservedDids();
    assert.ok(reserved.has("4132643964"));
    assert.ok(reserved.has("4132642700"));
    assert.ok(reserved.has("7745057135"));
    assert.equal(reserved.has("4132951200"), false);
  });

  it("counts a bare DID with no target, and is empty when unset", () => {
    process.env.VOIPMS_DIDS = "4132643964";
    delete process.env.CLOUDONIX_DIDS;
    assert.ok(provisioning.reservedDids().has("4132643964"));

    delete process.env.VOIPMS_DIDS;
    assert.equal(provisioning.reservedDids().size, 0);
  });
});

describe("picking a line from the pool", () => {
  const pool = [did("4132642700"), did("4132951200"), did("7745057135")];

  it("takes the first line nobody holds", () => {
    const picked = provisioning.selectOwnedDid(pool, {
      taken: new Set(),
      reserved: new Set(),
    });
    assert.equal(picked.did, "4132642700");
  });

  it("skips a line the trunk routes, and one another account holds", () => {
    const picked = provisioning.selectOwnedDid(pool, {
      taken: new Set(["4132642700"]),
      reserved: new Set(["4132951200"]),
    });
    assert.equal(picked.did, "7745057135");
  });

  it("prefers the requested area code but does not require it", () => {
    const preferred = provisioning.selectOwnedDid(pool, {
      taken: new Set(),
      reserved: new Set(),
      areaCode: "774",
    });
    assert.equal(preferred.did, "7745057135");

    // Nothing in 998 — a customer waiting on a 998 line still gets a number.
    const fallback = provisioning.selectOwnedDid(pool, {
      taken: new Set(),
      reserved: new Set(),
      areaCode: "998",
    });
    assert.equal(fallback.did, "4132642700");
  });

  it("returns nothing when every line is spoken for", () => {
    const picked = provisioning.selectOwnedDid(pool, {
      taken: new Set(pool.map((line) => line.did)),
      reserved: new Set(),
    });
    assert.equal(picked, null);
  });
});

describe("provisionNumber", () => {
  it("creates the account and assigns the first free line", async () => {
    const result = await provisioning.provisionNumber(
      { email: "Buyer@Example.com", name: "Ada Lovelace" },
      // 4132955890 first, because the existing customer holds it: the pool is
      // read in provider order and the first line nobody holds is the one to
      // take.
      deps([did("4132955890"), did("4132642700"), did("4132951200"), did("7745057135")]),
    );

    assert.equal(result.ok, true);
    assert.equal(result.email, "buyer@example.com");
    assert.equal(result.did, "4132642700");
    assert.equal(result.area_code, "413");
    assert.equal(result.location, "SPRINGFLD, MA");
    assert.equal(result.account_created, true);
    assert.equal(result.number_assigned, true);
    assert.equal(result.sms_enabled, true);

    const row = db
      .prepare("SELECT * FROM phone_numbers WHERE did = ?")
      .get("4132642700");
    assert.equal(row.user_id, result.user_id);
    assert.equal(row.status, "active");
    // The buyer has never signed in: the identity is Authentik's, so the local
    // password stays the inert marker an SSO sign-in writes.
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(result.user_id);
    assert.equal(user.password_hash, "!oidc");
    assert.equal(user.name, "Ada Lovelace");
  });

  it("defaults the name to the address when the caller sends none", async () => {
    const result = await provisioning.provisionNumber(
      { email: "noname@example.com" },
      deps([did("4132642701")]),
    );
    const user = db.prepare("SELECT name FROM users WHERE id = ?").get(result.user_id);
    assert.equal(user.name, "noname");
  });

  it("is idempotent: a retried webhook returns the number, not a second one", async () => {
    // The pool offers a second line, so a naive implementation would hand out
    // 4132642703 on the retry and the customer would be billed for one number
    // while holding two.
    const pool = deps([did("4132642702"), did("4132642703")]);
    const first = await provisioning.provisionNumber({ email: "retry@example.com" }, pool);
    const again = await provisioning.provisionNumber({ email: "retry@example.com" }, pool);

    assert.equal(again.ok, true);
    assert.equal(again.did, first.did);
    assert.equal(again.number_assigned, false);
    assert.equal(again.account_created, false);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS c FROM phone_numbers WHERE user_id = ?")
        .get(first.user_id).c,
      1,
    );
  });

  it("returns the line an existing account already holds", async () => {
    const result = await provisioning.provisionNumber(
      { email: "already@example.com" },
      deps([did("4132642704")]),
    );
    assert.equal(result.ok, true);
    assert.equal(result.did, "4132955890");
    assert.equal(result.number_assigned, false);
    assert.equal(result.account_created, false);
  });

  it("assigns the line the caller names", async () => {
    const result = await provisioning.provisionNumber(
      { email: "named@example.com", did: "7745057135" },
      deps([did("7745057135", { description: "FRAMINGHAM, MA", sms_available: "0" })]),
    );
    assert.equal(result.ok, true);
    assert.equal(result.did, "7745057135");
    assert.equal(result.area_code, "774");
    // 7745057135 reports sms_available=0, so nothing is claimed about SMS.
    assert.equal(result.sms_enabled, false);
  });

  it("matches a number written with a country code and punctuation", async () => {
    // `normalizeDid` is what the plan lookup and the bindings match on, so the
    // pool lookup has to agree: a caller who writes +1 (413) 264-2709 means the
    // line the account owns as 4132642709.
    const result = await provisioning.provisionNumber(
      { email: "punctuated@example.com", did: "+1 (413) 264-2709" },
      deps([did("4132642709")]),
    );
    assert.equal(result.ok, true);
    assert.equal(result.did, "4132642709");

    // And the trunk's reserved line is recognised in that spelling too, rather
    // than being refused as "not on the pool" — the operator's cue differs.
    process.env.VOIPMS_DIDS = "4132643964:8000";
    const reserved = await provisioning.provisionNumber(
      { email: "punctuated-2@example.com", did: "+1 413 264 3964" },
      deps([did("4132643964")]),
    );
    delete process.env.VOIPMS_DIDS;
    assert.equal(reserved.ok, false);
    assert.equal(reserved.status, 409);
    assert.match(reserved.error, /routed by the PBX trunk/);
  });

  it("refuses a line that is not on the account's pool", async () => {
    const result = await provisioning.provisionNumber(
      { email: "unknown-did@example.com", did: "3055551234" },
      deps([did("4132642706")]),
    );
    assert.equal(result.ok, false);
    assert.equal(result.status, 409);
    assert.match(result.error, /not on this account's VoIP.ms pool/);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS c FROM users WHERE email = ?")
        .get("unknown-did@example.com").c,
      0,
    );
  });

  it("refuses a line the PBX trunk routes, even when asked for by name", async () => {
    process.env.VOIPMS_DIDS = "4132643964:8000";
    const result = await provisioning.provisionNumber(
      { email: "trunk@example.com", did: "4132643964" },
      deps([did("4132643964", { routing: "account:235662_capstone" }), did("4132642707")]),
    );
    delete process.env.VOIPMS_DIDS;

    assert.equal(result.ok, false);
    assert.equal(result.status, 409);
    assert.match(result.error, /routed by the PBX trunk/);
  });

  it("refuses a line another account already holds", async () => {
    const result = await provisioning.provisionNumber(
      { email: "taken@example.com", did: "4132955890" },
      deps([did("4132955890"), did("4132642708")]),
    );
    assert.equal(result.ok, false);
    assert.equal(result.status, 409);
    assert.match(result.error, /already assigned/);
  });

  it("answers 503 — and leaves no account behind — when the pool is empty", async () => {
    // Every line on the account is one the existing customer already holds.
    const result = await provisioning.provisionNumber(
      { email: "waiting@example.com" },
      deps([did("4132955890")]),
    );

    assert.equal(result.ok, false);
    assert.equal(result.status, 503);
    assert.match(result.error, /No unassigned number/);
    // The purchase is not half-done: an account with no number would be a
    // customer who paid and found an empty dashboard.
    assert.equal(
      db.prepare("SELECT COUNT(*) AS c FROM users WHERE email = ?")
        .get("waiting@example.com").c,
      0,
    );
  });

  it("reports the provider as unreachable rather than as an empty pool", async () => {
    const result = await provisioning.provisionNumber(
      { email: "outage@example.com" },
      deps([did("4132642710")], {
        listOwned: async () => {
          throw new Error("VoIP.ms API error: 500 Internal Server Error");
        },
      }),
    );

    assert.equal(result.ok, false);
    assert.equal(result.status, 502);
    assert.match(result.error, /500 Internal Server Error/);
  });

  it("keeps the assigned number when SMS cannot be enabled", async () => {
    const result = await provisioning.provisionNumber(
      { email: "nosms@example.com" },
      deps([did("4132642711")], {
        enableSms: async () => {
          throw new Error("VoIP.ms enableSMS: invalid_did");
        },
      }),
    );

    assert.equal(result.ok, true);
    assert.equal(result.number_assigned, true);
    assert.equal(result.sms_enabled, false);
  });

  it("prefers the configured area code when the caller names none", async () => {
    process.env.ZEUS_PROVISION_AREA_CODE = "774";
    const result = await provisioning.provisionNumber(
      { email: "areacode@example.com" },
      deps([did("4132642712"), did("7745057136", { description: "FRAMINGHAM, MA" })]),
    );
    delete process.env.ZEUS_PROVISION_AREA_CODE;

    assert.equal(result.ok, true);
    assert.equal(result.did, "7745057136");
    assert.equal(result.area_code, "774");
  });

  it("rejects an empty address", async () => {
    const result = await provisioning.provisionNumber({ email: "   " }, deps([]));
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
  });
});
