// The DDL drizzle-kit generates for /tenancy's org_claims (P1-10d), as the
// test database uses it.
export const createClaimsSql = [
  'CREATE TABLE IF NOT EXISTS org_claims (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, slug TEXT NOT NULL, email TEXT NOT NULL, admin_id TEXT NOT NULL, token_hash TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, accepted_at INTEGER, org_id TEXT, canceled_at INTEGER)',
  'CREATE UNIQUE INDEX IF NOT EXISTS org_claims_open_email ON org_claims (email) WHERE "org_claims"."accepted_at" IS NULL AND "org_claims"."canceled_at" IS NULL',
  'CREATE UNIQUE INDEX IF NOT EXISTS org_claims_token_hash ON org_claims (token_hash)',
]
