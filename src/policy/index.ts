// Permissions, entitlements and the PolicyEngine with its Decision and PolicyError types.
import type { PlanId } from '@edgekits/kernel/tenancy'

export const subpath = 'policy' as const

export type Permission = `${string}.${string}` | '*' | `${string}.*`

export type EntitlementKey = string

export type Decision =
  | { ok: true }
  | { ok: false; reason: 'forbidden'; permission: Permission }
  | {
      ok: false
      reason: 'entitlement'
      key: EntitlementKey
      limit: number
      current: number
      upgradeTo?: PlanId
    }

// Thrown by helpers; mapped by /hono and /astro to 403 or 402 with a structured body.
export class PolicyError extends Error {
  override name = 'PolicyError'
  decision: Exclude<Decision, { ok: true }>

  constructor(decision: Exclude<Decision, { ok: true }>) {
    super(`Policy denied: ${decision.reason}`)
    this.decision = decision
  }
}
