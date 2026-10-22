import { describe, expect, expectTypeOf, it } from 'vitest'
import { z } from 'zod'
import {
  admin,
  ai,
  auth,
  billing,
  defineSaaS,
  flags,
  subpath,
  tenancy,
  validateAgainstProviders,
} from '@edgekits/kernel/config'
import { paddleCapabilities } from '@edgekits/kernel/ports'

// The blueprint example from docs/blueprint-and-ports-v0.md section 1.
const example = () => ({
  name: 'acme',
  locales: ['en', 'de', 'ja'],

  tenancy: tenancy.orgs({
    personalWorkspace: true,
    isolation: 'shared-d1',
    residency: 'none',
  }),

  auth: auth.betterAuth({
    methods: ['magic-link', 'google', 'passkey'],
    invitations: true,
  }),

  roles: {
    owner: ['*'],
    admin: ['org.*', 'members.*', 'billing.read', 'project.*'],
    member: ['project.read', 'project.write'],
    viewer: ['project.read'],
  },

  plans: {
    free: { seats: 1, projects: 3, ai: false, storageGb: 1 },
    pro: { seats: 10, projects: -1, ai: true, storageGb: 50 },
  },

  billing: billing.paddle({
    model: 'seats',
    trialDays: 14,
    currency: 'USD',
  }),

  flags: flags.kv(),

  ai: ai.gateway({
    attribution: 'per-tenant',
    byok: 'optional',
  }),

  admin: admin.worker({ access: 'cloudflare-access' }),

  modules: ['orgs', 'audit-log', 'api-keys', 'metering'],
})

const issuePaths = (input: Parameters<typeof defineSaaS>[0]) => {
  try {
    defineSaaS(input)
  } catch (error) {
    if (error instanceof z.ZodError) {
      return error.issues.map((issue) => issue.path.join('.'))
    }
    throw error
  }
  return []
}

