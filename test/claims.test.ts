import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  cancelOrgClaim,
  ConflictError,
  createOrgClaim,
  findOpenClaimByToken,
  getOrgClaim,
  listOrgClaims,
  markClaimAccepted,
  orgClaims,
  orgClaimStatus,
  releaseClaimMark,
  setClaimOrg,
  tenantGuardLogger,
} from '@edgekits/kernel/tenancy'
import { createClaimsSql } from './claims-ddl.js'

// The two steps of an accept, as the starter takes them.
const acceptOrgClaim = async (
  database: typeof db,
  id: string,
  orgId: string,
  now: number,
) =>
  (await markClaimAccepted(database, id, now)) &&
  (await setClaimOrg(database, id, orgId))

// Org claims (P1-10d) against D1, under the strict tenant guard: org_claims
// is not a tenant table, and its queries name no org.
const db = drizzle(env.DB, { logger: tenantGuardLogger({ mode: 'strict' }) })

const DAY = 86_400_000
let count = 0
const email = () =>
  `owner-${++count}-${crypto.randomUUID().slice(0, 8)}@example.com`
const claim = (address: string, now = 1_000_000, ttlMs = 14 * DAY) =>
  createOrgClaim(db, {
    name: ' Acme Lab ',
    slug: 'acme-lab',
    email: address,
    adminId: 'adm-1',
    adminEmail: 'ops@example.com',
    ttlMs,
    now,
  })

beforeAll(async () => {
  for (const statement of createClaimsSql) {
    await env.DB.prepare(statement).run()
  }
})

