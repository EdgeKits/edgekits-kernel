// defineSaaS(), provider capability validation, the env schema (defineEnv,
// composeEnv, checkEnv, parseEnv) and the binding emitters.
import type { z } from 'zod'
import { blueprintSchema, type defaultRoles } from './internal/schema.js'

export {
  blueprintSchema,
  defaultRoles,
  entitlementKeySchema,
  entitlementsSchema,
  permissionSchema,
} from './internal/schema.js'
export {
  admin,
  ai,
  auth,
  billing,
  flags,
  tenancy,
} from './internal/factories.js'
export {
  boolean,
  checkEnv,
  composeEnv,
  defineEnv,
  email,
  EnvError,
  EnvVar,
  json,
  number,
  oneOf,
  parseEnv,
  string,
  url,
  type ComposedEnv,
  type EnvCheckResult,
  type EnvFragment,
  type EnvIssue,
  type EnvOutput,
  type EnvPresence,
  type EnvShape,
  type StandardSchema,
} from './internal/env.js'
export {
  validateAgainstProviders,
  type ValidationIssue,
  type ValidationResult,
} from './internal/validate.js'

export const subpath = 'config' as const

export type BlueprintInput = z.input<typeof blueprintSchema>
type ParsedBlueprint = z.output<typeof blueprintSchema>
type RoleKey<T> = T extends { roles: infer R } ? keyof R & string : never

// The parsed blueprint, keeping the entitlement keys and kinds, role names
// and billing provider of the input it came from. It holds no plans: they
// are rows in the kernel's plans table (ADR-010).
export type Blueprint<T extends BlueprintInput = BlueprintInput> = Omit<
  ParsedBlueprint,
  'entitlements' | 'roles' | 'billing'
> & {
  entitlements: {
    [K in keyof T['entitlements']]: { kind: T['entitlements'][K]['kind'] }
  }
  roles: Record<keyof typeof defaultRoles | RoleKey<T>, string[]>
  billing: Extract<ParsedBlueprint['billing'], { kind: T['billing']['kind'] }>
}

// Parses the blueprint and throws a ZodError when it does not match the
// schema. Provider capabilities are checked separately by
// validateAgainstProviders().
export function defineSaaS<T extends BlueprintInput>(input: T): Blueprint<T> {
  return blueprintSchema.parse(input) as Blueprint<T>
}
