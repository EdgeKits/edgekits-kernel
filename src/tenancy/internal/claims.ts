import { and, desc, eq, gt, isNotNull, isNull, lte, sql } from 'drizzle-orm'
import {
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'
import type { AdminId, OrgId } from '../index.js'
import { ConflictError, type TenantDatabase } from './repository.js'

// Org claims (P1-10d, ruling 2026-11-02): an organization never exists
// without an owner, so an org an operator sets up for a person who has no
// account yet is a claim, which that person accepts on their first sign-in
// with the claim's token. Accepting creates the org (the starter, through
// its auth library) and records its id here.
//
// Not a tenant table: the org does not exist while the claim is open. No
// foreign keys: the claim stores an email and, once accepted, an org id,
// and references no table of the auth library. The plain token is never
// stored, only its SHA-256 (hex). Timestamps are epoch milliseconds. At most
// one open claim (neither accepted nor canceled) per email: the partial
// unique index below. An expired open claim gives way: createOrgClaim
// cancels it before writing a new one for that email.
export const orgClaims = sqliteTable(
  'org_claims',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    // Derived by the starter with the org slug rule; the kernel stores it.
    slug: text('slug').notNull(),
    // Lower case, trimmed.
    email: text('email').notNull(),
    adminId: text('admin_id').notNull(),
    // The operator's Access email, for admin.org_claim_accepted, which is
    // written when the person accepts, without an operator present.
    adminEmail: text('admin_email').notNull(),
    tokenHash: text('token_hash').notNull(),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    acceptedAt: integer('accepted_at'),
    orgId: text('org_id'),
    canceledAt: integer('canceled_at'),
  },
  (t) => [
    uniqueIndex('org_claims_open_email')
      .on(t.email)
      .where(sql`${t.acceptedAt} IS NULL AND ${t.canceledAt} IS NULL`),
    uniqueIndex('org_claims_token_hash').on(t.tokenHash),
  ],
)

export type OrgClaimStatus = 'open' | 'accepted' | 'canceled'

// A claim as the kernel hands it out: never the token or its hash.
export interface OrgClaimRecord {
  id: string
  name: string
  slug: string
  email: string
  adminId: AdminId
  adminEmail: string
  createdAt: number
  expiresAt: number
  acceptedAt: number | null
  orgId: OrgId | null
  canceledAt: number | null
}

const recordColumns = {
  id: orgClaims.id,
  name: orgClaims.name,
  slug: orgClaims.slug,
  email: orgClaims.email,
  adminId: orgClaims.adminId,
  adminEmail: orgClaims.adminEmail,
  createdAt: orgClaims.createdAt,
  expiresAt: orgClaims.expiresAt,
  acceptedAt: orgClaims.acceptedAt,
  orgId: orgClaims.orgId,
  canceledAt: orgClaims.canceledAt,
}

// A claim's status; an open claim past its expiresAt is still 'open' here
// until a new claim for its email cancels it (findOpenClaimByToken no
// longer finds it).
export const orgClaimStatus = (claim: OrgClaimRecord): OrgClaimStatus =>
  claim.acceptedAt !== null
    ? 'accepted'
    : claim.canceledAt !== null
      ? 'canceled'
      : 'open'

const open = and(isNull(orgClaims.acceptedAt), isNull(orgClaims.canceledAt))

export const normalizeClaimEmail = (email: string): string =>
  email.trim().toLowerCase()

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text),
  )
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

// 32 random bytes, base64url without padding.
function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}