describe('org claims', () => {
  it('creates an open claim; the token is returned once and only its hash is kept', async () => {
    const address = email()
    const { claim: created, token } = await claim(`  ${address.toUpperCase()} `)
    expect(created).toEqual({
      id: expect.any(String),
      name: 'Acme Lab',
      slug: 'acme-lab',
      email: address,
      adminId: 'adm-1',
      adminEmail: 'ops@example.com',
      createdAt: 1_000_000,
      expiresAt: 1_000_000 + 14 * DAY,
      acceptedAt: null,
      orgId: null,
      canceledAt: null,
    })
    expect(orgClaimStatus(created)).toBe('open')
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const [row] = await db
      .select()
      .from(orgClaims)
      .where(eq(orgClaims.id, created.id))
      .all()
    expect(row?.tokenHash).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(row)).not.toContain(token)
    expect(await getOrgClaim(db, created.id)).toEqual(created)
  })

  it('finds an open claim by its token until it expires', async () => {
    const { claim: created, token } = await claim(email(), 1_000_000, DAY)
    expect(await findOpenClaimByToken(db, token, 1_000_000)).toEqual(created)
    expect(await findOpenClaimByToken(db, token, 1_000_000 + DAY - 1)).toEqual(
      created,
    )
    expect(await findOpenClaimByToken(db, token, 1_000_000 + DAY)).toBeNull()
    expect(await findOpenClaimByToken(db, `${token}x`, 1_000_000)).toBeNull()
    expect(await findOpenClaimByToken(db, '', 1_000_000)).toBeNull()
  })

  it('accepts once, recording the org; an accepted claim is no longer found', async () => {
    const { claim: created, token } = await claim(email())
    expect(await acceptOrgClaim(db, created.id, 'org-1', 2_000_000)).toBe(true)
    expect(await acceptOrgClaim(db, created.id, 'org-2', 2_000_001)).toBe(false)
    const accepted = await getOrgClaim(db, created.id)
    expect(accepted).toMatchObject({ acceptedAt: 2_000_000, orgId: 'org-1' })
    expect(orgClaimStatus(accepted!)).toBe('accepted')
    expect(await findOpenClaimByToken(db, token, 2_000_002)).toBeNull()
    expect(await cancelOrgClaim(db, created.id)).toBe(false)
  })

  it('marks a claim once: of two concurrent marks, one wins', async () => {
    const { claim: created, token } = await claim(email())
    const results = await Promise.all([
      markClaimAccepted(db, created.id, 2_000_000),
      markClaimAccepted(db, created.id, 2_000_000),
    ])
    expect(results.filter(Boolean)).toHaveLength(1)
    const marked = await getOrgClaim(db, created.id)
    expect(marked).toMatchObject({ acceptedAt: 2_000_000, orgId: null })
    expect(orgClaimStatus(marked!)).toBe('accepted')
    expect(await findOpenClaimByToken(db, token, 2_000_001)).toBeNull()
    expect(await cancelOrgClaim(db, created.id)).toBe(false)
    expect(await setClaimOrg(db, created.id, 'org-m')).toBe(true)
    expect(await setClaimOrg(db, created.id, 'org-n')).toBe(false)
    expect(await getOrgClaim(db, created.id)).toMatchObject({
      orgId: 'org-m',
    })
  })

  it('releases a mark without an org, so the claim can be accepted again', async () => {
    const { claim: created, token } = await claim(email())
    expect(await setClaimOrg(db, created.id, 'org-early')).toBe(false)
    expect(await markClaimAccepted(db, created.id, 2_000_000)).toBe(true)
    expect(await releaseClaimMark(db, created.id, 2_000_001)).toBe(false)
    expect(await releaseClaimMark(db, created.id, 2_000_000)).toBe(true)
    expect(await findOpenClaimByToken(db, token, 2_000_002)).toMatchObject({
      id: created.id,
      acceptedAt: null,
      orgId: null,
    })
    expect(await acceptOrgClaim(db, created.id, 'org-r', 2_000_003)).toBe(true)
    // A claim with its org is not released.
    expect(await releaseClaimMark(db, created.id, 2_000_003)).toBe(false)
  })

  it('does not accept an expired claim, and cancels it', async () => {
    const { claim: created } = await claim(email(), 1_000_000, DAY)
    expect(await acceptOrgClaim(db, created.id, 'org-x', 1_000_000 + DAY)).toBe(
      false,
    )
    expect(await cancelOrgClaim(db, created.id, 3_000_000)).toBe(true)
    expect(await cancelOrgClaim(db, created.id, 3_000_001)).toBe(false)
    const canceled = await getOrgClaim(db, created.id)
    expect(canceled).toMatchObject({ canceledAt: 3_000_000, acceptedAt: null })
    expect(orgClaimStatus(canceled!)).toBe('canceled')
    expect(await cancelOrgClaim(db, 'no-such')).toBe(false)
  })

  it('keeps one open claim per email; after accept or cancel a new one is allowed', async () => {
    const address = email()
    const first = await claim(address)
    const refused = await claim(address.toUpperCase()).catch(
      (error: unknown) => error,
    )
    expect(refused).toBeInstanceOf(ConflictError)
    expect(refused).toMatchObject({ table: 'org_claims' })
    expect(await cancelOrgClaim(db, first.claim.id)).toBe(true)
    const second = await claim(address)
    expect(await acceptOrgClaim(db, second.claim.id, 'org-3', 1_000_001)).toBe(
      true,
    )
    const third = await claim(address)
    expect(orgClaimStatus(third.claim)).toBe('open')
  })

  it("keeps the operator's email for the accepted event, trimmed", async () => {
    const { claim: created, token } = await createOrgClaim(db, {
      name: 'Acme',
      slug: 'acme',
      email: email(),
      adminId: 'adm-2',
      adminEmail: ' ops2@example.com ',
      ttlMs: DAY,
      now: 1_000_000,
    })
    expect(created.adminEmail).toBe('ops2@example.com')
    expect(await findOpenClaimByToken(db, token, 1_000_001)).toMatchObject({
      adminId: 'adm-2',
      adminEmail: 'ops2@example.com',
    })
  })

  it('an expired open claim gives way to a new one for that email', async () => {
    const address = email()
    const expired = await claim(address, 1_000_000, DAY)
    const fresh = await claim(address, 1_000_000 + DAY)
    expect(await getOrgClaim(db, expired.claim.id)).toMatchObject({
      canceledAt: 1_000_000 + DAY,
      acceptedAt: null,
    })
    expect(orgClaimStatus(fresh.claim)).toBe('open')
    // The new claim has not expired: it still blocks a third.
    await expect(claim(address, 1_000_000 + DAY + 1)).rejects.toBeInstanceOf(
      ConflictError,
    )
    expect(await getOrgClaim(db, fresh.claim.id)).toMatchObject({
      canceledAt: null,
    })
  })

  it('refuses an empty field or a ttl that is not positive', async () => {
    const input = {
      name: 'n',
      slug: 's',
      email: email(),
      adminId: 'a',
      adminEmail: 'ops@example.com',
      ttlMs: DAY,
    }
    for (const bad of [
      { name: '  ' },
      { slug: '' },
      { email: ' ' },
      { adminId: '' },
      { adminEmail: ' ' },
      { ttlMs: 0 },
      { ttlMs: 1.5 },
    ]) {
      await expect(createOrgClaim(db, { ...input, ...bad })).rejects.toThrow(
        RangeError,
      )
    }
  })

  it('lists claims by status, newest first', async () => {
    const [a, b, c] = [email(), email(), email()]
    const open = await claim(a, 5_000_000)
    const accepted = await claim(b, 5_000_001)
    const canceled = await claim(c, 5_000_002)
    await acceptOrgClaim(db, accepted.claim.id, 'org-l', 5_000_003)
    await cancelOrgClaim(db, canceled.claim.id, 5_000_004)
    const ids = async (status: 'open' | 'accepted' | 'canceled' | 'all') =>
      (await listOrgClaims(db, { status })).map((x) => x.id)
    expect(await ids('open')).toContain(open.claim.id)
    expect(await ids('open')).not.toContain(accepted.claim.id)
    expect(await ids('accepted')).toContain(accepted.claim.id)
    expect(await ids('accepted')).not.toContain(open.claim.id)
    expect(await ids('canceled')).toContain(canceled.claim.id)
    const all = await ids('all')
    expect(all.indexOf(canceled.claim.id)).toBeLessThan(
      all.indexOf(open.claim.id),
    )
    for (const row of await listOrgClaims(db, { status: 'all' })) {
      expect(row).not.toHaveProperty('tokenHash')
    }
  })
})
