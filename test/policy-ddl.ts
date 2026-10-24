// The DDL drizzle-kit generates for the /policy tables, as the test database
// uses it.
export const createPolicySql = [
  'CREATE TABLE IF NOT EXISTS subscriptions (id TEXT NOT NULL, kind TEXT NOT NULL, plan TEXT NOT NULL, status TEXT NOT NULL, seats INTEGER DEFAULT 1 NOT NULL, period_end INTEGER, trial_ends_at INTEGER, cancel_at INTEGER, credits INTEGER DEFAULT 0 NOT NULL, provider TEXT, provider_subscription_id TEXT, updated_at INTEGER NOT NULL, org_id TEXT NOT NULL, PRIMARY KEY (org_id, id))',
  'CREATE INDEX IF NOT EXISTS subscriptions_org_id_idx ON subscriptions (org_id)',
  'CREATE TABLE IF NOT EXISTS entitlement_overrides (id TEXT NOT NULL, value TEXT NOT NULL, reason TEXT NOT NULL, expires_at INTEGER, admin_id TEXT NOT NULL, created_at INTEGER NOT NULL, org_id TEXT NOT NULL, PRIMARY KEY (org_id, id))',
  'CREATE INDEX IF NOT EXISTS entitlement_overrides_org_id_idx ON entitlement_overrides (org_id)',
]
