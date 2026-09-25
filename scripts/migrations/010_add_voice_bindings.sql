-- Per-DID Capstone binding: WHICH interview workflow an account's line reaches.
-- Written and read by the portal (see src/lib/voice-bindings.ts); the dialplan
-- interpolates it as ZEUS_CAPSTONE_TARGET, which [dograh-inbound] looks up in
-- the engine's own workflow list.
--
-- Deliberately separate from account_addons: that table says whether the
-- account bought Capstone (a Magnate decision, cached), this says which
-- workflow answers it (the customer's own choice, not billing's). The write
-- path only ever stores the binding beside a true entitlement, so a row left
-- behind by a cancelled subscription is inert rather than a way back in.
CREATE TABLE IF NOT EXISTS voice_bindings (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  did TEXT NOT NULL,
  capstone_binding TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, did)
);
