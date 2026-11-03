import { drizzle } from 'drizzle-orm/d1'
import { env } from 'cloudflare:workers'
import { Hono } from 'hono'
import { beforeAll, describe, expect, it } from 'vitest'
import { errors } from '@edgekits/kernel/hono'
import {
  addPrice,
  applyProviderSubscription,
  archivePlan,
  archivePrice,
  createPlan,
  currenciesIssues,
  currenciesKey,
  getCurrencies,
  setCurrencies,
  SettingError,
  restorePlan,
  createPolicyEngine,
  getPlan,
  listPlans,
  loadPlanCatalog,
  planEntitlementIssues,
  PlanError,
  planForPrice,
  planInputIssues,
  planSource,
  priceForPlan,
  getSetting,
  listSettings,
  setDefaultPlan,
  setSetting,
  setTrialPlan,
  trialPlan,
  trialPlanKey,
  updatePlan,
  type EntitlementVocabulary,
  type NewPlanPrice,
  type SubscriptionStatus,
} from '@edgekits/kernel/policy'
import {
  ConflictError,
  createTenantContext,
  tenantGuardLogger,
} from '@edgekits/kernel/tenancy'
import { createPolicySql } from './policy-ddl.js'

const db = drizzle(env.DB, { logger: tenantGuardLogger({ mode: 'strict' }) })
// archivePlan() reads every org's subscriptions rows.
const unguarded = drizzle(env.DB)

const vocabulary: EntitlementVocabulary = {
  members: { kind: 'limit' },
  projects: { kind: 'limit' },
  sso: { kind: 'switch' },
}

let planCount = 0
const freshId = (prefix = 'plan') =>
  `${prefix}-${++planCount}-${crypto.randomUUID().slice(0, 8)}`

const price = (id: string, more: Partial<NewPlanPrice> = {}): NewPlanPrice => ({
  id,
  provider: 'paddle',
  providerProductId: `pro_${id}`,
  kind: 'subscription',
  period: 'month',
  amount: 1900,
  currency: 'USD',
  ...more,
})

const newPlan = (id: string, more: Record<string, unknown> = {}) =>
  createPlan(db, vocabulary, {
    id,
    name: `Plan ${id}`,
    entitlements: { members: 2 },
    ...more,
  })

const reasonOf = async (run: () => Promise<unknown>) => {
  try {
    await run()
  } catch (error) {
    if (error instanceof PlanError)
      return { reason: error.reason, issues: error.issues }
    if (error instanceof ConflictError) return { conflict: error.table }
    throw error
  }
  return null
}

// The ids of every plan that is not archived and has the default flag.
const defaults = async () =>
  (await listPlans(db)).filter((p) => p.isDefault).map((p) => p.id)

beforeAll(async () => {
  for (const statement of createPolicySql) {
    await env.DB.prepare(statement).run()
  }
})

