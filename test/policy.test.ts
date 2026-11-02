import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { env } from 'cloudflare:workers'
import { Hono } from 'hono'
import { beforeAll, describe, expect, it } from 'vitest'
import { errors } from '@edgekits/kernel/hono'
import {
  applyProviderSubscription,
  createPolicyEngine,
  endKernelTrial,
  expireTrials,
  getSuspension,
  liftSuspension,
  loadPolicyRows,
  PolicyError,
  resolveEntitlements,
  setTrialEnd,
  startKernelTrial,
  subpath,
  suspendOrg,
  type EntitlementOverrideRecord,
  type EntitlementVocabulary,
  type PlanCatalog,
  type Plans,
  type PlanSource,
  type ProviderSubscriptionRecord,
  type ResolveInput,
  type SubscriptionRecord,
} from '@edgekits/kernel/policy'
import {
  ConflictError,
  createTenantContext,
  TenantGuardError,
  tenantGuardLogger,
  type TenantContext,
} from '@edgekits/kernel/tenancy'
import {
  entitlementOverrides,
  orgSuspensions,
  subscriptions,
} from '../src/policy/internal/policy.tables.js'
import { createPolicySql } from './policy-ddl.js'
import { createProjectsSql, projects } from './projects.tables.js'
import { seeded, shuffle } from './random.js'

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_800_000_000_000

const plans = {
  free: { projects: 3, seats: 1, ai: false },
  pro: { projects: -1, seats: 10, ai: true },
  team: { projects: 50, seats: 25, ai: true },
} satisfies Plans

type Row = ResolveInput['subscriptions'][number]

const row = (
  kind: Row['kind'],
  plan: string,
  status: Row['status'],
  more: Partial<Row> = {},
): Row => ({
  kind,
  plan,
  status,
  trialEndsAt: null,
  updatedAt: NOW - DAY,
  ...more,
})

const override = (
  id: string,
  value: number | boolean,
  expiresAt: number | null = null,
) => ({ id, value, expiresAt })

const resolve = (
  input: Partial<ResolveInput> & Pick<ResolveInput, 'subscriptions'>,
) =>
  resolveEntitlements({
    plans,
    defaultPlan: 'free',
    overrides: [],
    now: NOW,
    ...input,
  })

const paidPlans = { pro: plans.pro, team: plans.team }

describe('@edgekits/kernel/policy', () => {
  it('exposes the public entry', () => {
    expect(subpath).toBe('policy')
  })

  it('carries the denied decision on PolicyError', () => {
    const decision = {
      ok: false,
      reason: 'forbidden',
      permission: 'billing.write',
    } as const
    const error = new PolicyError(decision)
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('PolicyError')
    expect(error.decision).toBe(decision)
  })
})

describe('resolveEntitlements: each source alone', () => {
  it('override: values from unexpired overrides, no plan', () => {
    expect(
      resolveEntitlements({
        plans: paidPlans,
        defaultPlan: null,
        subscriptions: [],
        overrides: [override('projects', 7)],
        now: NOW,
      }),
    ).toEqual({ plan: null, source: 'override', values: { projects: 7 } })
  })

  it('lifetime: an active lifetime row', () => {
    expect(
      resolve({ subscriptions: [row('lifetime', 'team', 'active')] }),
    ).toEqual({ plan: 'team', source: 'lifetime', values: plans.team })
  })

  it('subscription: an active subscription row', () => {
    expect(
      resolve({ subscriptions: [row('subscription', 'pro', 'active')] }),
    ).toEqual({ plan: 'pro', source: 'subscription', values: plans.pro })
  })

  it('trial: a trialing row with trialEndsAt after now', () => {
    const trialEndsAt = NOW + DAY
    expect(
      resolve({
        subscriptions: [
          row('subscription', 'pro', 'trialing', { trialEndsAt }),
        ],
      }),
    ).toEqual({ plan: 'pro', source: 'trial', values: plans.pro, trialEndsAt })
  })

  it('default: no rows and a default plan', () => {
    expect(resolve({ subscriptions: [] })).toEqual({
      plan: 'free',
      source: 'default',
      values: plans.free,
    })
  })

  it('default: the catalog names any plan as the default', () => {
    expect(resolve({ subscriptions: [], defaultPlan: 'team' })).toEqual({
      plan: 'team',
      source: 'default',
      values: plans.team,
    })
  })

  it('none: no rows and no default plan', () => {
    expect(
      resolveEntitlements({
        plans: paidPlans,
        defaultPlan: null,
        subscriptions: [],
        overrides: [],
        now: NOW,
      }),
    ).toEqual({ plan: null, source: 'none', values: {} })
  })

  it('none: a plan named "free" is not a fallback without the default flag', () => {
    expect(resolve({ subscriptions: [], defaultPlan: null })).toEqual({
      plan: null,
      source: 'none',
      values: {},
    })
  })

  it('none: a default plan id that is not in the catalog grants nothing', () => {
    expect(resolve({ subscriptions: [], defaultPlan: 'gold' })).toEqual({
      plan: null,
      source: 'none',
      values: {},
    })
  })
})

