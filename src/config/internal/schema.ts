import { z } from 'zod'
import {
  billingModelSchema,
  currencySchema,
  prorationModeSchema,
} from '@edgekits/kernel/ports'

const unique = (items: readonly unknown[]) =>
  new Set(items).size === items.length

// The kernel's default roles; the blueprint may override or extend them.
export const defaultRoles = {
  owner: ['*'],
  admin: ['org.*', 'members.*', 'billing.read'],
  member: [],
} as const satisfies Record<string, readonly string[]>

export const tenancySchema = z.strictObject({
  kind: z.literal('orgs'),
  personalWorkspace: z.boolean(),
  isolation: z.enum(['shared-d1', 'd1-per-tenant', 'do-per-tenant']),
  residency: z.enum(['none', 'eu', 'us']),
})

export const authSchema = z.strictObject({
  kind: z.literal('better-auth'),
  methods: z
    .array(z.string().min(1))
    .min(1)
    .refine(unique, 'Auth methods must be unique'),
  invitations: z.boolean(),
})

export const permissionSchema = z
  .string()
  .regex(
    /^(\*|[a-z][a-z0-9_-]*\.(\*|[a-z][a-z0-9_-]*))$/,
    'Expected *, <resource>.* or <resource>.<action>',
  )

const rolesSchema = z.record(z.string().min(1), z.array(permissionSchema))

// A plan maps entitlement keys to a limit (-1 means unlimited) or a switch.
const entitlementSchema = z.union([
  z
    .number()
    .refine(
      (n) => n >= 0 || n === -1,
      'Expected a non-negative limit or -1 (unlimited)',
    ),
  z.boolean(),
])

const plansSchema = z
  .record(z.string().min(1), z.record(z.string().min(1), entitlementSchema))
  .refine(
    (plans) => Object.keys(plans).length > 0,
    'Expected at least one plan',
  )

// A trial without a card is run by the kernel; with a card, by the provider.
export const trialSchema = z.strictObject({
  days: z.int().min(1).default(14),
  requiresCard: z.boolean(),
})

// Provider product ids mapped to the plan they grant and how long.
export const productsSchema = z.record(
  z.string().min(1),
  z.strictObject({
    plan: z.string().min(1),
    kind: z.enum(['subscription', 'lifetime']),
  }),
)

export const paddleBillingSchema = z.strictObject({
  kind: z.literal('paddle'),
  model: billingModelSchema,
  // Optional here so that blueprintSchema can tell a given value from the
  // default; blueprintSchema sets 0 when it is absent.
  trialDays: z.int().nonnegative().optional(),
  currency: currencySchema,
  proration: prorationModeSchema.optional(),
  trial: trialSchema.optional(),
  products: productsSchema.optional(),
})

export const billingSchema = z.discriminatedUnion('kind', [paddleBillingSchema])

export const flagsSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('kv') }),
  z.strictObject({ kind: z.literal('flagship') }),
])

export const aiSchema = z.strictObject({
  kind: z.literal('gateway'),
  attribution: z.enum(['per-tenant', 'none']),
  byok: z.enum(['none', 'optional', 'required']),
})

export const adminSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('worker'),
    access: z.literal('cloudflare-access'),
  }),
  z.strictObject({ kind: z.literal('none') }),
])

// Rules across fields: a product grants a declared plan, and trialDays and
// trial.days agree when both are given. Runs only when every field parsed.
function checkBilling(
  blueprint: {
    plans: Record<string, unknown>
    billing: z.output<typeof billingSchema>
  },
  ctx: z.RefinementCtx,
) {
  const { billing, plans } = blueprint
  for (const [productId, product] of Object.entries(billing.products ?? {})) {
    if (!Object.hasOwn(plans, product.plan)) {
      ctx.addIssue({
        code: 'custom',
        path: ['billing', 'products', productId, 'plan'],
        message: `Product ${productId} grants plan ${product.plan}, which is not in plans`,
      })
    }
  }
  if (
    billing.trialDays !== undefined &&
    billing.trial !== undefined &&
    billing.trialDays !== billing.trial.days
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['billing', 'trialDays'],
      message: `billing.trialDays (${billing.trialDays}) and billing.trial.days (${billing.trial.days}) must agree`,
    })
  }
}

export const blueprintSchema = z
  .strictObject({
    name: z.string().min(1),
    locales: z
      .array(z.string().min(1))
      .min(1)
      .refine(unique, 'Locales must be unique'),
    tenancy: tenancySchema,
    auth: authSchema,
    roles: rolesSchema
      .optional()
      .transform((roles): Record<string, string[]> => ({
        owner: [...defaultRoles.owner],
        admin: [...defaultRoles.admin],
        member: [...defaultRoles.member],
        ...roles,
      })),
    plans: plansSchema,
    billing: billingSchema,
    flags: flagsSchema.optional(),
    ai: aiSchema.optional(),
    admin: adminSchema.optional(),
    modules: z
      .array(z.string().min(1))
      .refine(unique, 'Modules must be unique')
      .default([]),
  })
  .superRefine(checkBilling)
  .transform(({ billing, ...rest }) => ({
    ...rest,
    billing: { ...billing, trialDays: billing.trialDays ?? 0 },
  }))
