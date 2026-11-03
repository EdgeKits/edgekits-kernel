import { asc, eq } from 'drizzle-orm'
import type { PlanId, TenantDatabase } from '@edgekits/kernel/tenancy'
import { getPlan, PlanError, type PlanRecord } from '../plans/repo.js'
import { settings } from '../policy.tables.js'

// The deployment's runtime settings (ADR-010). Only AdminRpc and the seed
// write them; values are JSON. Timestamps are epoch milliseconds.

// The plan a new org's trial runs on (ADR-010, ruling 2026-10-25).
export const trialPlanKey = 'billing.trialPlan'

// The currencies the SaaS sells in (ADR-010 amendment 2026-11-02): a
// non-empty list of ISO 4217 codes the active provider's capability
// manifest lists. Unset, it is defaultCurrencies.
export const currenciesKey = 'billing.currencies'
export const defaultCurrencies: readonly string[] = ['USD']

// A setting's value refused when written; issues name what is wrong.
export class SettingError extends Error {
  override name = 'SettingError'

  constructor(
    readonly key: string,
    readonly issues: readonly string[],
  ) {
    super(`Invalid setting ${key}: ${issues.join('; ')}`)
  }
}

// What is wrong with a billing.currencies value for a provider's manifest
// (its capabilities, passed in by the caller, so this subpath does not load
// a manifest): not an array, empty, an entry that is no three-letter upper
// case code, a duplicate, or a code the manifest does not list. Empty when
// it is valid.
export function currenciesIssues(
  value: unknown,
  capabilities: { readonly currencies: readonly string[] },
): string[] {
  if (!Array.isArray(value)) return ['not a list of currency codes']
  if (value.length === 0) return ['empty: name at least one currency']
  const issues: string[] = []
  const seen = new Set<string>()
  for (const code of value) {
    if (typeof code !== 'string' || !/^[A-Z]{3}$/.test(code)) {
      issues.push(`${JSON.stringify(code)} is no ISO 4217 code`)
    } else if (seen.has(code)) {
      issues.push(`${code} is listed twice`)
    } else if (!capabilities.currencies.includes(code)) {
      issues.push(`${code} is not a currency of the provider`)
    }
    if (typeof code === 'string') seen.add(code)
  }
  return issues
}

// The stored currencies, or defaultCurrencies when the key is unset (or
// holds something that is not a list of codes).
export async function getCurrencies(db: TenantDatabase): Promise<string[]> {
  const value = await getSetting(db, currenciesKey)
  return Array.isArray(value) &&
    value.length > 0 &&
    value.every((code) => typeof code === 'string')
    ? (value as string[])
    : [...defaultCurrencies]
}

// Writes billing.currencies after currenciesIssues() against the active
// provider's capabilities; SettingError with the issues otherwise, before
// anything is written.
export async function setCurrencies(
  db: TenantDatabase,
  value: unknown,
  capabilities: { readonly currencies: readonly string[] },
  now: number = Date.now(),
): Promise<void> {
  const issues = currenciesIssues(value, capabilities)
  if (issues.length > 0) throw new SettingError(currenciesKey, issues)
  await setSetting(db, currenciesKey, value, now)
}

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

// A stored setting; /admin re-exports it for AdminRpc.getSettings().
export interface SettingRecord {
  key: string
  value: unknown
  updatedAt: number
}

// Every stored setting, by key.
export async function listSettings(
  db: TenantDatabase,
): Promise<SettingRecord[]> {
  return db
    .select({
      key: settings.key,
      value: settings.value,
      updatedAt: settings.updatedAt,
    })
    .from(settings)
    .orderBy(asc(settings.key))
    .all()
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
