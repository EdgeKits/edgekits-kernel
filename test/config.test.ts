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

// The blueprint example from docs/blueprint-and-ports-v0.md section 1, with
// the entitlement vocabulary of ADR-010 in place of plans.
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

  // Plans are rows of the kernel's plans table (ADR-010); the blueprint
  // names the entitlement keys and their kinds.
  entitlements: {
    seats: { kind: 'limit' as const },
    projects: { kind: 'limit' as const },
    ai: { kind: 'switch' as const },
    storage_gb: { kind: 'limit' as const },
  },

  billing: billing.paddle({
    model: 'seats',
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
      currency: 'USD',
    })
    expect(blueprint.entitlements.ai).toEqual({ kind: 'switch' })
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

  it('takes no plans, trial or product settings any more', () => {
    const input = example()
    expect(
      issuePaths({ ...input, plans: { free: { seats: 1 } } } as never),
    ).toEqual([''])
    expect(
      issuePaths({
        ...input,
        billing: { ...input.billing, trialDays: 14 },
      } as never),
    ).toEqual(['billing'])
    expect(
      issuePaths({
        ...input,
        billing: { ...input.billing, trial: { requiresCard: false } },
      } as never),
    ).toEqual(['billing'])
    expect(
      issuePaths({
        ...input,
        billing: { ...input.billing, products: {} },
      } as never),
    ).toEqual(['billing'])
  })

  it('validates the entitlement vocabulary', () => {
    const input = example()
    expect(issuePaths({ ...input, entitlements: {} })).toEqual(['entitlements'])
    expect(
      issuePaths({ ...input, entitlements: { storageGb: { kind: 'limit' } } }),
    ).toEqual(['entitlements.storageGb'])
    expect(
      issuePaths({
        ...input,
        entitlements: { 'members.max': { kind: 'limit' } },
      }),
    ).toEqual(['entitlements.members.max'])
    expect(
      issuePaths({
        ...input,
        entitlements: { members: { kind: 'number' as 'limit' } },
      }),
    ).toEqual(['entitlements.members.kind'])
    expect(
      issuePaths({
        ...input,
        entitlements: { members: { kind: 'limit', max: 3 } as never },
      }),
    ).toEqual(['entitlements.members'])
    expect(issuePaths({ ...input, entitlements: undefined } as never)).toEqual([
      'entitlements',
    ])
  })

  it('rejects malformed roles, locales, modules and billing fields', () => {
    const input = example()
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
          proration: 'later' as 'none',
        }),
      }),
    ).toEqual(['billing.proration'])
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

  it('keeps entitlement keys and kinds and the billing provider tag in the type', () => {
    const blueprint = defineSaaS({
      ...example(),
      entitlements: {
        seats: { kind: 'limit' as const },
        ai: { kind: 'switch' as const },
      },
    })
    expectTypeOf<keyof typeof blueprint.entitlements>().toEqualTypeOf<
      'seats' | 'ai'
    >()
    expectTypeOf(blueprint.entitlements.ai.kind).toEqualTypeOf<'switch'>()
    expectTypeOf(blueprint.billing.kind).toEqualTypeOf<'paddle'>()
  })
})
