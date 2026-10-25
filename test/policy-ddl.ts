// The DDL drizzle-kit generates for the /policy tables (the starter's
// migrations 0000 to 0002), as the test database uses it.
export const createPolicySql = [
  'CREATE TABLE IF NOT EXISTS subscriptions (id TEXT NOT NULL, kind TEXT NOT NULL, plan TEXT NOT NULL, status TEXT NOT NULL, seats INTEGER DEFAULT 1 NOT NULL, period_end INTEGER, trial_ends_at INTEGER, cancel_at INTEGER, credits INTEGER DEFAULT 0 NOT NULL, provider TEXT, provider_subscription_id TEXT, updated_at INTEGER NOT NULL, org_id TEXT NOT NULL, PRIMARY KEY (org_id, id))',
  'CREATE INDEX IF NOT EXISTS subscriptions_org_id_idx ON subscriptions (org_id)',
  'CREATE TABLE IF NOT EXISTS entitlement_overrides (id TEXT NOT NULL, value TEXT NOT NULL, reason TEXT NOT NULL, expires_at INTEGER, admin_id TEXT NOT NULL, created_at INTEGER NOT NULL, org_id TEXT NOT NULL, PRIMARY KEY (org_id, id))',
  'CREATE INDEX IF NOT EXISTS entitlement_overrides_org_id_idx ON entitlement_overrides (org_id)',
  'CREATE TABLE IF NOT EXISTS plan_prices (id TEXT NOT NULL, plan_id TEXT NOT NULL, provider TEXT NOT NULL, provider_product_id TEXT NOT NULL, kind TEXT NOT NULL, period TEXT NOT NULL, amount INTEGER NOT NULL, currency TEXT NOT NULL, trial_days INTEGER, created_at INTEGER NOT NULL, archived_at INTEGER, PRIMARY KEY (provider, id), FOREIGN KEY (plan_id) REFERENCES plans(id) ON UPDATE no action ON DELETE no action)',
  'CREATE INDEX IF NOT EXISTS plan_prices_plan_id_idx ON plan_prices (plan_id)',
  'CREATE TABLE IF NOT EXISTS plans (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, entitlements TEXT NOT NULL, is_default INTEGER DEFAULT false NOT NULL, trial_days INTEGER, trial_requires_card INTEGER DEFAULT false NOT NULL, sort_order INTEGER DEFAULT 0 NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER)',
  'CREATE UNIQUE INDEX IF NOT EXISTS plans_one_default ON plans (is_default) WHERE "plans"."is_default" = 1 AND "plans"."archived_at" IS NULL',
]