describe('resolveEntitlements: priority', () => {
  it('override over lifetime, per key', () => {
    const resolved = resolve({
      subscriptions: [row('lifetime', 'team', 'active')],
      overrides: [override('projects', 500), override('sso', true)],
    })
    expect(resolved).toEqual({
      plan: 'team',
      source: 'override',
      values: { ...plans.team, projects: 500, sso: true },
    })
  })

  it('lifetime over subscription', () => {
    const resolved = resolve({
      subscriptions: [
        row('subscription', 'pro', 'active', { updatedAt: NOW }),
        row('lifetime', 'team', 'active'),
      ],
    })
    expect(resolved.plan).toBe('team')
    expect(resolved.source).toBe('lifetime')
  })

  it('subscription over trial', () => {
    const resolved = resolve({
      subscriptions: [
        row('subscription', 'pro', 'trialing', {
          trialEndsAt: NOW + DAY,
          updatedAt: NOW,
        }),
        row('subscription', 'team', 'active'),
      ],
    })
    expect(resolved.plan).toBe('team')
    expect(resolved.source).toBe('subscription')
    expect(resolved.trialEndsAt).toBeUndefined()
  })

  it('trial over default', () => {
    const resolved = resolve({
      subscriptions: [
        row('subscription', 'pro', 'trialing', { trialEndsAt: NOW + 1 }),
      ],
    })
    expect(resolved.plan).toBe('pro')
    expect(resolved.source).toBe('trial')
  })

  it('the newest active subscription wins', () => {
    const resolved = resolve({
      subscriptions: [
        row('subscription', 'pro', 'active', { updatedAt: NOW - 2 * DAY }),
        row('subscription', 'team', 'active', { updatedAt: NOW - DAY }),
      ],
    })
    expect(resolved.plan).toBe('team')
  })
})

describe('resolveEntitlements: expiry and inactive rows', () => {
  it('ignores an expired override without changing it', () => {
    const overrides = Object.freeze([
      Object.freeze(override('projects', 99, NOW)),
    ])
    const resolved = resolve({ subscriptions: [], overrides })
    expect(resolved).toEqual({
      plan: 'free',
      source: 'default',
      values: plans.free,
    })
    expect(overrides[0]).toEqual(override('projects', 99, NOW))
  })

  it('an expired trial falls to the default plan, and the row is not changed', () => {
    const subscriptionRows = Object.freeze([
      Object.freeze(
        row('subscription', 'pro', 'trialing', { trialEndsAt: NOW }),
      ),
      Object.freeze(row('subscription', 'team', 'expired')),
    ])
    const resolved = resolve({ subscriptions: subscriptionRows })
    expect(resolved.source).toBe('default')
    expect(resolved.values).toEqual(plans.free)
    expect(subscriptionRows[0]?.status).toBe('trialing')
  })

  it('canceled, paused, past_due and inactive lifetime rows grant nothing', () => {
    const resolved = resolve({
      subscriptions: [
        row('subscription', 'pro', 'canceled'),
        row('subscription', 'pro', 'paused'),
        row('subscription', 'pro', 'past_due'),
        row('lifetime', 'team', 'canceled'),
      ],
    })
    expect(resolved.source).toBe('default')
  })

  it('keeps -1 (unlimited) and boolean gates as declared', () => {
    const { values } = resolve({
      subscriptions: [row('subscription', 'pro', 'active')],
    })
    expect(values.projects).toBe(-1)
    expect(values.ai).toBe(true)
  })
})

const db = drizzle(env.DB, { logger: tenantGuardLogger({ mode: 'strict' }) })
// For the cross-org batch only (see expireTrials).
const unguarded = drizzle(env.DB)

let orgCount = 0
const freshOrg = () => `org-${++orgCount}-${crypto.randomUUID().slice(0, 8)}`

const contextFor = (orgId: string, role = 'owner'): TenantContext =>
  createTenantContext({
    orgId,
    org: { id: orgId, kind: 'team', slug: orgId },
    actor: { userId: `user-${orgId}`, role },
    request: { id: `req-${orgId}`, locale: 'en', source: 'explicit' },
    db,
  })

const insertSubscription = (
  ctx: TenantContext,
  values: Partial<SubscriptionRecord> &
    Pick<SubscriptionRecord, 'kind' | 'plan' | 'status'>,
) =>
  ctx.db.repo(subscriptions).insert({
    id: crypto.randomUUID(),
    updatedAt: Date.now(),
    startedAt: Date.now(),
    ...values,
  })

const insertOverride = (
  ctx: TenantContext,
  values: Pick<EntitlementOverrideRecord, 'id' | 'value'> &
    Partial<EntitlementOverrideRecord>,
) =>
  ctx.db.repo(entitlementOverrides).insert({
    reason: 'test',
    adminId: 'admin-1',
    createdAt: Date.now(),
    expiresAt: null,
    ...values,
  })

const vocabulary: EntitlementVocabulary = {
  projects: { kind: 'limit' },
  seats: { kind: 'limit' },
  ai: { kind: 'switch' },
  sso: { kind: 'switch' },
  storage_gb: { kind: 'limit' },
  api_calls: { kind: 'limit' },
}

// A plan source that always answers `catalog`, for the engine tests.
const fixedSource = (
  catalog: PlanCatalog = { plans, defaultPlan: 'free' },
): PlanSource => Object.assign(async () => catalog, { invalidate() {} })

const blueprint = {
  entitlements: vocabulary,
  plans: fixedSource(),
  roles: {
    member: ['project.read', 'project.write'],
    viewer: ['project.read'],
  },
}