describe('entitlement values against the vocabulary', () => {
  it('accepts limits >= -1 as integers and booleans for switches', () => {
    expect(
      planEntitlementIssues(vocabulary, {
        members: -1,
        projects: 0,
        sso: true,
      }),
    ).toEqual([])
    expect(planEntitlementIssues(vocabulary, {})).toEqual([])
  })

  it('names each refused value', () => {
    expect(
      planEntitlementIssues(vocabulary, {
        members: -2,
        projects: 1.5,
        sso: 1,
        seats: 3,
      }),
    ).toEqual([
      'entitlement members is a limit: a non-negative integer or -1',
      'entitlement projects is a limit: a non-negative integer or -1',
      'entitlement sso is a switch: true or false',
      'entitlement seats is not in the blueprint',
    ])
    expect(planEntitlementIssues(vocabulary, { members: '2' })).toHaveLength(1)
    expect(planEntitlementIssues(vocabulary, { members: true })).toHaveLength(1)
    expect(planEntitlementIssues(vocabulary, { toString: 1 })).toEqual([
      'entitlement toString is not in the blueprint',
    ])
  })

  it('createPlan and updatePlan refuse before writing anything', async () => {
    const id = freshId()
    expect(
      await reasonOf(() =>
        newPlan(id, { entitlements: { members: 2, gold: true } }),
      ),
    ).toEqual({
      reason: 'invalid',
      issues: ['entitlement gold is not in the blueprint'],
    })
    expect(await getPlan(db, id)).toBeNull()

    await newPlan(id)
    expect(
      await reasonOf(() =>
        updatePlan(db, vocabulary, id, {
          entitlements: { sso: 'yes' } as never,
        }),
      ),
    ).toMatchObject({ reason: 'invalid' })
    expect((await getPlan(db, id))?.entitlements).toEqual({ members: 2 })
  })

  it('planInputIssues reports what createPlan refuses, without writing', async () => {
    const id = freshId()
    const input = {
      id,
      name: 'ok',
      entitlements: { members: 2, gold: 1 },
      prices: [price(`pri_${id}`, { currency: 'usd' })],
    }
    expect(planInputIssues(vocabulary, input)).toEqual([
      'entitlement gold is not in the blueprint',
      `price pri_${id}: currency is an ISO 4217 code`,
    ])
    expect(planInputIssues(vocabulary, { name: 'renamed' })).toEqual([])
    expect(await getPlan(db, id)).toBeNull()
  })

  it('refuses a malformed id, name, trial or price', async () => {
    const issues = await reasonOf(() =>
      createPlan(db, vocabulary, {
        id: 'Pro Plan',
        name: ' ',
        entitlements: {},
        trial: { days: 0, requiresCard: false },
        prices: [
          price('pri_a', { kind: 'lifetime', period: 'month' }),
          price('pri_b', { amount: 9.5, currency: 'usd', trialDays: 0 }),
        ],
      }),
    )
    expect(issues).toMatchObject({ reason: 'invalid' })
    expect((issues as unknown as { issues: string[] }).issues).toHaveLength(7)
  })
})

describe('createPlan, getPlan, listPlans', () => {
  it('writes the plan with its prices and reads them back', async () => {
    const id = freshId()
    const created = await newPlan(id, {
      entitlements: { members: -1, sso: true },
      trial: { days: 14, requiresCard: true },
      sortOrder: 3,
      prices: [price(`pri_${id}`, { trialDays: 14 })],
    })
    expect(created).toMatchObject({
      id,
      entitlements: { members: -1, sso: true },
      isDefault: false,
      trial: { days: 14, requiresCard: true },
      sortOrder: 3,
      archivedAt: null,
    })
    expect(created.prices).toEqual([
      expect.objectContaining({
        id: `pri_${id}`,
        planId: id,
        provider: 'paddle',
        amount: 1900,
        trialDays: 14,
        archivedAt: null,
      }),
    ])
    expect(await getPlan(db, id)).toEqual(created)
    expect((await listPlans(db)).map((p) => p.id)).toContain(id)
  })

  it('refuses a taken plan id or price id with ConflictError and writes nothing', async () => {
    const id = freshId()
    await newPlan(id, { prices: [price(`pri_${id}`)] })
    expect(await reasonOf(() => newPlan(id))).toEqual({ conflict: 'plans' })
    const other = freshId()
    expect(
      await reasonOf(() => newPlan(other, { prices: [price(`pri_${id}`)] })),
    ).toEqual({ conflict: 'plan_prices' })
    expect(await getPlan(db, other)).toBeNull()
  })

  it('lists in sort order, then id', async () => {
    const [a, b, c] = [freshId('zz'), freshId('aa'), freshId('mm')]
    await newPlan(a, { sortOrder: 1000 })
    await newPlan(b, { sortOrder: 1001 })
    await newPlan(c, { sortOrder: 1000 })
    const order = (await listPlans(db))
      .map((p) => p.id)
      .filter((p) => [a, b, c].includes(p))
    expect(order).toEqual([c, a, b])
  })
})

