// defineSaaS(), provider capability validation and the binding and env schema emitters.
import type { z } from 'zod'
import { blueprintSchema, type defaultRoles } from './internal/schema'

export { blueprintSchema, permissionSchema } from './internal/schema'
export { admin, ai, auth, billing, flags, tenancy } from './internal/factories'
export {
  validateAgainstProviders,
  type ValidationIssue,
  type ValidationResult,
} from './internal/validate'

export const subpath = 'config' as const

export type BlueprintInput = z.input<typeof blueprintSchema>
type ParsedBlueprint = z.output<typeof blueprintSchema>
type RoleKey<T> = T extends { roles: infer R } ? keyof R & string : never

// The parsed blueprint, keeping the plan keys, entitlement keys, role names
// and billing provider of the input it came from.
export type Blueprint<T extends BlueprintInput = BlueprintInput> = Omit<
  ParsedBlueprint,
  'plans' | 'roles' | 'billing'
> & {
  plans: {
    [P in keyof T['plans']]: { [E in keyof T['plans'][P]]: number | boolean }
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