beforeAll(async () => {
  for (const sql of [...createPolicySql, ...createProjectsSql]) {
    await env.DB.prepare(sql).run()
  }
})

describe('createPolicyEngine: can()', () => {
  const engine = createPolicyEngine(blueprint)
  const org = freshOrg()

  it("'*' grants every permission (default owner)", () => {
    const ctx = contextFor(org, 'owner')
    expect(engine.can(ctx, 'billing.write')).toEqual({ ok: true })
    expect(engine.can(ctx, '*')).toEqual({ ok: true })
  })

  it("'org.*' grants every org action and nothing else (default admin)", () => {
    const ctx = contextFor(org, 'admin')
    expect(engine.can(ctx, 'org.update')).toEqual({ ok: true })
    expect(engine.can(ctx, 'org.delete')).toEqual({ ok: true })
    expect(engine.can(ctx, 'billing.write')).toEqual({
      ok: false,
      reason: 'forbidden',
      permission: 'billing.write',
    })
    expect(engine.can(ctx, 'organization.update').ok).toBe(false)
  })

  it('an exact permission grants only itself', () => {
    const viewer = contextFor(org, 'viewer')
    expect(engine.can(viewer, 'project.read')).toEqual({ ok: true })
    expect(engine.can(viewer, 'project.write').ok).toBe(false)
    expect(engine.can(contextFor(org, 'admin'), 'billing.read').ok).toBe(true)
  })

  it('the blueprint overrides a default role; an unknown role has nothing', () => {
    expect(engine.can(contextFor(org, 'member'), 'project.write').ok).toBe(true)
    expect(engine.can(contextFor(org, 'ghost'), 'project.read').ok).toBe(false)
    expect(engine.can(contextFor(org, 'constructor'), 'project.read').ok).toBe(
      false,
    )
  })

  it('requirePermission throws PolicyError with the decision', () => {
    const ctx = contextFor(org, 'viewer')
    expect(() => engine.requirePermission(ctx, 'project.read')).not.toThrow()
    expect(() => engine.requirePermission(ctx, 'project.write')).toThrow(
      PolicyError,
    )
  })
})

describe('createPolicyEngine: entitled()', () => {
  // Live count of the org's projects through its repository.
  const engine = createPolicyEngine({
    ...blueprint,
    counters: {
      projects: async (ctx) => (await ctx.db.repo(projects).findMany()).length,
    },
  })
  const addProjects = async (ctx: TenantContext, count: number) => {
    for (let i = 0; i < count; i++) {
      await ctx.db.repo(projects).insert({ id: `p${i}`, name: `p${i}` })
    }
  }

  it('below the limit: ok', async () => {
    const ctx = contextFor(freshOrg())
    await addProjects(ctx, 2)
    expect(await engine.entitled(ctx, 'projects')).toEqual({ ok: true })
  })

  it('at the limit: entitlement decision with limit and current', async () => {
    const ctx = contextFor(freshOrg())
    await addProjects(ctx, 3)
    expect(await engine.entitled(ctx, 'projects')).toEqual({
      ok: false,
      reason: 'entitlement',
      key: 'projects',
      limit: 3,
      current: 3,
    })
  })

  it('counts the delta', async () => {
    const ctx = contextFor(freshOrg())
    await addProjects(ctx, 2)
    expect((await engine.entitled(ctx, 'projects', 1)).ok).toBe(true)
    expect((await engine.entitled(ctx, 'projects', 2)).ok).toBe(false)
  })

  it('-1 is unlimited whatever the count', async () => {
    const ctx = contextFor(freshOrg())
    await insertSubscription(ctx, {
      kind: 'subscription',
      plan: 'pro',
      status: 'active',
    })
    await addProjects(ctx, 4)
    expect(await engine.entitled(ctx, 'projects', 1000)).toEqual({ ok: true })
  })

  it('a boolean gate is ok only when true', async () => {
    const free = contextFor(freshOrg())
    expect(await engine.entitled(free, 'ai')).toEqual({
      ok: false,
      reason: 'entitlement',
      key: 'ai',
      limit: 0,
      current: 0,
    })
    const pro = contextFor(freshOrg())
    await insertSubscription(pro, {
      kind: 'subscription',
      plan: 'pro',
      status: 'active',
    })
    expect(await engine.entitled(pro, 'ai')).toEqual({ ok: true })
  })

  it('a key absent from the resolved values: entitlement with limit 0', async () => {
    const ctx = contextFor(freshOrg())
    expect(await engine.entitled(ctx, 'storage_gb')).toEqual({
      ok: false,
      reason: 'entitlement',
      key: 'storage_gb',
      limit: 0,
      current: 0,
    })
  })

  it('a key the vocabulary does not declare is a RangeError, not a denial', async () => {
    const ctx = contextFor(freshOrg())
    await expect(engine.entitled(ctx, 'storageGb')).rejects.toThrow(RangeError)
    await expect(engine.requireEntitlement(ctx, 'nope')).rejects.toThrow(
      RangeError,
    )
  })

  it('without a default plan, an org with no subscription has limit 0', async () => {
    const paywalled = createPolicyEngine({
      ...blueprint,
      plans: fixedSource({ plans, defaultPlan: null }),
      counters: { projects: async () => 0 },
    })
    expect(
      await paywalled.entitled(contextFor(freshOrg()), 'projects'),
    ).toEqual({
      ok: false,
      reason: 'entitlement',
      key: 'projects',
      limit: 0,
      current: 0,
    })
  })

  it('an override changes the result for its org', async () => {
    const ctx = contextFor(freshOrg())
    await addProjects(ctx, 3)
    expect((await engine.entitled(ctx, 'projects')).ok).toBe(false)
    await insertOverride(ctx, { id: 'projects', value: 10 })
    expect((await engine.entitled(ctx, 'projects')).ok).toBe(true)
  })

  it('requireEntitlement throws, and errors() answers 402 with the decision', async () => {
    const ctx = contextFor(freshOrg())
    await addProjects(ctx, 3)
    await expect(engine.requireEntitlement(ctx, 'projects')).rejects.toThrow(
      PolicyError,
    )

    const app = new Hono()
    app.onError(errors())
    app.post('/projects', async (c) => {
      await engine.requireEntitlement(ctx, 'projects')
      return c.json({ created: true }, 201)
    })
    const response = await app.request('/projects', { method: 'POST' })
    expect(response.status).toBe(402)
    expect(await response.json()).toEqual({
      error: 'entitlement',
      decision: {
        ok: false,
        reason: 'entitlement',
        key: 'projects',
        limit: 3,
        current: 3,
      },
    })
  })

  it('entitlementFlags reads boolean values and falls back for the rest', async () => {
    const ctx = contextFor(freshOrg())
    await insertSubscription(ctx, {
      kind: 'subscription',
      plan: 'pro',
      status: 'active',
    })
    const flags = await engine.entitlementFlags(ctx)
    expect(flags.getBooleanValue('ai', false)).toBe(true)
    expect(flags.getBooleanValue('projects', false)).toBe(false)
    expect(flags.getBooleanValue('unknown', true)).toBe(true)
    const freeFlags = await engine.entitlementFlags(contextFor(freshOrg()))
    expect(freeFlags.getBooleanValue('ai', true)).toBe(false)
  })
})