// Writes an open claim and returns it with its plain token, which is not
// kept and cannot be read again (the starter mails it). An expired open
// claim for the same email is canceled first (canceled_at = now), in the
// same batch. RangeError for an empty name, slug, email, adminId or
// adminEmail or a ttlMs that is not a positive integer;
// ConflictError('org_claims') when the email has an open claim that has
// not expired.
export async function createOrgClaim(
  db: TenantDatabase,
  input: {
    name: string
    slug: string
    email: string
    adminId: AdminId
    adminEmail: string
    ttlMs: number
    now?: number
  },
): Promise<{ claim: OrgClaimRecord; token: string }> {
  const name = input.name.trim()
  const slug = input.slug.trim()
  const email = normalizeClaimEmail(input.email)
  if (
    name === '' ||
    slug === '' ||
    email === '' ||
    input.adminId === '' ||
    input.adminEmail.trim() === ''
  ) {
    throw new RangeError(
      'createOrgClaim: name, slug, email, adminId and adminEmail',
    )
  }
  if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs <= 0) {
    throw new RangeError(
      `createOrgClaim: ttlMs must be > 0, got ${input.ttlMs}`,
    )
  }
  const now = input.now ?? Date.now()
  const token = newToken()
  const claim: OrgClaimRecord = {
    id: crypto.randomUUID(),
    name,
    slug,
    email,
    adminId: input.adminId,
    adminEmail: input.adminEmail.trim(),
    createdAt: now,
    expiresAt: now + input.ttlMs,
    acceptedAt: null,
    orgId: null,
    canceledAt: null,
  }
  const tokenHash = await sha256Hex(token)
  try {
    await db.batch([
      db
        .update(orgClaims)
        .set({ canceledAt: now })
        .where(
          and(eq(orgClaims.email, email), open, lte(orgClaims.expiresAt, now)),
        ),
      db.insert(orgClaims).values({ ...claim, tokenHash }),
    ])
  } catch (error) {
    for (let e: unknown = error; e instanceof Error; e = e.cause) {
      if (/UNIQUE constraint failed/.test(e.message)) {
        throw new ConflictError('org_claims')
      }
    }
    throw error
  }
  return { claim, token }
}

// The open claim behind a token, or null when the token is unknown, the
// claim was accepted or canceled, or it has expired.
export async function findOpenClaimByToken(
  db: TenantDatabase,
  token: string,
  now: number = Date.now(),
): Promise<OrgClaimRecord | null> {
  if (token === '') return null
  const row = await db
    .select(recordColumns)
    .from(orgClaims)
    .where(
      and(
        eq(orgClaims.tokenHash, await sha256Hex(token)),
        open,
        gt(orgClaims.expiresAt, now),
      ),
    )
    .get()
  return row ?? null
}

// Records the org an open, unexpired claim became. Resolves to true when
// this call accepted it, false when it was accepted, canceled or expired
// already (a second accept changes nothing).
export async function acceptOrgClaim(
  db: TenantDatabase,
  id: string,
  orgId: OrgId,
  now: number = Date.now(),
): Promise<boolean> {
  const result = await db
    .update(orgClaims)
    .set({ acceptedAt: now, orgId })
    .where(and(eq(orgClaims.id, id), open, gt(orgClaims.expiresAt, now)))
    .run()
  return result.meta.changes === 1
}

// Cancels an open claim, expired or not. Resolves to true when this call
// canceled it, false when it was accepted or canceled already or is unknown.
export async function cancelOrgClaim(
  db: TenantDatabase,
  id: string,
  now: number = Date.now(),
): Promise<boolean> {
  const result = await db
    .update(orgClaims)
    .set({ canceledAt: now })
    .where(and(eq(orgClaims.id, id), open))
    .run()
  return result.meta.changes === 1
}

// One claim by id, whatever its status, or null.
export async function getOrgClaim(
  db: TenantDatabase,
  id: string,
): Promise<OrgClaimRecord | null> {
  const row = await db
    .select(recordColumns)
    .from(orgClaims)
    .where(eq(orgClaims.id, id))
    .get()
  return row ?? null
}

// Claims newest first, by status ('open' includes expired open claims).
export async function listOrgClaims(
  db: TenantDatabase,
  options: { status: OrgClaimStatus | 'all' },
): Promise<OrgClaimRecord[]> {
  const where =
    options.status === 'open'
      ? open
      : options.status === 'accepted'
        ? isNotNull(orgClaims.acceptedAt)
        : options.status === 'canceled'
          ? isNotNull(orgClaims.canceledAt)
          : undefined
  return db
    .select(recordColumns)
    .from(orgClaims)
    .where(where)
    .orderBy(desc(orgClaims.createdAt), desc(orgClaims.id))
    .all()
}
