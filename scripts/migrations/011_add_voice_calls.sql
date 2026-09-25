-- One row per call, one id across products (P4 of docs/voice-convergence.md).
--
-- `call_id` is Asterisk's `UNIQUEID` — the same value the dialplan stamps as
-- `AI_CALL_ID` and `AI_CONTEXT_TOKEN`. That is the whole point: an operator
-- asking "what happened on this call?" gets one row, whichever product answered,
-- and the row's `handoffs` column names the path the call took (AVA → Capstone →
-- operator) rather than leaving it to be reconstructed from three logs.
--
-- Written by the *switch*, not by either agent: `src/lib/ami-handler.ts` fills it
-- from the channel's own events (the dialplan's `Set()` calls arrive as AMI
-- `VarSet`, a hand-off arrives as `Newexten` in Capstone's context). Neither
-- product has to instrument itself for the record to exist, which is also why
-- the row appears even for a call no agent ever picked up.
--
-- `account_id` is nullable and `ON DELETE SET NULL` rather than CASCADE: a call
-- for a DID that names no account is still a call (the router's fallback), and
-- deleting an account must not delete the estate's record of the calls it made.
CREATE TABLE IF NOT EXISTS voice_calls (
  call_id TEXT PRIMARY KEY,
  account_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  did TEXT,
  agent_slug TEXT,
  capstone_binding TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT,
  -- in_progress | handed_off | returned | concluded. The path, not the outcome:
  -- a call that was handed to Capstone and then ended is `handed_off` with an
  -- `ended_at`, because the hand-off is the fact worth keeping.
  disposition TEXT NOT NULL DEFAULT 'in_progress',
  -- JSON array of hand-off events, oldest first:
  -- [{"to": "capstone", "at": "2026-09-23T12:00:00Z"}, …]
  handoffs TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The operator view reads by account or by recency.
CREATE INDEX IF NOT EXISTS idx_voice_calls_account ON voice_calls (account_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_voice_calls_started ON voice_calls (started_at DESC);