describe('createPolicyEngine: resolve()', () => {
  const engine = createPolicyEngine(blueprint)
  const noDefault = createPolicyEngine({
    ...blueprint,
    plans: fixedSource({ plans, defaultPlan: null }),
  })

  it('an override wins and is the source', async () => {
    const ctx = contextFor(freshOrg())
    await insertSubscription(ctx, {
      kind: 'subscription',
      plan: 'pro',
      status: 'active',
    })
    await insertOverride(ctx, { id: 'seats', value: 99 })
    expect(await engine.resolve(ctx)).toEqual({
      plan: 'pro',
      source: 'override',
      values: { ...plans.pro, seats: 99 },
      suspended: null,
    })
  })

  it('an active lifetime purchase', async () => {
    const ctx = contextFor(freshOrg())
    await insertSubscription(ctx, {
      kind: 'lifetime',
      plan: 'team',
      status: 'active',
    })
    expect(await engine.resolve(ctx)).toEqual({
      plan: 'team',
      source: 'lifetime',
      values: plans.team,
      suspended: null,
    })
  })

  it('an active subscription', async () => {
    const ctx = contextFor(freshOrg())
    await insertSubscription(ctx, {
      kind: 'subscription',
      plan: 'pro',
      status: 'active',
    })
    expect(await engine.resolve(ctx)).toEqual({
      plan: 'pro',
      source: 'subscription',
      values: plans.pro,
      suspended: null,
    })
  })

  it('a trial in progress, with its end', async () => {
    const ctx = contextFor(freshOrg())
    const now = Date.now()
    await startKernelTrial(ctx, { plan: 'team', days: 7, now })
    expect(await engine.resolve(ctx)).toEqual({
      plan: 'team',
      source: 'trial',
      values: plans.team,
      suspended: null,
      trialEndsAt: now + 7 * DAY,
    })
  })

  it('the default plan', async () => {
    const ctx = contextFor(freshOrg())
    expect(await engine.resolve(ctx)).toEqual({
      plan: 'free',
      source: 'default',
      values: plans.free,
      suspended: null,
    })
  })

  it('no plan when the catalog has no default (the paywall case)', async () => {
    const ctx = contextFor(freshOrg())
    expect(await noDefault.resolve(ctx)).toEqual({
      plan: null,
      source: 'none',
      values: {},
      suspended: null,
    })
  })
})