describe('the one default plan', () => {
  it('createPlan with isDefault moves the flag', async () => {
    const [a, b] = [freshId(), freshId()]
    await newPlan(a, { isDefault: true })
    expect(await defaults()).toEqual([a])
    await newPlan(b, { isDefault: true })
    expect(await defaults()).toEqual([b])
    expect((await getPlan(db, a))?.isDefault).toBe(false)
  })

  it('setDefaultPlan moves it, null clears it, and a refused call changes nothing', async () => {
    const [a, b, archived] = [freshId(), freshId(), freshId()]
    await newPlan(a)
    await newPlan(b)
    await newPlan(archived)
    await archivePlan(unguarded, archived)

    await setDefaultPlan(db, a)
    expect(await defaults()).toEqual([a])
    await setDefaultPlan(db, b)
    expect(await defaults()).toEqual([b])

    expect(await reasonOf(() => setDefaultPlan(db, archived))).toMatchObject({
      reason: 'not-found',
    })
    expect(await reasonOf(() => setDefaultPlan(db, 'no-such'))).toMatchObject({
      reason: 'not-found',
    })
    expect(await defaults()).toEqual([b])

    await setDefaultPlan(db, null)
    expect(await defaults()).toEqual([])
    expect((await loadPlanCatalog(db)).defaultPlan).toBeNull()
  })

  it('the partial unique index refuses a second default written around the repository', async () => {
    const [a, b] = [freshId(), freshId()]
    await newPlan(a)
    await newPlan(b)
    await setDefaultPlan(db, a)
    await expect(
      env.DB.prepare('UPDATE plans SET is_default = 1 WHERE id = ?')
        .bind(b)
        .run(),
    ).rejects.toThrow(/UNIQUE constraint failed/)
    expect(await defaults()).toEqual([a])
  })

  it('concurrent setDefaultPlan calls leave exactly one default', async () => {
    const ids = [freshId(), freshId(), freshId(), freshId()]
    for (const id of ids) await newPlan(id)
    await Promise.all(ids.map((id) => setDefaultPlan(db, id)))
    const after = await defaults()
    expect(after).toHaveLength(1)
    expect(ids).toContain(after[0])
  })

  it('archiving the default plan clears the default', async () => {
    const id = freshId()
    await newPlan(id, { isDefault: true })
    await archivePlan(unguarded, id)
    expect(await defaults()).toEqual([])
    expect((await getPlan(db, id))?.isDefault).toBe(false)
  })
})

