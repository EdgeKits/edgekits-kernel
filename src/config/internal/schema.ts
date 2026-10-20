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

export const paddleBillingSchema = z.strictObject({
  kind: z.literal('paddle'),
  model: billingModelSchema,
  trialDays: z.int().nonnegative().default(0),
  currency: currencySchema,
  proration: prorationModeSchema.optional(),
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

export const blueprintSchema = z.strictObject({
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