describe('org suspension', () => {
  const engine = createPolicyEngine(blueprint)
  const suspended = { ok: false, reason: 'suspended' } as const

  it('suspendOrg writes the one row; resolve() reports it and keeps the plan', async () => {
    const ctx = contextFor(freshOrg())
    await insertSubscription(ctx, {
      kind: 'subscription',
      plan: 'pro',
      status: 'active',
    })
    expect(await getSuspension(ctx)).toBeNull()
    expect((await loadPolicyRows(ctx)).suspension).toBeNull()
    const record = await suspendOrg(ctx, {
      reason: 'abuse report',
      adminId: 'adm-1',
      now: 1000,
    })
    expect(record).toEqual({
      reason: 'abuse report',
      adminId: 'adm-1',
      at: 1000,
      liftedAt: null,
    })
    expect(await getSuspension(ctx)).toEqual(record)
    expect((await loadPolicyRows(ctx)).suspension).toEqual({
      reason: 'abuse report',
      at: 1000,
    })
    // A gate in front of the resolver, not a source.
    expect(await engine.resolve(ctx)).toEqual({
      plan: 'pro',
      source: 'subscription',
      values: plans.pro,
      suspended: { reason: 'abuse report', at: 1000 },
    })
  })

  it('entitled() answers suspended before any limit, even unlimited', async () => {
    const ctx = contextFor(freshOrg())
    await insertSubscription(ctx, {
      kind: 'subscription',
      plan: 'pro',
      status: 'active',
    })
    expect(await engine.entitled(ctx, 'projects')).toEqual({ ok: true })
    await suspendOrg(ctx, { reason: 'r', adminId: 'adm-1' })
    expect(await engine.entitled(ctx, 'projects')).toEqual(suspended)
    expect(await engine.entitled(ctx, 'ai')).toEqual(suspended)
    // A key the blueprint does not declare is still a bug.
    await expect(engine.entitled(ctx, 'nope')).rejects.toThrow(RangeError)
  })

  it('can() stays role-only (ruled 2026-11-02)', async () => {
    const ctx = contextFor(freshOrg(), 'viewer')
    await suspendOrg(ctx, { reason: 'r', adminId: 'adm-1' })
    expect(engine.can(ctx, 'project.read')).toEqual({ ok: true })
    expect(engine.can(ctx, 'project.write').ok).toBe(false)
  })

  it('liftSuspension keeps the row with lifted_at; a later suspension replaces it', async () => {
    const ctx = contextFor(freshOrg())
    expect(await liftSuspension(ctx, 500)).toBe(false)
    await suspendOrg(ctx, { reason: 'first', adminId: 'adm-1', now: 1000 })
    expect(await liftSuspension(ctx, 2000)).toBe(true)
    expect(await liftSuspension(ctx, 2500)).toBe(false)
    expect(await getSuspension(ctx)).toEqual({
      reason: 'first',
      adminId: 'adm-1',
      at: 1000,
      liftedAt: 2000,
    })
    expect((await engine.resolve(ctx)).suspended).toBeNull()
    expect(await engine.entitled(ctx, 'seats')).toEqual({ ok: true })

    await suspendOrg(ctx, { reason: 'second', adminId: 'adm-2', now: 3000 })
    expect(await getSuspension(ctx)).toEqual({
      reason: 'second',
      adminId: 'adm-2',
      at: 3000,
      liftedAt: null,
    })
    // Suspending a suspended org replaces the reason too.
    await suspendOrg(ctx, { reason: 'third', adminId: 'adm-1', now: 4000 })
    expect((await engine.resolve(ctx)).suspended).toEqual({
      reason: 'third',
      at: 4000,
    })
    const rows = await unguarded
      .select()
      .from(orgSuspensions)
      .where(eq(orgSuspensions.orgId, ctx.orgId))
      .all()
    expect(rows).toHaveLength(1)
  })

  it("one org's suspension changes nothing for another", async () => {
    const a = contextFor(freshOrg())
    const b = contextFor(freshOrg())
    await suspendOrg(a, { reason: 'r', adminId: 'adm-1' })
    expect((await engine.resolve(b)).suspended).toBeNull()
    expect(await engine.entitled(b, 'seats')).toEqual({ ok: true })
    expect(await getSuspension(b)).toBeNull()
  })

  it('requireEntitlement throws, and errors() answers 403 with the decision', async () => {
    const ctx = contextFor(freshOrg())
    await suspendOrg(ctx, { reason: 'r', adminId: 'adm-1' })
    const app = new Hono()
    app.onError(errors({ denied: () => {} }))
    app.post('/projects', async (c) => {
      await engine.requireEntitlement(ctx, 'projects')
      return c.json({ created: true }, 201)
    })
    const response = await app.request('/projects', { method: 'POST' })
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({
      error: 'suspended',
      decision: suspended,
    })
  })
})

