-- Per-account AVA voice agent: which agent answers this account's calls, and
-- any audio/provider override. Read by pbx/ava_routing.py (via --db) and by
-- the portal's Voice screen; written only through the portal API.
CREATE TABLE IF NOT EXISTS voice_agents (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  agent_slug TEXT NOT NULL,
  audio_profile TEXT,
  provider TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Last entitlement decision the portal observed for an account's voice
-- add-ons. This is a CACHE of a Magnate decision, not the authority: the
-- routing renderer treats a missing row as NOT entitled (fail closed), so a
-- stale cache can only ever be behind, never ahead of billing.
CREATE TABLE IF NOT EXISTS account_addons (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  addon TEXT NOT NULL,
  entitled INTEGER NOT NULL DEFAULT 0,
  checked_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, addon)
);
