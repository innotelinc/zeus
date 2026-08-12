import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import bcrypt from "bcryptjs";
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

// ── Seed demo user ──
const userId = randomUUID();
// Documented demo password (printed at the bottom).
const DEMO_PASSWORD = "8dpWR8wl4eYncm5v";
// Hash generated at runtime so it can never drift from DEMO_PASSWORD.
const passwordHash = bcrypt.hashSync(DEMO_PASSWORD, 10);

const existing = db.prepare("SELECT id, password_hash FROM users WHERE email = ?").get("demo@innotel.us");
if (existing) {
  // Self-healing: if the stored hash doesn't match the documented password,
  // repair it. This fixes any drift (manual edits, older seeds with a bad
  // hash, or the legacy broken $2a$ hash) without hardcoding a specific
  // broken value.
  if (bcrypt.compareSync(DEMO_PASSWORD, existing.password_hash)) {
    console.log("✅ Demo user exists with correct password. Skipping seed.");
    db.close();
    process.exit(0);
  }
  db.prepare("UPDATE users SET password_hash = ? WHERE email = ?").run(passwordHash, "demo@innotel.us");
  console.log("🔧 Repaired demo password hash to the documented password. Login now works.");
  db.close();
  process.exit(0);
}

db.prepare(
  "INSERT INTO users (id, email, name, password_hash, phone, plan) VALUES (?, ?, ?, ?, ?, ?)"
).run(userId, "demo@innotel.us", "Demo User", passwordHash, "+1 555 100 2000", "business");

// ── Seed demo phone numbers ──
const numId1 = randomUUID();
const numId2 = randomUUID();
db.prepare(
  "INSERT INTO phone_numbers (id, user_id, did, area_code, location, sms_enabled, fax_enabled, status) VALUES (?, ?, ?, ?, ?, 1, 1, 'active')"
).run(numId1, userId, "13025551001", "302", "Wilmington, DE");
db.prepare(
  "INSERT INTO phone_numbers (id, user_id, did, area_code, location, sms_enabled, fax_enabled, status) VALUES (?, ?, ?, ?, ?, 1, 0, 'active')"
).run(numId2, userId, "13025551002", "302", "Wilmington, DE");

// ── Seed demo extension ──
db.prepare(
  "INSERT INTO freepbx_extensions (id, user_id, extension_id, extension_name, extension_secret, voicemail_enabled, voicemail_pin, status) VALUES (?, ?, ?, ?, ?, 1, ?, 'active')"
).run(randomUUID(), userId, "1001", "Demo Extension", "accbacb7495dfd426d5607a7aa42c17b", "1234");

// ── Seed demo contacts ──
db.prepare(
  "INSERT INTO contacts (id, user_id, name, phone, email) VALUES (?, ?, ?, ?, ?)"
).run(randomUUID(), userId, "Alice Johnson", "+1 555 300 4000", "alice@example.com");
db.prepare(
  "INSERT INTO contacts (id, user_id, name, phone, email) VALUES (?, ?, ?, ?, ?)"
).run(randomUUID(), userId, "Bob Smith", "+1 555 700 8000", "bob@acmecorp.com");
db.prepare(
  "INSERT INTO contacts (id, user_id, name, phone, email, notes) VALUES (?, ?, ?, ?, ?, ?)"
).run(randomUUID(), userId, "Carol Williams", "+1 555 900 0000", "carol@example.com", "Client since 2024");
db.prepare(
  "INSERT INTO contacts (id, user_id, name, phone) VALUES (?, ?, ?, ?)"
).run(randomUUID(), userId, "Dave Martinez", "+1 555 500 6000");

// ── Seed demo SMS conversation ──
const convId = randomUUID();
db.prepare(
  "INSERT INTO sms_conversations (id, user_id, phone_number_id, contact_phone, contact_name, last_message_text, last_message_at, unread_count) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), 1)"
).run(convId, userId, numId1, "+1 555 300 4000", "Alice Johnson", "Hey, are you available for a call tomorrow?");

db.prepare(
  "INSERT INTO sms_messages (id, conversation_id, user_id, direction, from_number, to_number, body, status) VALUES (?, ?, ?, 'inbound', ?, ?, ?, 'delivered')"
).run(randomUUID(), convId, userId, "+1 555 300 4000", "13025551001", "Hey, are you available for a call tomorrow?");

db.prepare(
  "INSERT INTO sms_messages (id, conversation_id, user_id, direction, from_number, to_number, body, status) VALUES (?, ?, ?, 'outbound', ?, ?, ?, 'delivered')"
).run(randomUUID(), convId, userId, "13025551001", "+1 555 300 4000", "Sure! How about 2pm?");

// ── Seed demo fax ──
db.prepare(
  "INSERT INTO faxes (id, user_id, direction, status, to_number, pages, subject, created_at, completed_at) VALUES (?, ?, 'outbound', 'completed', ?, 2, ?, datetime('now', '-2 days'), datetime('now', '-2 days'))"
).run(randomUUID(), userId, "+1 555 500 6000", "Invoice #2024-001");

// ── Seed demo voicemail ──
db.prepare(
  "INSERT INTO voicemails (id, user_id, extension_id, caller_id, caller_name, duration_seconds, transcript, listened, created_at) VALUES (?, ?, '1001', '+1 555 700 8000', 'Bob Smith', 42, 'Hi, this is Bob from Acme Corp. Please call me back at your earliest convenience regarding the proposal.', 0, datetime('now', '-1 hour'))"
).run(randomUUID(), userId);

// ── Seed demo call history ──
db.prepare(
  "INSERT INTO call_history (id, user_id, extension_id, direction, caller_number, callee_number, caller_name, duration_seconds, status, created_at) VALUES (?, ?, '1001', 'inbound', '+1 555 700 8000', '1001', 'Bob Smith', 180, 'completed', datetime('now', '-1 hour'))"
).run(randomUUID(), userId);
db.prepare(
  "INSERT INTO call_history (id, user_id, extension_id, direction, caller_number, callee_number, duration_seconds, status, created_at) VALUES (?, ?, '1001', 'outbound', '1001', '+1 555 900 0000', 45, 'completed', datetime('now', '-3 hours'))"
).run(randomUUID(), userId);

console.log("✅ Seed complete!");
console.log("   Email:    demo@innotel.us");
console.log("   Password: 8dpWR8wl4eYncm5v");
console.log("   Plan:     Business");
console.log("   Numbers:  13025551001, 13025551002");
console.log("   Ext:      1001");

db.close();