describe('kernel trials', () => {
  const engine = createPolicyEngine(blueprint)

  it('startKernelTrial creates one trialing row, startedAt now, and refuses a second while it runs', async () => {
    const ctx = contextFor(freshOrg())
    const now = Date.now()
    const trial = await startKernelTrial(ctx, { plan: 'pro', days: 14, now })
    expect(trial).toMatchObject({
      kind: 'subscription',
      plan: 'pro',
      status: 'trialing',
      provider: 'kernel',
      trialEndsAt: now + 14 * DAY,
      startedAt: now,
      updatedAt: now,
      orgId: ctx.orgId,
    })
    expect(await engine.entitled(ctx, 'ai')).toEqual({ ok: true })
    await expect(
      startKernelTrial(ctx, { plan: 'team', days: 7 }),
    ).rejects.toThrow(ConflictError)
    expect((await loadPolicyRows(ctx)).subscriptions).toHaveLength(1)
  })

  it.each(['active', 'trialing'] as const)(
    'startKernelTrial refuses an org with a %s provider row',
    async (status) => {
      const ctx = contextFor(freshOrg())
      await insertSubscription(ctx, {
        kind: 'subscription',
        plan: 'pro',
        status,
        provider: 'paddle',
      })
      await expect(
        startKernelTrial(ctx, { plan: 'pro', days: 14 }),
      ).rejects.toThrow(ConflictError)
      expect((await loadPolicyRows(ctx)).subscriptions).toHaveLength(1)
    },
  )

  it('startKernelTrial starts a trial after a canceled provider subscription', async () => {
    const ctx = contextFor(freshOrg())
    await insertSubscription(ctx, {
      kind: 'subscription',
      plan: 'pro',
      status: 'canceled',
      provider: 'paddle',
    })
    const now = Date.now()
    const trial = await startKernelTrial(ctx, { plan: 'team', days: 7, now })
    expect(trial).toMatchObject({
      id: 'kernel-trial',
      plan: 'team',
      status: 'trialing',
      startedAt: now,
    })
    expect(await engine.resolve(ctx)).toMatchObject({
      plan: 'team',
      source: 'trial',
    })
  })

  it('startKernelTrial refuses a non-positive or fractional length', async () => {
    const ctx = contextFor(freshOrg())
    await expect(
      startKernelTrial(ctx, { plan: 'pro', days: 0 }),
    ).rejects.toThrow(RangeError)
    await expect(
      startKernelTrial(ctx, { plan: 'pro', days: 1.5 }),
    ).rejects.toThrow(RangeError)
  })

  it('setTrialEnd moves the end, and ending it falls to the default plan', async () => {
    const ctx = contextFor(freshOrg())
    const now = Date.now()
    await startKernelTrial(ctx, { plan: 'pro', days: 14, now })
    const later = now + 30 * DAY
    expect(await setTrialEnd(ctx, later)).toBe(true)
    const [extended] = (await loadPolicyRows(ctx)).subscriptions
    expect(extended?.trialEndsAt).toBe(later)

    expect(await setTrialEnd(ctx, now - 1)).toBe(true)
    expect(await engine.entitled(ctx, 'ai')).toMatchObject({ ok: false })
  })

  it('setTrialEnd without a kernel trial in progress changes nothing', async () => {
    const ctx = contextFor(freshOrg())
    expect(await setTrialEnd(ctx, Date.now() + DAY)).toBe(false)
    await insertSubscription(ctx, {
      id: 'kernel-trial',
      kind: 'subscription',
      plan: 'pro',
      status: 'expired',
      provider: 'kernel',
      trialEndsAt: 1,
    })
    expect(await setTrialEnd(ctx, Date.now() + DAY)).toBe(false)
    const [row] = (await loadPolicyRows(ctx)).subscriptions
    expect(row?.trialEndsAt).toBe(1)
  })

  it('endKernelTrial ends the trial row now and keeps it', async () => {
    const ctx = contextFor(freshOrg())
    const started = Date.now()
    await startKernelTrial(ctx, { plan: 'pro', days: 14, now: started })
    const now = started + DAY
    expect(await endKernelTrial(ctx, { reason: 'expired', now })).toBe(true)
    expect((await loadPolicyRows(ctx)).subscriptions).toEqual([
      expect.objectContaining({
        id: 'kernel-trial',
        status: 'expired',
        trialEndsAt: now,
        updatedAt: now,
      }),
    ])
    expect(await engine.resolve(ctx)).toMatchObject({ source: 'default' })
  })

  it('endKernelTrial without a trial in progress is a no-op returning false', async () => {
    const ctx = contextFor(freshOrg())
    expect(await endKernelTrial(ctx, { reason: 'subscribed' })).toBe(false)
    expect((await loadPolicyRows(ctx)).subscriptions).toEqual([])

    await startKernelTrial(ctx, { plan: 'pro', days: 14 })
    await endKernelTrial(ctx, { reason: 'expired' })
    const [ended] = (await loadPolicyRows(ctx)).subscriptions
    expect(await endKernelTrial(ctx, { reason: 'subscribed' })).toBe(false)
    expect((await loadPolicyRows(ctx)).subscriptions).toEqual([ended])
  })

  it('after an expired trial, startKernelTrial writes the one row anew', async () => {
    const ctx = contextFor(freshOrg())
    const first = Date.now() - 30 * DAY
    await startKernelTrial(ctx, { plan: 'pro', days: 14, now: first })
    await endKernelTrial(ctx, { reason: 'expired', now: first + 14 * DAY })
    const again = Date.now()
    const trial = await startKernelTrial(ctx, {
      plan: 'team',
      days: 7,
      now: again,
    })
    expect(trial).toMatchObject({
      id: 'kernel-trial',
      plan: 'team',
      status: 'trialing',
      trialEndsAt: again + 7 * DAY,
      startedAt: again,
      updatedAt: again,
    })
    expect((await loadPolicyRows(ctx)).subscriptions).toEqual([trial])
    expect(await setTrialEnd(ctx, again + 9 * DAY)).toBe(true)
    expect(await endKernelTrial(ctx, { reason: 'expired' })).toBe(true)
  })

  it('applyProviderSubscription sets startedAt on insert and keeps it on update', async () => {
    const orgId = freshOrg()
    const ctx = contextFor(orgId)
    const record = {
      provider: 'paddle',
      providerSubscriptionId: 'sub_started',
      kind: 'subscription' as const,
      plan: 'pro',
      status: 'active' as const,
      seats: 1,
      periodEnd: null,
      trialEndsAt: null,
      cancelAt: null,
      updatedAt: 1000,
    }
    await applyProviderSubscription(unguarded, orgId, record, 5000)
    await applyProviderSubscription(
      unguarded,
      orgId,
      { ...record, seats: 2, updatedAt: 2000 },
      9000,
    )
    const [row] = (await loadPolicyRows(ctx)).subscriptions
    expect(row).toMatchObject({ seats: 2, startedAt: 5000, updatedAt: 2000 })
  })

  it('expireTrials flips only kernel trials whose end has passed', async () => {
    // Ends at 500 and 5000 ms after the epoch, before any other test's rows,
    // so expireTrials(_, 1000) can only reach the rows made here.
    const due = contextFor(freshOrg())
    const notDue = contextFor(freshOrg())
    const providerTrial = contextFor(freshOrg())
    const active = contextFor(freshOrg())
    await startKernelTrial(due, { plan: 'pro', days: 1 })
    await setTrialEnd(due, 500)
    await startKernelTrial(notDue, { plan: 'pro', days: 1 })
    await setTrialEnd(notDue, 5000)
    await insertSubscription(providerTrial, {
      kind: 'subscription',
      plan: 'pro',
      status: 'trialing',
      provider: 'paddle',
      trialEndsAt: 500,
    })
    await insertSubscription(active, {
      kind: 'subscription',
      plan: 'pro',
      status: 'active',
      provider: 'paddle',
      trialEndsAt: 500,
    })

    // The strict guard refuses the cross-org statement by design.
    await expect(expireTrials(db, 1000)).rejects.toThrow(TenantGuardError)
    expect(await expireTrials(unguarded, 1000)).toBe(1)

    const status = async (ctx: TenantContext) =>
      (await loadPolicyRows(ctx)).subscriptions[0]?.status
    expect(await status(due)).toBe('expired')
    expect(await status(notDue)).toBe('trialing')
    expect(await status(providerTrial)).toBe('trialing')
    expect(await status(active)).toBe('active')
    expect(await expireTrials(unguarded, 1000)).toBe(0)
  })
})

