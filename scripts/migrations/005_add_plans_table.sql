CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  stripe_price_id TEXT,
  amount INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'usd',
  "interval" TEXT NOT NULL DEFAULT 'month',
  max_numbers INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Seed default plans (idempotent)
INSERT INTO plans (id, name, amount, max_numbers) VALUES ('consumer', 'Consumer', 1999, 1)
  ON CONFLICT(id) DO NOTHING;
INSERT INTO plans (id, name, amount, max_numbers) VALUES ('business', 'Business', 4999, 5)
  ON CONFLICT(id) DO NOTHING;
