import type { PlanId } from '@edgekits/kernel/tenancy'
import type { EntitlementKey } from '../index'
import type { EntitlementOverrideRecord, SubscriptionRecord } from './model'

export type EntitlementValue = number | boolean

export type Plans = Readonly<
  Record<PlanId, Readonly<Record<EntitlementKey, EntitlementValue>>>
>

export type EntitlementSource =
  'override' | 'lifetime' | 'subscription' | 'trial' | 'free' | 'none'

export interface ResolveInput {
  plans: Plans
  subscriptions: readonly Pick<
    SubscriptionRecord,
    'kind' | 'plan' | 'status' | 'trialEndsAt' | 'updatedAt'
  >[]
  overrides: readonly Pick<
    EntitlementOverrideRecord,
    'id' | 'value' | 'expiresAt'
  >[]
  // Epoch milliseconds.
  now: number
}

export interface ResolvedEntitlements {
  // The plan the values start from, or null when no source grants one.
  plan: PlanId | null
  // The highest-priority source that contributed a value: 'override' when
  // at least one override applies, otherwise the plan's source.
  source: EntitlementSource
  values: Record<EntitlementKey, EntitlementValue>
  // Set when the plan comes from a trial.
  trialEndsAt?: number
}

type Row = ResolveInput['subscriptions'][number]

const newest = (rows: Row[]): Row | undefined =>
  rows.reduce<Row | undefined>(
    (best, row) => (!best || row.updatedAt > best.updatedAt ? row : best),
    undefined,
  )

function planSource(
  input: ResolveInput,
): { plan: PlanId; source: EntitlementSource; trialEndsAt?: number } | null {
  const { subscriptions, plans, now } = input
  const lifetime = newest(
    subscriptions.filter((r) => r.kind === 'lifetime' && r.status === 'active'),
  )
  if (lifetime) return { plan: lifetime.plan, source: 'lifetime' }
  const recurring = subscriptions.filter((r) => r.kind === 'subscription')
  const active = newest(recurring.filter((r) => r.status === 'active'))
  if (active) return { plan: active.plan, source: 'subscription' }
  const trial = newest(
    recurring.filter(
      (r) =>
        r.status === 'trialing' &&
        r.trialEndsAt !== null &&
        r.trialEndsAt > now,
    ),
  )
  if (trial?.trialEndsAt != null) {
    return { plan: trial.plan, source: 'trial', trialEndsAt: trial.trialEndsAt }
  }
  if (Object.hasOwn(plans, 'free')) return { plan: 'free', source: 'free' }
  return null
}

// Pure. Sources in order (blueprint section 3.2): an unexpired admin override
// per key (ADR-006) > an active lifetime purchase > the newest active
// subscription > the newest trial with trialEndsAt after now > the free plan
// when the blueprint declares one > nothing. Expired trials and overrides are
// skipped, never changed. A row whose plan the blueprint no longer declares
// grants no values.
export function resolveEntitlements(input: ResolveInput): ResolvedEntitlements {
  const base = planSource(input)
  const values: Record<EntitlementKey, EntitlementValue> = {
    ...(base ? input.plans[base.plan] : undefined),
  }
  let overridden = false
  for (const override of input.overrides) {
    if (override.expiresAt !== null && override.expiresAt <= input.now) continue
    values[override.id] = override.value
    overridden = true
  }
  const resolved: ResolvedEntitlements = {
    plan: base?.plan ?? null,
    source: overridden ? 'override' : (base?.source ?? 'none'),
    values,
  }
  if (base?.trialEndsAt !== undefined) resolved.trialEndsAt = base.trialEndsAt
  return resolved
}
