import { and, eq, isNotNull, lte } from 'drizzle-orm'
import {
  ConflictError,
  type OrgId,
  type PlanId,
  type TenantContext,
  type TenantDatabase,
} from '@edgekits/kernel/tenancy'
import {
  kernelProvider,
  type EntitlementOverrideRecord,
  type ProviderSubscriptionRecord,
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

// Why a kernel trial ends before or at its end: the org subscribed at a
// provider, or the trial ran out (ADR-012's trial phase).
export type KernelTrialEnd = 'subscribed' | 'expired'

// The statement that ends an org's kernel trial in progress: the row stays,
// expired, with trial_ends_at at the moment it ended, so the org keeps the
// record of its one trial and startKernelTrial() still refuses a second.
const endTrialStatement = (db: TenantDatabase, orgId: OrgId, now: number) =>
  db
    .update(subscriptions)
    .set({ status: 'expired', trialEndsAt: now, updatedAt: now })
    .where(
      and(
        eq(subscriptions.orgId, orgId),
        eq(subscriptions.id, kernelTrialId),
        eq(subscriptions.status, 'trialing'),
      ),
    )

// Ends the org's kernel trial now, whatever the reason (the reason is the
// caller's record; the row is the same either way, and the same as
// expireTrials() leaves). Resolves to true when a trial was in progress,
// false when the org has none (a no-op).
export async function endKernelTrial(
  ctx: TenantContext,
  options: { reason: KernelTrialEnd; now?: number },
): Promise<boolean> {
  const now = options.now ?? Date.now()
  const repo = ctx.db.repo(subscriptions)
  const row = await repo.findById(kernelTrialId)
  if (row?.status !== 'trialing') return false
  const changed = await repo.update(kernelTrialId, {
    status: 'expired',
    trialEndsAt: now,
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

// For the billing Workflow: inserts or updates the org's row for one provider
// subscription, keyed (org_id, '<provider>:<providerSubscriptionId>'). The
// org comes from the caller, never from the record. An existing row changes
// only when it belongs to the same provider and the record is not older than
// it (updatedAt), so a late Workflow cannot roll a subscription back. When
// the record is active or trialing, the same batch ends the org's kernel
// trial (endKernelTrial(), reason 'subscribed'): the provider has taken over.
// Resolves to true when the provider row was written. Every statement sets
// or names org_id itself, so it runs on a guarded or an unguarded database
// handle alike.
export async function applyProviderSubscription(
  db: TenantDatabase,
  orgId: OrgId,
  record: ProviderSubscriptionRecord,
  now: number = Date.now(),
): Promise<boolean> {
  const { provider, providerSubscriptionId } = record
  if (provider === kernelProvider || provider === '') {
    throw new RangeError(
      `applyProviderSubscription: '${provider}' is not a billing provider id`,
    )
  }
  if (providerSubscriptionId === '') {
    throw new RangeError(
      'applyProviderSubscription: providerSubscriptionId is empty',
    )
  }
  const values = {
    kind: record.kind,
    plan: record.plan,
    status: record.status,
    seats: record.seats,
    periodEnd: record.periodEnd,
    trialEndsAt: record.trialEndsAt,
    cancelAt: record.cancelAt,
    updatedAt: record.updatedAt,
  }
  const upsert = db
    .insert(subscriptions)
    .values({
      ...values,
      id: `${provider}:${providerSubscriptionId}`,
      orgId,
      provider,
      providerSubscriptionId,
    })
    .onConflictDoUpdate({
      target: [subscriptions.orgId, subscriptions.id],
      set: values,
      setWhere: and(
        eq(subscriptions.provider, provider),
        lte(subscriptions.updatedAt, record.updatedAt),
      ),
    })
  if (record.status !== 'active' && record.status !== 'trialing') {
    const result = await upsert.run()
    return result.meta.changes === 1
  }
  // D1 runs a batch as one transaction.
  const [result] = await db.batch([upsert, endTrialStatement(db, orgId, now)])
  return result.meta.changes === 1
}
