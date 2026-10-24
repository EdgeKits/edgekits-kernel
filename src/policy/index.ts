// Permissions, entitlements and the PolicyEngine with its Decision and PolicyError types.
import type { PlanId } from '@edgekits/kernel/tenancy'

export {
  createPolicyEngine,
  type EntitlementCounter,
  type EntitlementFlags,
  type PolicyBlueprint,
  type PolicyEngine,
} from './internal/engine.js'
export { PolicyError } from './internal/errors.js'
// The policy tables, for a schema package's migrations; queried only through
// the repositories in this subpath.
export {
  entitlementOverrides,
  subscriptions,
} from './internal/policy.tables.js'
export {
  kernelProvider,
  subscriptionKinds,
  subscriptionStatuses,
  type EntitlementOverrideRecord,
  type ProviderSubscriptionRecord,
  type SubscriptionKind,
  type SubscriptionRecord,
  type SubscriptionStatus,
} from './internal/model.js'
export {
  applyProviderSubscription,
  expireTrials,
  loadPolicyRows,
  setTrialEnd,
  startKernelTrial,
} from './internal/repo.js'
export {
  resolveEntitlements,
  type EntitlementSource,
  type EntitlementValue,
  type Plans,
  type ResolvedEntitlements,
  type ResolveInput,
} from './internal/resolver.js'

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