describe('archivePlan', () => {
  const subscribe = (orgId: string, plan: string, status: SubscriptionStatus) =>
    applyProviderSubscription(unguarded, orgId, {
      provider: 'paddle',
      providerSubscriptionId: `sub_${crypto.randomUUID().slice(0, 8)}`,
      kind: 'subscription',
      plan,
      status,
      seats: 1,
      periodEnd: null,
      trialEndsAt: null,
      cancelAt: null,
      updatedAt: Date.now(),
    })

  it.each(['active', 'trialing', 'past_due', 'paused'] as const)(
    'refuses with ConflictError while an org has a %s row on the plan',
    async (status) => {
      const id = freshId()
      await newPlan(id, { prices: [price(`pri_${id}`)] })
      await subscribe(`org-${id}`, id, status)
      expect(await reasonOf(() => archivePlan(unguarded, id))).toEqual({
        conflict: 'subscriptions',
      })
      const plan = await getPlan(db, id)
      expect(plan?.archivedAt).toBeNull()
      expect(plan?.prices[0]?.archivedAt).toBeNull()
    },
  )

  it('archives the plan and its prices when every row is canceled or expired', async () => {
    const id = freshId()
    await newPlan(id, {
      prices: [price(`pri_${id}_m`), price(`pri_${id}_y`, { period: 'year' })],
    })
    await subscribe(`org-${id}-a`, id, 'canceled')
    await subscribe(`org-${id}-b`, id, 'expired')
    const now = Date.now()
    const archived = await archivePlan(unguarded, id, now)
    expect(archived.archivedAt).toBe(now)
    expect(archived.prices.map((p) => p.archivedAt)).toEqual([now, now])

    expect((await listPlans(db)).map((p) => p.id)).not.toContain(id)
    expect(
      (await listPlans(db, { includeArchived: true })).map((p) => p.id),
    ).toContain(id)
    expect(await priceForPlan(db, 'paddle', id, 'month')).toBeNull()
    // A subscription on an archived price keeps its plan.
    expect(await planForPrice(db, 'paddle', `pri_${id}_m`)).toBe(id)
    expect(
      await reasonOf(() => updatePlan(db, vocabulary, id, { name: 'x' })),
    ).toMatchObject({ reason: 'not-found' })
    expect(
      await reasonOf(() => addPrice(db, id, price(`pri_${id}_new`))),
    ).toMatchObject({ reason: 'not-found' })
  })

  it('archiving again changes nothing; an unknown plan is not-found', async () => {
    const id = freshId()
    await newPlan(id)
    const first = await archivePlan(unguarded, id, 1000)
    const second = await archivePlan(unguarded, id, 2000)
    expect(second.archivedAt).toBe(first.archivedAt)
    expect(
      await reasonOf(() => archivePlan(unguarded, 'no-such')),
    ).toMatchObject({ reason: 'not-found' })
  })

  it('restorePlan brings back the plan and the prices archived with it', async () => {
    const id = freshId()
    await newPlan(id, {
      prices: [price(`pri_${id}_m`), price(`pri_${id}_y`, { period: 'year' })],
    })
    // Archived on its own first: it stays archived.
    expect(await archivePrice(db, 'paddle', `pri_${id}_y`, 500)).toBe(true)
    await archivePlan(unguarded, id, 1000)
    const restored = await restorePlan(db, id, 2000)
    expect(restored.archivedAt).toBeNull()
    expect(restored.updatedAt).toBe(2000)
    expect(
      Object.fromEntries(restored.prices.map((p) => [p.id, p.archivedAt])),
    ).toEqual({ [`pri_${id}_m`]: null, [`pri_${id}_y`]: 500 })
    expect((await listPlans(db)).map((p) => p.id)).toContain(id)
    expect(await priceForPlan(db, 'paddle', id, 'month')).toMatchObject({
      id: `pri_${id}_m`,
    })
    // Restoring a plan that is not archived changes nothing.
    expect((await restorePlan(db, id, 3000)).updatedAt).toBe(2000)
    expect(await reasonOf(() => restorePlan(db, 'no-such'))).toMatchObject({
      reason: 'not-found',
    })
  })

  it('a subscription in another org on another plan does not block it', async () => {
    const [id, other] = [freshId(), freshId()]
    await newPlan(id)
    await newPlan(other)
    await subscribe(`org-${other}`, other, 'active')
    expect((await archivePlan(unguarded, id)).archivedAt).not.toBeNull()
  })
})

describe('prices', () => {
  it('priceForPlan returns the newest price of the provider and period', async () => {
    const id = freshId()
    await newPlan(id)
    await addPrice(db, id, price(`pri_${id}_old`), 1000)
    await addPrice(db, id, price(`pri_${id}_new`), 2000)
    await addPrice(db, id, price(`pri_${id}_year`, { period: 'year' }), 3000)
    await addPrice(db, id, price(`str_${id}`, { provider: 'stripe' }), 4000)
    expect((await priceForPlan(db, 'paddle', id, 'month'))?.id).toBe(
      `pri_${id}_new`,
    )
    expect((await priceForPlan(db, 'paddle', id, 'year'))?.id).toBe(
      `pri_${id}_year`,
    )
    expect((await priceForPlan(db, 'stripe', id, 'month'))?.id).toBe(
      `str_${id}`,
    )
    expect(await priceForPlan(db, 'paddle', id, 'once')).toBeNull()

    expect(await archivePrice(db, 'paddle', `pri_${id}_new`)).toBe(true)
    expect(await archivePrice(db, 'paddle', `pri_${id}_new`)).toBe(false)
    expect((await priceForPlan(db, 'paddle', id, 'month'))?.id).toBe(
      `pri_${id}_old`,
    )
  })

  it('planForPrice is keyed by provider; unknown prices map to null', async () => {
    const id = freshId()
    await newPlan(id, { prices: [price(`pri_${id}`)] })
    expect(await planForPrice(db, 'paddle', `pri_${id}`)).toBe(id)
    expect(await planForPrice(db, 'stripe', `pri_${id}`)).toBeNull()
    expect(await planForPrice(db, 'paddle', 'pri_unknown')).toBeNull()
  })

  it('a lifetime price bills once; addPrice refuses a duplicate', async () => {
    const id = freshId()
    await newPlan(id)
    const lifetime = await addPrice(
      db,
      id,
      price(`pri_${id}_life`, { kind: 'lifetime', period: 'once' }),
    )
    expect(lifetime).toMatchObject({ kind: 'lifetime', period: 'once' })
    expect(
      await reasonOf(() => addPrice(db, id, price(`pri_${id}_life`))),
    ).toEqual({ conflict: 'plan_prices' })
    expect(
      await reasonOf(() =>
        addPrice(db, id, price(`pri_${id}_x`, { kind: 'lifetime' })),
      ),
    ).toMatchObject({ reason: 'invalid' })
  })
})

