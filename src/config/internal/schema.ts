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

// The entitlement vocabulary (ADR-010): each key the app checks, with its
// kind. Plans live in the kernel's plans table, and their values are checked
// against this vocabulary when they are written: a limit takes a
// non-negative integer or -1 (unlimited), a switch a boolean. Keys are one
// lowercase segment, like a permission's resource.
export const entitlementKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9_-]*$/, 'Expected a lowercase key such as members')

export const entitlementsSchema = z
  .record(
    entitlementKeySchema,
    z.strictObject({ kind: z.enum(['limit', 'switch']) }),
  )
  .refine(
    (entitlements) => Object.keys(entitlements).length > 0,
    'Expected at least one entitlement',
  )

export const paddleBillingSchema = z.strictObject({
  kind: z.literal('paddle'),
  model: billingModelSchema,
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

// A bare lower-case host name with at least one dot: no scheme, port or
// path (example.com).
export const domainSchema = z
  .string()
  .regex(
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
    'Expected a lower-case domain such as example.com, without scheme or path',
  )

export const siteSchema = z.strictObject({
  // The apex domain the SaaS lives on: the x-default hreflang and the mail
  // footer use it.
  domain: domainSchema,
})

export const blueprintSchema = z
  .strictObject({
    // The slug-like id (package names, Worker names, logs).
    name: z.string().min(1),
    // The product's name for people: mail subjects, page titles. Defaults to
    // name.
    displayName: z.string().trim().min(1).optional(),
    site: siteSchema.optional(),
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
    entitlements: entitlementsSchema,
    billing: billingSchema,
    flags: flagsSchema.optional(),
    ai: aiSchema.optional(),
    admin: adminSchema.optional(),
    modules: z
      .array(z.string().min(1))
      .refine(unique, 'Modules must be unique')
      .default([]),
  })
  .transform((blueprint) => ({
    ...blueprint,
    displayName: blueprint.displayName ?? blueprint.name,
  }))
