import { and, eq, isNotNull, lte } from 'drizzle-orm'
import {
  ConflictError,
  type PlanId,
  type TenantContext,
  type TenantDatabase,
} from '@edgekits/kernel/tenancy'
import {
  kernelProvider,
  type EntitlementOverrideRecord,
  type SubscriptionRecord,
} from './model.js'
import { entitlementOverrides, subscriptions } from './policy.tables.js'

const DAY = 24 * 60 * 60 * 1000

// The id of the one kernel trial row an org can have; the (org_id, id) key
// refuses a second one even when two starts race.
const kernelTrialId = 'kernel-trial'

export async function loadPolicyRows(ctx: TenantContext): Promise<{
  subscriptions: SubscriptionRecord[]
  overrides: EntitlementOverrideRecord[]
}> {
  const [subscriptionRows, overrideRows] = await Promise.all([
    ctx.db.repo(subscriptions).findMany(),
    ctx.db.repo(entitlementOverrides).findMany(),
  ])
  return { subscriptions: subscriptionRows, overrides: overrideRows }
}

// Starts the card-free trial the kernel runs (blueprint billing.trial with
// requiresCard: false). Refused with ConflictError when the org already has
// any subscriptions row, trial or not.
export async function startKernelTrial(
  ctx: TenantContext,
  options: { plan: PlanId; days: number; now?: number },
): Promise<SubscriptionRecord> {
  const { plan, days, now = Date.now() } = options
  if (!Number.isInteger(days) || days < 1) {
    throw new RangeError(
      `startKernelTrial: days must be an integer >= 1, got ${days}`,
    )
  }
  const repo = ctx.db.repo(subscriptions)
  if ((await repo.findMany()).length > 0) {
    throw new ConflictError('subscriptions')
  }
  return repo.insert({
    id: kernelTrialId,
    kind: 'subscription',
    plan,
    status: 'trialing',
    trialEndsAt: now + days * DAY,
    provider: kernelProvider,
    updatedAt: now,
  })
}

// Moves the end of the org's kernel trial: extend, shorten, or end it now.
// Provider trials are the billing Workflow's. Resolves to false when the org
// has no kernel trial in progress.
export async function setTrialEnd(
  ctx: TenantContext,
  at: number,
  now: number = Date.now(),
): Promise<boolean> {
  const repo = ctx.db.repo(subscriptions)
  const row = await repo.findById(kernelTrialId)
  if (row?.status !== 'trialing') return false
  const changed = await repo.update(kernelTrialId, {
    trialEndsAt: at,
    updatedAt: now,
  })
  return changed === 1
}

// For a scheduled job: marks every kernel trial whose end has passed as
// expired, across all orgs, and resolves to the number of rows changed. This
// is the kernel's one statement on a tenant table without an org_id
// predicate, so it takes a database handle without the strict tenant guard
// (which refuses it by design). Provider trials end through billing events.
export async function expireTrials(
  db: TenantDatabase,
  now: number,
): Promise<number> {
  const result = await db
    .update(subscriptions)
    .set({ status: 'expired', updatedAt: now })
    .where(
      and(
        eq(subscriptions.provider, kernelProvider),
        eq(subscriptions.status, 'trialing'),
        isNotNull(subscriptions.trialEndsAt),
        lte(subscriptions.trialEndsAt, now),
      ),
    )
    .run()
  return result.meta.changes
}