describe('applyProviderSubscription', () => {
  const record = (
    more: Partial<ProviderSubscriptionRecord> = {},
  ): ProviderSubscriptionRecord => ({
    provider: 'paddle',
    providerSubscriptionId: 'sub_01',
    kind: 'subscription',
    plan: 'pro',
    status: 'active',
    seats: 1,
    periodEnd: NOW + 30 * DAY,
    trialEndsAt: null,
    cancelAt: null,
    updatedAt: NOW,
    ...more,
  })
  const rows = async (ctx: TenantContext) =>
    (await loadPolicyRows(ctx)).subscriptions

  it('inserts the row keyed by provider and subscription id', async () => {
    const ctx = contextFor(freshOrg())
    expect(
      await applyProviderSubscription(unguarded, ctx.orgId, record()),
    ).toBe(true)
    expect(await rows(ctx)).toEqual([
      {
        id: 'paddle:sub_01',
        orgId: ctx.orgId,
        kind: 'subscription',
        plan: 'pro',
        status: 'active',
        seats: 1,
        periodEnd: NOW + 30 * DAY,
        trialEndsAt: null,
        cancelAt: null,
        credits: 0,
        provider: 'paddle',
        providerSubscriptionId: 'sub_01',
        updatedAt: NOW,
        // The time it was applied, not the provider's change time.
        startedAt: expect.any(Number),
      },
    ])
  })

  it('updates the row from a newer record and keeps credits', async () => {
    const ctx = contextFor(freshOrg())
    await applyProviderSubscription(unguarded, ctx.orgId, record())
    await ctx.db.repo(subscriptions).update('paddle:sub_01', { credits: 7 })
    expect(
      await applyProviderSubscription(
        unguarded,
        ctx.orgId,
        record({ seats: 3, status: 'canceled', updatedAt: NOW + 1 }),
      ),
    ).toBe(true)
    const [row] = await rows(ctx)
    expect(row).toMatchObject({
      seats: 3,
      status: 'canceled',
      credits: 7,
      updatedAt: NOW + 1,
    })
  })

  it('sets cancelAt from a scheduled cancellation, status unchanged', async () => {
    const ctx = contextFor(freshOrg())
    await applyProviderSubscription(unguarded, ctx.orgId, record())
    expect(
      await applyProviderSubscription(
        unguarded,
        ctx.orgId,
        record({ cancelAt: NOW + 30 * DAY, updatedAt: NOW + 1 }),
      ),
    ).toBe(true)
    expect((await rows(ctx))[0]).toMatchObject({
      status: 'active',
      cancelAt: NOW + 30 * DAY,
    })
  })

  it('clears cancelAt when the scheduled cancellation is removed', async () => {
    const ctx = contextFor(freshOrg())
    await applyProviderSubscription(
      unguarded,
      ctx.orgId,
      record({ cancelAt: NOW + 30 * DAY }),
    )
    expect(
      await applyProviderSubscription(
        unguarded,
        ctx.orgId,
        record({ cancelAt: null, updatedAt: NOW + 1 }),
      ),
    ).toBe(true)
    expect((await rows(ctx))[0]?.cancelAt).toBeNull()
  })

  it('ignores a record older than the row', async () => {
    const ctx = contextFor(freshOrg())
    await applyProviderSubscription(
      unguarded,
      ctx.orgId,
      record({ status: 'canceled', updatedAt: NOW + 10 }),
    )
    expect(
      await applyProviderSubscription(
        unguarded,
        ctx.orgId,
        record({ status: 'active', updatedAt: NOW }),
      ),
    ).toBe(false)
    expect((await rows(ctx))[0]?.status).toBe('canceled')
  })

  it('keeps two orgs with the same provider subscription id apart', async () => {
    const a = contextFor(freshOrg())
    const b = contextFor(freshOrg())
    await applyProviderSubscription(unguarded, a.orgId, record({ seats: 2 }))
    await applyProviderSubscription(
      unguarded,
      b.orgId,
      record({ seats: 5, updatedAt: NOW + 1 }),
    )
    expect((await rows(a)).map((r) => r.seats)).toEqual([2])
    expect((await rows(b)).map((r) => r.seats)).toEqual([5])
  })

  it('ends a kernel trial in the same batch when the row is active', async () => {
    const engine = createPolicyEngine(blueprint)
    const ctx = contextFor(freshOrg())
    await startKernelTrial(ctx, { plan: 'team', days: 14 })
    expect(await engine.resolve(ctx)).toMatchObject({ source: 'trial' })

    const now = Date.now()
    expect(
      await applyProviderSubscription(
        unguarded,
        ctx.orgId,
        record({ plan: 'pro', status: 'active', updatedAt: now }),
        now,
      ),
    ).toBe(true)

    expect(await engine.resolve(ctx)).toMatchObject({
      plan: 'pro',
      source: 'subscription',
    })
    const trial = (await rows(ctx)).find((r) => r.id === 'kernel-trial')
    expect(trial).toMatchObject({ status: 'expired', trialEndsAt: now })
    expect(await endKernelTrial(ctx, { reason: 'subscribed' })).toBe(false)
  })

  it('ends a kernel trial for a provider trial too, and not for other statuses', async () => {
    const trialing = contextFor(freshOrg())
    await startKernelTrial(trialing, { plan: 'team', days: 14 })
    await applyProviderSubscription(
      unguarded,
      trialing.orgId,
      record({ status: 'trialing', trialEndsAt: NOW + 7 * DAY }),
    )
    expect(
      (await rows(trialing)).find((r) => r.id === 'kernel-trial')?.status,
    ).toBe('expired')

    const canceled = contextFor(freshOrg())
    const trial = await startKernelTrial(canceled, { plan: 'team', days: 14 })
    await applyProviderSubscription(
      unguarded,
      canceled.orgId,
      record({ status: 'canceled' }),
    )
    expect((await rows(canceled)).find((r) => r.id === 'kernel-trial')).toEqual(
      trial,
    )
  })

  it('refuses the kernel provider id', async () => {
    const ctx = contextFor(freshOrg())
    await startKernelTrial(ctx, { plan: 'pro', days: 14 })
    await expect(
      applyProviderSubscription(
        unguarded,
        ctx.orgId,
        record({ provider: 'kernel', providerSubscriptionId: 'trial' }),
      ),
    ).rejects.toThrow(RangeError)
    expect((await rows(ctx)).map((r) => r.id)).toEqual(['kernel-trial'])
  })

  it('runs under the strict guard too, since it sets org_id itself', async () => {
    const ctx = contextFor(freshOrg())
    await startKernelTrial(ctx, { plan: 'team', days: 14 })
    expect(await applyProviderSubscription(db, ctx.orgId, record())).toBe(true)
  })
})