describe('planSource', () => {
  it('keeps the catalog for the TTL, reloads after it, and invalidate() drops it', async () => {
    const id = freshId()
    await newPlan(id, { entitlements: { members: 2 } })
    let clock = 0
    const source = planSource(db, { ttlMs: 60_000, now: () => clock })
    const members = async () => (await source()).plans[id]?.members

    expect(await members()).toBe(2)
    await updatePlan(db, vocabulary, id, { entitlements: { members: 3 } })
    clock = 59_999
    expect(await members()).toBe(2)
    clock = 60_000
    expect(await members()).toBe(3)

    await updatePlan(db, vocabulary, id, { entitlements: { members: 4 } })
    clock = 60_001
    expect(await members()).toBe(3)
    source.invalidate()
    expect(await members()).toBe(4)
  })

  it('concurrent calls share one load', () => {
    const source = planSource(db)
    expect(source()).toBe(source())
  })

  it('a failed load is not kept', async () => {
    let fail = true
    const flaky = {
      select: (...args: unknown[]) => {
        if (fail) throw new Error('D1 down')
        return (db.select as (...a: unknown[]) => unknown)(...args)
      },
    } as unknown as typeof db
    const source = planSource(flaky)
    await expect(source()).rejects.toThrow('D1 down')
    fail = false
    await expect(source()).resolves.toHaveProperty('plans')
  })

  it('carries archived plans for their subscribers but never an archived default', async () => {
    const id = freshId()
    await newPlan(id, { isDefault: true, entitlements: { members: 9 } })
    await archivePlan(unguarded, id)
    const catalog = await loadPlanCatalog(db)
    expect(catalog.plans[id]).toEqual({ members: 9 })
    expect(catalog.defaultPlan).not.toBe(id)
  })

  it('drives the engine: entitled() follows the catalog after invalidate()', async () => {
    const id = freshId()
    await newPlan(id, { isDefault: true, entitlements: { members: 2 } })
    const source = planSource(db)
    const engine = createPolicyEngine({
      entitlements: vocabulary,
      plans: source,
      counters: { members: async () => 2 },
    })
    const orgId = `org-${id}`
    const ctx = createTenantContext({
      orgId,
      org: { id: orgId, kind: 'team', slug: orgId },
      actor: { userId: 'u', role: 'owner' },
      request: { id: 'r', locale: 'en', source: 'explicit' },
      db,
    })
    expect(await engine.entitled(ctx, 'members')).toMatchObject({
      ok: false,
      limit: 2,
    })
    await updatePlan(db, vocabulary, id, { entitlements: { members: 3 } })
    expect((await engine.entitled(ctx, 'members')).ok).toBe(false)
    source.invalidate()
    expect(await engine.entitled(ctx, 'members')).toEqual({ ok: true })

    await setDefaultPlan(db, null)
    source.invalidate()
    expect(await engine.entitled(ctx, 'members')).toEqual({
      ok: false,
      reason: 'entitlement',
      key: 'members',
      limit: 0,
      current: 2,
    })
  })
})

describe('errors() and the catalog', () => {
  it('maps PlanError to 400 with its issues or 404, and ConflictError to 409', async () => {
    const app = new Hono()
    app.onError(errors())
    app.post('/invalid', async (c) => c.json(await newPlan('Bad Id')))
    app.post('/missing', async (c) => {
      await setDefaultPlan(db, 'no-such')
      return c.body(null)
    })
    const taken = freshId()
    await newPlan(taken)
    app.post('/taken', async (c) => c.json(await newPlan(taken)))

    const invalid = await app.request('/invalid', { method: 'POST' })
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toEqual({
      error: 'invalid-plan',
      issues: ['id: lowercase letters, digits, - and _, at most 64'],
    })
    expect((await app.request('/missing', { method: 'POST' })).status).toBe(404)
    expect((await app.request('/taken', { method: 'POST' })).status).toBe(409)
  })
})

