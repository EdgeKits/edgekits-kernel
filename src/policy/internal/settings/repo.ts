import { eq } from 'drizzle-orm'
import type { PlanId, TenantDatabase } from '@edgekits/kernel/tenancy'
import { getPlan, PlanError, type PlanRecord } from '../plans/repo.js'
import { settings } from '../policy.tables.js'

// The deployment's runtime settings (ADR-010). Only AdminRpc and the seed
// write them; values are JSON. Timestamps are epoch milliseconds.

// The plan a new org's trial runs on (ADR-010, ruling 2026-10-25).
export const trialPlanKey = 'billing.trialPlan'

// The stored value, or null when the key has none.
export async function getSetting(
  db: TenantDatabase,
  key: string,
): Promise<unknown> {
  const row = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, key))
    .get()
  return row ? row.value : null
}

// Inserts or replaces the value of a key.
export async function setSetting(
  db: TenantDatabase,
  key: string,
  value: unknown,
  now: number = Date.now(),
): Promise<void> {
  await db
    .insert(settings)
    .values({ key, value, updatedAt: now })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value, updatedAt: now },
    })
    .run()
}

// The trial plan's row, or null when the setting is unset or names a plan
// that is missing or archived (then no org gets a trial).
export async function trialPlan(
  db: TenantDatabase,
): Promise<PlanRecord | null> {
  const id = await getSetting(db, trialPlanKey)
  if (typeof id !== 'string') return null
  const plan = await getPlan(db, id)
  return plan && plan.archivedAt === null ? plan : null
}

// Names the trial plan. Refused with PlanError('not-found') when the plan is
// missing or archived, before anything is written.
export async function setTrialPlan(
  db: TenantDatabase,
  id: PlanId,
  now: number = Date.now(),
): Promise<void> {
  const plan = await getPlan(db, id)
  if (!plan || plan.archivedAt !== null) throw new PlanError('not-found')
  await setSetting(db, trialPlanKey, id, now)
}
