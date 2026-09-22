CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  phone TEXT,
  plan TEXT NOT NULL DEFAULT 'consumer',
  plan_status TEXT NOT NULL DEFAULT 'active',
  country TEXT DEFAULT 'US',
  stripe_subscription_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- stripe_subscription_id added via migration 002 for existing databases

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS phone_numbers (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  did TEXT NOT NULL UNIQUE,
  area_code TEXT,
  location TEXT,
  server TEXT,
  sms_enabled INTEGER NOT NULL DEFAULT 1,
  fax_enabled INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS freepbx_extensions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  extension_id TEXT NOT NULL,
  extension_name TEXT,
  extension_secret TEXT,
  voicemail_enabled INTEGER NOT NULL DEFAULT 1,
  voicemail_pin TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sms_conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  phone_number_id TEXT REFERENCES phone_numbers(id) ON DELETE SET NULL,
  contact_phone TEXT NOT NULL,
  contact_name TEXT,
  last_message_text TEXT,
  last_message_at TEXT,
  unread_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sms_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES sms_conversations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  from_number TEXT NOT NULL,
  to_number TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'delivered',
  segments INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, phone)
);

CREATE TABLE IF NOT EXISTS fax_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  avantfax_user_id TEXT,
  avantfax_username TEXT,
  email TEXT,
  did TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS faxes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fax_account_id TEXT REFERENCES fax_accounts(id) ON DELETE SET NULL,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  status TEXT NOT NULL DEFAULT 'pending',
  from_number TEXT,
  to_number TEXT NOT NULL,
  pages INTEGER NOT NULL DEFAULT 1,
  file_path TEXT,
  file_type TEXT DEFAULT 'pdf',
  subject TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  scheduled_at TEXT
);

CREATE TABLE IF NOT EXISTS voicemails (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  extension_id TEXT,
  caller_id TEXT,
  caller_name TEXT,
  duration_seconds INTEGER NOT NULL DEFAULT 0,
  transcript TEXT,
  listened INTEGER NOT NULL DEFAULT 0,
  file_path TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS call_history (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  extension_id TEXT,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound', 'internal')),
  caller_number TEXT NOT NULL,
  callee_number TEXT NOT NULL,
  caller_name TEXT,
  duration_seconds INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'completed',
  recording_path TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS billing_invoices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invoice_number TEXT NOT NULL UNIQUE,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  amount_due REAL NOT NULL DEFAULT 0,
  amount_paid REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  stripe_invoice_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  paid_at TEXT
);

-- Per-account AVA voice agent: which agent answers this account's calls, plus
-- any audio/provider override. Read by pbx/ava_routing.py (--db) and the
-- portal's Voice screen; written only through the portal API.
CREATE TABLE IF NOT EXISTS voice_agents (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  agent_slug TEXT NOT NULL,
  audio_profile TEXT,
  provider TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- WHICH Capstone workflow this account's interview line reaches. The add-on
-- flag says an account bought Capstone; this says which interview it is, and
-- it is what pbx/ava_routing.py renders as ZEUS_CAPSTONE_TARGET. Per DID
-- rather than per account because one account may hold several numbers with
-- different jobs (a support line and an interview line). A row here without a
-- capstone_addons entitlement is inert: the renderer writes the target only
-- beside the entitlement, so a lapsed subscription cannot keep naming a
-- workflow.
CREATE TABLE IF NOT EXISTS voice_bindings (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  did TEXT NOT NULL,
  capstone_binding TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, did)
);

-- Last entitlement decision the portal observed for an account's voice
-- add-ons. A CACHE of a Magnate decision, not the authority: the routing
-- renderer treats a missing row as NOT entitled (fail closed), so this cache
-- can only ever be behind billing, never ahead of it.
CREATE TABLE IF NOT EXISTS account_addons (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  addon TEXT NOT NULL,
  entitled INTEGER NOT NULL DEFAULT 0,
  checked_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, addon)
);
