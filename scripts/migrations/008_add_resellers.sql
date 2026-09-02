-- Reseller/white-label management: each reseller can serve the portal under
-- its own domain with its own brand name. Users who sign in through a
-- reseller domain get linked (users.reseller_id) and see the reseller brand.
CREATE TABLE IF NOT EXISTS resellers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  brand_name TEXT,
  domain TEXT,
  plan_status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);