describe('settings and the trial plan', () => {
  it('getSetting is null for an unset key; setSetting inserts, then replaces', async () => {
    const key = `test.${freshId('key')}`
    expect(await getSetting(db, key)).toBeNull()
    await setSetting(db, key, { days: 14 })
    expect(await getSetting(db, key)).toEqual({ days: 14 })
    await setSetting(db, key, 'other')
    expect(await getSetting(db, key)).toBe('other')
  })

  it('listSettings returns every stored key with its value and updatedAt, by key', async () => {
    const prefix = `list.${freshId('k')}`
    await setSetting(db, `${prefix}.b`, ['USD'], 2000)
    await setSetting(db, `${prefix}.a`, { days: 7 }, 1000)
    await setSetting(db, `${prefix}.a`, { days: 14 }, 3000)
    const mine = (await listSettings(db)).filter((row) =>
      row.key.startsWith(prefix),
    )
    expect(mine).toEqual([
      { key: `${prefix}.a`, value: { days: 14 }, updatedAt: 3000 },
      { key: `${prefix}.b`, value: ['USD'], updatedAt: 2000 },
    ])
    const keys = (await listSettings(db)).map((row) => row.key)
    expect(keys).toEqual([...keys].sort())
  })

  it('trialPlan is the named plan row, or null when unset, missing or archived', async () => {
    // Unset until this test names one (no other test in the file does).
    expect(await trialPlan(db)).toBeNull()

    const id = freshId()
    await newPlan(id, { trial: { days: 14, requiresCard: true } })
    await setTrialPlan(db, id)
    expect(await getSetting(db, trialPlanKey)).toBe(id)
    expect(await trialPlan(db)).toMatchObject({
      id,
      trial: { days: 14, requiresCard: true },
    })

    await archivePlan(unguarded, id)
    expect(await trialPlan(db)).toBeNull()

    await setSetting(db, trialPlanKey, 'no-such-plan')
    expect(await trialPlan(db)).toBeNull()
  })

  it('billing.currencies: the default until set, then only codes the manifest lists', async () => {
    const manifest = { currencies: ['USD', 'EUR', 'GBP'] }
    expect(await getCurrencies(db)).toEqual(['USD'])
    expect(currenciesIssues(['EUR', 'USD'], manifest)).toEqual([])
    expect(currenciesIssues([], manifest)).toEqual([
      'empty: name at least one currency',
    ])
    expect(currenciesIssues('USD', manifest)).toEqual([
      'not a list of currency codes',
    ])
    expect(currenciesIssues(['usd', 'XYZ', 'EUR', 'EUR'], manifest)).toEqual([
      '"usd" is no ISO 4217 code',
      'XYZ is not a currency of the provider',
      'EUR is listed twice',
    ])
    const refused = await setCurrencies(db, ['JPY'], manifest).catch(
      (error: unknown) => error,
    )
    expect(refused).toBeInstanceOf(SettingError)
    expect(refused).toMatchObject({
      key: currenciesKey,
      issues: ['JPY is not a currency of the provider'],
    })
    expect(await getSetting(db, currenciesKey)).toBeNull()
    await setCurrencies(db, ['EUR', 'USD'], manifest)
    expect(await getCurrencies(db)).toEqual(['EUR', 'USD'])
    await setSetting(db, currenciesKey, [])
    expect(await getCurrencies(db)).toEqual(['USD'])
  })

  it('setTrialPlan refuses a missing or archived plan before writing', async () => {
    const current = freshId()
    await newPlan(current)
    await setTrialPlan(db, current)
    const archived = freshId()
    await newPlan(archived)
    await archivePlan(unguarded, archived)

    const notFound = { reason: 'not-found', issues: [] }
    expect(await reasonOf(() => setTrialPlan(db, 'no-such'))).toEqual(notFound)
    expect(await reasonOf(() => setTrialPlan(db, archived))).toEqual(notFound)
    expect(await getSetting(db, trialPlanKey)).toBe(current)
  })
})
