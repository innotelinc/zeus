import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const dataDir = join(process.cwd(), "data");
if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

const db = new Database(join(dataDir, "pbx.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

const schemaPath = join(process.cwd(), "scripts", "schema.sql");
const schema = readFileSync(schemaPath, "utf8");
db.exec(schema);

// ═══════════════════════════════════════════════════════════════════
// A fresh database seeds the estate's own infrastructure, and nothing else.
//
// There is deliberately **no demo dataset**: no demo user, number, contact, SMS
// conversation, fax, voicemail or call history. Those rows described nothing
// real, so every screen started out full of fixtures an operator had to learn
// to ignore. The "demo extension" was the worst of them — it named a phone no
// PBX had, so the health panel could only ever report it as "No contact".
//
// What *is* seeded is the fax service, and it is not a fixture: four HylaFAX
// virtual modems really run on this estate (`ttyIAX1`–`ttyIAX4`, started by
// docker-entrypoint-full.sh), and the rows below are how the portal manages
// them.
// ═══════════════════════════════════════════════════════════════════

// ── The account the fax lines belong to ───────────────────────────
// `freepbx_extensions.user_id` is a NOT NULL foreign key, so the lines need an
// owner, and in production they belong to this tenant — a fresh database
// matches. The account is written the way the portal's own OIDC path and
// `scripts/legacy_portal_merge.py` write one: `password_hash = '!oidc'` is the
// marker for "managed by Authentik", and the first SSO login binds to it by
// email. It is not a password account, so there is nothing to sign in with
// locally until one is registered or Authentik is configured.
const FAX_OWNER_EMAIL = "denovo-credit-corporation@innotel.us";
const FAX_OWNER_NAME = "Denovo Credit Corporation";

const existingOwner = db
  .prepare("SELECT id FROM users WHERE email = ?")
  .get(FAX_OWNER_EMAIL);
let ownerId = existingOwner?.id;
if (!ownerId) {
  ownerId = randomUUID();
  db.prepare(
    // Columns are the base schema's own: the seed runs against `schema.sql`,
    // before the app's migrations add `role` and the rest. Naming a column the
    // migrations own would make a first boot fail on its very first insert.
    "INSERT INTO users (id, email, name, password_hash, plan, plan_status, country, created_at, updated_at) VALUES (?, ?, ?, '!oidc', 'business', 'active', 'US', datetime('now'), datetime('now'))",
  ).run(ownerId, FAX_OWNER_EMAIL, FAX_OWNER_NAME);
}

// ── The fax service lines ─────────────────────────────────────────
// Two names are in play, and neither is a typo:
//
//   * `iaxmodem1`–`iaxmodem4` are the *Asterisk peers*. `/etc/iaxmodem/ttyIAX1`
//     sets `peername iaxmodem1`, so the bridge only comes up under that name —
//     renaming the peer breaks the modem, not the extension.
//   * `3291`–`3294` are the *extensions* the estate reaches those lines on. They
//     are IAX2, not PJSIP, so no phone ever registers against them — which is
//     why the health panel judges extensions by the PBX's own endpoint list
//     rather than assuming every row in this table is a phone.
//
// The secret is the modems' own (`secret 329fax` in `/etc/iaxmodem/ttyIAX<N>`
// and in `iax_fax_custom.conf`), so the portal and the PBX agree. No voicemail:
// a fax modem has no mailbox to leave one in.
const FAX_LINES = [
  ["3291", "Fax 1"],
  ["3292", "Fax 2"],
  ["3293", "Fax 3"],
  ["3294", "Fax 4"],
];

const insertFaxLine = db.prepare(
  "INSERT INTO freepbx_extensions (id, user_id, extension_id, extension_name, extension_secret, voicemail_enabled, voicemail_pin, status) VALUES (?, ?, ?, ?, '329fax', 0, NULL, 'active')",
);

let created = 0;
for (const [extensionId, extensionName] of FAX_LINES) {
  // Idempotent: the entrypoint runs this only on a first boot, but `npm run
  // seed` is a manual entry point too.
  const present = db
    .prepare("SELECT 1 FROM freepbx_extensions WHERE extension_id = ?")
    .get(extensionId);
  if (present) continue;
  insertFaxLine.run(randomUUID(), ownerId, extensionId, extensionName);
  created += 1;
}

console.log("✅ Seed complete — fax service lines only, no demo data.");
console.log(`   Fax lines: 3291, 3292, 3293, 3294 (${created} created)`);
console.log(`   Owner:     ${FAX_OWNER_EMAIL}`);

db.close();