describe('@edgekits/kernel/config', () => {
  it('exposes the public entry', () => {
    expect(subpath).toBe('config')
  })

  it('parses the section 1 example and validates it against Paddle', () => {
    const blueprint = defineSaaS(example())
    expect(blueprint.billing).toEqual({
      kind: 'paddle',
      model: 'seats',
      trialDays: 14,
      currency: 'USD',
    })
    expect(blueprint.roles.viewer).toEqual(['project.read'])
    expect(validateAgainstProviders(blueprint, paddleCapabilities)).toEqual({
      ok: true,
    })
  })

  it('fails validation for a currency the provider does not support', () => {
    const blueprint = defineSaaS({
      ...example(),
      billing: billing.paddle({ model: 'seats', currency: 'XXX' }),
    })
    const result = validateAgainstProviders(blueprint, paddleCapabilities)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.issues.map((i) => i.path)).toEqual([
      'billing.currency',
    ])
  })

  it('fails validation for a billing model the provider does not support', () => {
    expect(paddleCapabilities.models).not.toContain('credits')
    const blueprint = defineSaaS({
      ...example(),
      billing: billing.paddle({ model: 'credits', currency: 'USD' }),
    })
    const result = validateAgainstProviders(blueprint, paddleCapabilities)
    expect(!result.ok && result.issues.map((i) => i.path)).toEqual([
      'billing.model',
    ])
  })

  it('fails validation for a trial when the provider has no trials', () => {
    const blueprint = defineSaaS(example())
    const result = validateAgainstProviders(blueprint, {
      ...paddleCapabilities,
      trials: false,
    })
    expect(!result.ok && result.issues.map((i) => i.path)).toEqual([
      'billing.trialDays',
    ])
    expect(!result.ok && result.issues[0]?.message).toMatch(/trials/)
  })

  it('parses billing.trial (days default 14) and billing.products', () => {
    const blueprint = defineSaaS({
      ...example(),
      billing: billing.paddle({
        model: 'seats',
        currency: 'USD',
        trial: { requiresCard: false },
        products: {
          pri_monthly: { plan: 'pro', kind: 'subscription' },
          pri_lifetime: { plan: 'pro', kind: 'lifetime' },
        },
      }),
    })
    expect(blueprint.billing.trial).toEqual({ days: 14, requiresCard: false })
    expect(blueprint.billing.trialDays).toBe(0)
    expect(blueprint.billing.products?.pri_lifetime).toEqual({
      plan: 'pro',
      kind: 'lifetime',
    })
  })

  it('rejects a product that grants a plan not in plans', () => {
    expect(
      issuePaths({
        ...example(),
        billing: billing.paddle({
          model: 'seats',
          currency: 'USD',
          products: {
            pri_ok: { plan: 'pro', kind: 'subscription' },
            pri_gold: { plan: 'gold', kind: 'lifetime' },
          },
        }),
      }),
    ).toEqual(['billing.products.pri_gold.plan'])
  })

  it('requires trialDays and trial.days to agree when both are given', () => {
    const withTrial = (trialDays: number, days: number) => ({
      ...example(),
      billing: billing.paddle({
        model: 'seats',
        currency: 'USD',
        trialDays,
        trial: { days, requiresCard: false },
      }),
    })
    expect(issuePaths(withTrial(14, 14))).toEqual([])
    try {
      defineSaaS(withTrial(14, 7))
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(z.ZodError)
      const issues = (error as z.ZodError).issues
      expect(issues.map((issue) => issue.path.join('.'))).toEqual([
        'billing.trialDays',
      ])
      expect(issues[0]?.message).toMatch(/trialDays \(14\).*trial\.days \(7\)/)
    }
    expect(issuePaths(withTrial(0, 7))).toEqual(['billing.trialDays'])
    expect(
      issuePaths({
        ...example(),
        billing: billing.paddle({
          model: 'seats',
          currency: 'USD',
          trial: { days: 0, requiresCard: false },
        }),
      }),
    ).toEqual(['billing.trial.days'])
  })

  it('allows a card-free kernel trial with any provider', () => {
    const blueprint = defineSaaS({
      ...example(),
      billing: billing.paddle({
        model: 'seats',
        currency: 'USD',
        trialDays: 14,
        trial: { days: 14, requiresCard: false },
      }),
    })
    expect(
      validateAgainstProviders(blueprint, {
        ...paddleCapabilities,
        trials: false,
      }),
    ).toEqual({ ok: true })
  })

  it('rejects a trial that requires a card when the provider has no trials', () => {
    const blueprint = defineSaaS({
      ...example(),
      billing: billing.paddle({
        model: 'seats',
        currency: 'USD',
        trial: { requiresCard: true },
      }),
    })
    expect(validateAgainstProviders(blueprint, paddleCapabilities)).toEqual({
      ok: true,
    })
    const result = validateAgainstProviders(blueprint, {
      ...paddleCapabilities,
      trials: false,
    })
    expect(!result.ok && result.issues.map((i) => i.path)).toEqual([
      'billing.trial.requiresCard',
    ])
  })

  it('rejects a plan entitlement that is a string', () => {
    const input = example()
    expect(
      issuePaths({
        ...input,
        plans: {
          ...input.plans,
          free: { ...input.plans.free, seats: 'one' as unknown as number },
        },
      }),
    ).toEqual(['plans.free.seats'])
  })

  it('rejects malformed roles, locales, modules and billing fields', () => {
    const input = example()
    expect(issuePaths({ ...input, plans: {} })).toEqual(['plans'])
    expect(issuePaths({ ...input, roles: { viewer: ['project'] } })).toEqual([
      'roles.viewer.0',
    ])
    expect(issuePaths({ ...input, locales: [] })).toEqual(['locales'])
    expect(issuePaths({ ...input, locales: ['en', 'en'] })).toEqual(['locales'])
    expect(issuePaths({ ...input, modules: ['orgs', 'orgs'] })).toEqual([
      'modules',
    ])
    expect(
      issuePaths({
        ...input,
        billing: billing.paddle({ model: 'seats', currency: 'usd' }),
      }),
    ).toEqual(['billing.currency'])
    expect(
      issuePaths({
        ...input,
        billing: billing.paddle({
          model: 'seats',
          currency: 'USD',
          trialDays: 1.5,
        }),
      }),
    ).toEqual(['billing.trialDays'])
  })

  it('provides the default roles and lets the blueprint override them', () => {
    expect(defineSaaS({ ...example(), roles: undefined }).roles).toEqual({
      owner: ['*'],
      admin: ['org.*', 'members.*', 'billing.read'],
      member: [],
    })
    expect(defineSaaS(example()).roles.member).toEqual([
      'project.read',
      'project.write',
    ])
  })

  it('keeps plan keys and the billing provider tag in the type', () => {
    const blueprint = defineSaaS(example())
    expectTypeOf<keyof typeof blueprint.plans>().toEqualTypeOf<'free' | 'pro'>()
    expectTypeOf<keyof typeof blueprint.plans.pro>().toEqualTypeOf<
      'seats' | 'projects' | 'ai' | 'storageGb'
    >()
    expectTypeOf(blueprint.billing.kind).toEqualTypeOf<'paddle'>()
  })
})