describe('isolation between orgs', () => {
  it('overrides and a lifetime row in org A change nothing for org B', async () => {
    const engine = createPolicyEngine(blueprint)
    const random = seeded(0x9011c7)
    const pool = ['projects', 'seats', 'ai', 'sso', 'storage_gb', 'api_calls']
    const planIds = Object.keys(plans) as (keyof typeof plans)[]

    for (let round = 0; round < 6; round++) {
      const a = contextFor(freshOrg())
      const b = contextFor(freshOrg())
      // B starts in a random state: the default plan, a subscription, or a
      // trial.
      const state = Math.floor(random() * 3)
      const bPlan = planIds[Math.floor(random() * planIds.length)] ?? 'pro'
      if (state === 1) {
        await insertSubscription(b, {
          kind: 'subscription',
          plan: bPlan,
          status: 'active',
        })
      } else if (state === 2) {
        await startKernelTrial(b, { plan: bPlan, days: 3 })
      }

      const keys = shuffle(pool, random)
      const snapshot = async () => {
        const flags = await engine.entitlementFlags(b)
        return {
          rows: await loadPolicyRows(b),
          decisions: await Promise.all(
            keys.map((key) => engine.entitled(b, key)),
          ),
          flags: keys.map((key) => flags.getBooleanValue(key, false)),
        }
      }
      const before = await snapshot()

      const aPlan = planIds[Math.floor(random() * planIds.length)] ?? 'team'
      await insertSubscription(a, {
        kind: 'lifetime',
        plan: aPlan,
        status: 'active',
      })
      for (const key of keys.slice(0, 1 + Math.floor(random() * keys.length))) {
        await insertOverride(a, {
          id: key,
          value: random() < 0.5 ? random() < 0.5 : Math.floor(random() * 100),
        })
      }

      const after = await snapshot()
      expect(after.rows).toEqual(before.rows)
      expect(after.decisions).toEqual(before.decisions)
      expect(after.flags).toEqual(before.flags)
      // A's own state did change.
      expect((await loadPolicyRows(a)).overrides.length).toBeGreaterThan(0)
    }
  })
})
