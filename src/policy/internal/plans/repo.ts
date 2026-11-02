import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { PricePeriod } from '@edgekits/kernel/ports'
import {
  ConflictError,
  type PlanId,
  type TenantDatabase,
} from '@edgekits/kernel/tenancy'
import type { EntitlementKey } from '../../index.js'
import type { SubscriptionKind, SubscriptionStatus } from '../model.js'
import { planPrices, plans, subscriptions } from '../policy.tables.js'
import type { EntitlementValue, Plans } from '../resolver.js'

// The plan catalog's repository (ADR-010). Only AdminRpc and the seed write
// these tables; the policy engine's plan source and the pages read them.
// Plans and prices are never deleted, only archived. Timestamps are epoch
// milliseconds.

export type EntitlementKind = 'limit' | 'switch'

// The blueprint's entitlements: key -> kind.
export type EntitlementVocabulary = Readonly<
  Record<EntitlementKey, { readonly kind: EntitlementKind }>
>

export interface PlanTrial {
  days: number
  requiresCard: boolean
}

export interface PlanPriceRecord {
  // The provider's price id.
  id: string
  planId: PlanId
  provider: string
  providerProductId: string
  kind: SubscriptionKind
  period: PricePeriod
  // Minor units of currency.
  amount: number
  currency: string
  trialDays: number | null
  createdAt: number
  archivedAt: number | null
}

export interface PlanRecord {
  id: PlanId
  name: string
  entitlements: Record<EntitlementKey, EntitlementValue>
  isDefault: boolean
  trial: PlanTrial | null
  sortOrder: number
  createdAt: number
  updatedAt: number
  archivedAt: number | null
  prices: PlanPriceRecord[]
}

export type NewPlanPrice = Omit<
  PlanPriceRecord,
  'planId' | 'trialDays' | 'createdAt' | 'archivedAt'
> & { trialDays?: number | null }

export interface NewPlan {
  id: PlanId
  name: string
  entitlements: Record<EntitlementKey, EntitlementValue>
  // Makes this the default plan and clears the flag on any other.
  isDefault?: boolean
  trial?: PlanTrial | null
  sortOrder?: number
  prices?: readonly NewPlanPrice[]
}

export type PlanPatch = Partial<
  Pick<NewPlan, 'name' | 'entitlements' | 'trial' | 'sortOrder'>
>

// A catalog write the repository refuses: values that do not fit the
// vocabulary or the catalog's rules ('invalid', with the reasons), or a plan
// that does not exist or is archived ('not-found'). /hono maps it to 400 or
// 404.
export class PlanError extends Error {
  override name = 'PlanError'

  constructor(
    readonly reason: 'invalid' | 'not-found',
    readonly issues: readonly string[] = [],
  ) {
    super(
      reason === 'invalid'
        ? `Invalid plan: ${issues.join('; ')}`
        : 'No such plan, or the plan is archived',
    )
  }
}

// The subscription states that keep a plan in use; archivePlan() refuses
// while any row has one of them.
const inUse = [
  'active',
  'trialing',
  'past_due',
  'paused',
] as const satisfies readonly SubscriptionStatus[]

const PLAN_ID = /^[a-z][a-z0-9_-]{0,63}$/
const CURRENCY = /^[A-Z]{3}$/

// What the vocabulary refuses in a plan's entitlement values: a key it does
// not declare, a limit that is not a non-negative integer or -1, a switch
// that is not a boolean. Empty when the values fit.
export function planEntitlementIssues(
  vocabulary: EntitlementVocabulary,
  entitlements: Readonly<Record<string, unknown>>,
): string[] {
  const issues: string[] = []
  for (const [key, value] of Object.entries(entitlements)) {
    const entry = Object.hasOwn(vocabulary, key) ? vocabulary[key] : undefined
    if (!entry) {
      issues.push(`entitlement ${key} is not in the blueprint`)
    } else if (entry.kind === 'limit') {
      if (
        typeof value !== 'number' ||
        !Number.isSafeInteger(value) ||
        value < -1
      ) {
        issues.push(
          `entitlement ${key} is a limit: a non-negative integer or -1`,
        )
      }
    } else if (typeof value !== 'boolean') {
      issues.push(`entitlement ${key} is a switch: true or false`)
    }
  }
  return issues
}

const wholeNumber = (n: unknown, min: number) =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= min

// Everything createPlan() (or updatePlan(), for a partial input) refuses in
// its input, without writing: for a caller that must validate before calling
// a provider. Empty when the input fits.
export function planInputIssues(
  vocabulary: EntitlementVocabulary,
  input: Partial<NewPlan>,
): string[] {
  const issues: string[] = []
  if (input.id !== undefined && !PLAN_ID.test(input.id)) {
    issues.push('id: lowercase letters, digits, - and _, at most 64')
  }
  if (input.name !== undefined && !/^(?=.*\S).{1,200}$/s.test(input.name)) {
    issues.push('name: 1 to 200 characters, not blank')
  }
  if (input.entitlements !== undefined) {
    issues.push(...planEntitlementIssues(vocabulary, input.entitlements))
  }
  if (input.trial && !wholeNumber(input.trial.days, 1)) {
    issues.push('trial.days: an integer of at least 1')
  }
  if (input.sortOrder !== undefined && !wholeNumber(input.sortOrder, 0)) {
    issues.push('sortOrder: a non-negative integer')
  }
  for (const price of input.prices ?? []) issues.push(...priceIssues(price))
  return issues
}

function priceIssues(price: NewPlanPrice): string[] {
  const issues: string[] = []
  const at = `price ${price.id}`
  if (price.id === '' || price.provider === '') {
    issues.push(`${at}: id and provider must not be empty`)
  }
  if (price.providerProductId === '') {
    issues.push(`${at}: providerProductId must not be empty`)
  }
  if ((price.kind === 'lifetime') !== (price.period === 'once')) {
    issues.push(
      `${at}: a lifetime price bills once, a subscription monthly or yearly`,
    )
  }
  if (!wholeNumber(price.amount, 0)) {
    issues.push(`${at}: amount is a non-negative integer in minor units`)
  }
  if (!CURRENCY.test(price.currency)) {
    issues.push(`${at}: currency is an ISO 4217 code`)
  }
  if (price.trialDays != null && !wholeNumber(price.trialDays, 1)) {
    issues.push(`${at}: trialDays is an integer of at least 1`)
  }
  return issues
}

const assertValid = (issues: string[]) => {
  if (issues.length > 0) throw new PlanError('invalid', issues)
}

// D1 reports a uniqueness violation as "UNIQUE constraint failed", wrapped by
// Drizzle as the cause of its error.
function isUniqueViolation(error: unknown): boolean {
  for (let e = error; e instanceof Error; e = e.cause) {
    if (/UNIQUE constraint failed/.test(e.message)) return true
  }
  return false
}

type PlanRow = typeof plans.$inferSelect
type PriceRow = typeof planPrices.$inferSelect

const toPrice = (row: PriceRow): PlanPriceRecord => ({ ...row })

const toPlan = (row: PlanRow, prices: PriceRow[]): PlanRecord => ({
  id: row.id,
  name: row.name,
  entitlements: row.entitlements,
  isDefault: row.isDefault,
  trial:
    row.trialDays === null
      ? null
      : { days: row.trialDays, requiresCard: row.trialRequiresCard },
  sortOrder: row.sortOrder,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  archivedAt: row.archivedAt,
  prices: prices.filter((p) => p.planId === row.id).map(toPrice),
})

const priceValues = (planId: PlanId, price: NewPlanPrice, now: number) => ({
  id: price.id,
  planId,
  provider: price.provider,
  providerProductId: price.providerProductId,
  kind: price.kind,
  period: price.period,
  amount: price.amount,
  currency: price.currency,
  trialDays: price.trialDays ?? null,
  createdAt: now,
})

// The plans in display order (sort order, then id), each with its prices.
// Archived plans and prices are left out unless includeArchived is set.
export async function listPlans(
  db: TenantDatabase,
  options: { includeArchived?: boolean } = {},
): Promise<PlanRecord[]> {
  const all = options.includeArchived === true
  const [planRows, priceRows] = await Promise.all([
    db
      .select()
      .from(plans)
      .where(all ? undefined : isNull(plans.archivedAt))
      .orderBy(asc(plans.sortOrder), asc(plans.id))
      .all(),
    db
      .select()
      .from(planPrices)
      .where(all ? undefined : isNull(planPrices.archivedAt))
      .orderBy(asc(planPrices.createdAt), asc(planPrices.id))
      .all(),
  ])
  return planRows.map((row) => toPlan(row, priceRows))
}

// One plan, archived or not, with all its prices; null when there is none.
export async function getPlan(
  db: TenantDatabase,
  id: PlanId,
): Promise<PlanRecord | null> {
  const [row, priceRows] = await Promise.all([
    db.select().from(plans).where(eq(plans.id, id)).get(),
    db
      .select()
      .from(planPrices)
      .where(eq(planPrices.planId, id))
      .orderBy(asc(planPrices.createdAt), asc(planPrices.id))
      .all(),
  ])
  return row ? toPlan(row, priceRows) : null
}

// Creates a plan with its prices in one batch (D1 runs a batch as one
// transaction). With isDefault, the same batch first clears the flag on any
// other plan. Refused with PlanError('invalid') before any write when a value
// does not fit the vocabulary, and with ConflictError when the plan id or a
// price (provider, id) exists already.
export async function createPlan(
  db: TenantDatabase,
  vocabulary: EntitlementVocabulary,
  input: NewPlan,
  now: number = Date.now(),
): Promise<PlanRecord> {
  assertValid(planInputIssues(vocabulary, input))
  const isDefault = input.isDefault === true
  const insertPlan = db.insert(plans).values({
    id: input.id,
    name: input.name,
    entitlements: input.entitlements,
    isDefault,
    trialDays: input.trial?.days ?? null,
    trialRequiresCard: input.trial?.requiresCard ?? false,
    sortOrder: input.sortOrder ?? 0,
    createdAt: now,
    updatedAt: now,
  })
  const prices = (input.prices ?? []).map((price) =>
    db.insert(planPrices).values(priceValues(input.id, price, now)),
  )
  try {
    if (isDefault) {
      await db.batch([clearDefault(db, now), insertPlan, ...prices])
    } else {
      await db.batch([insertPlan, ...prices])
    }
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    const taken = (await getPlan(db, input.id)) !== null
    throw new ConflictError(taken ? 'plans' : 'plan_prices')
  }
  const created = await getPlan(db, input.id)
  if (!created) throw new Error(`createPlan: plan ${input.id} not written`)
  return created
}

const clearDefault = (db: TenantDatabase, now: number) =>
  db
    .update(plans)
    .set({ isDefault: false, updatedAt: now })
    .where(eq(plans.isDefault, true))

// Changes a plan that is not archived. Its id, default flag and prices
// change through their own functions.
export async function updatePlan(
  db: TenantDatabase,
  vocabulary: EntitlementVocabulary,
  id: PlanId,
  patch: PlanPatch,
  now: number = Date.now(),
): Promise<PlanRecord> {
  assertValid(planInputIssues(vocabulary, patch))
  const result = await db
    .update(plans)
    .set({
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.entitlements === undefined
        ? {}
        : { entitlements: patch.entitlements }),
      ...(patch.trial === undefined
        ? {}
        : {
            trialDays: patch.trial?.days ?? null,
            trialRequiresCard: patch.trial?.requiresCard ?? false,
          }),
      ...(patch.sortOrder === undefined ? {} : { sortOrder: patch.sortOrder }),
      updatedAt: now,
    })
    .where(and(eq(plans.id, id), isNull(plans.archivedAt)))
    .run()
  if (result.meta.changes === 0) throw new PlanError('not-found')
  const updated = await getPlan(db, id)
  if (!updated) throw new PlanError('not-found')
  return updated
}

// Makes `id` the one default plan, or clears the default with null. One
// batch: the flag is cleared on every other plan only when `id` names a plan
// that is not archived, then set on it, so the catalog never holds two
// defaults (the partial unique index plans_one_default refuses a second
// one besides) and a refused call changes nothing. PlanError('not-found')
// for an unknown or archived plan.
export async function setDefaultPlan(
  db: TenantDatabase,
  id: PlanId | null,
  now: number = Date.now(),
): Promise<void> {
  if (id === null) {
    await clearDefault(db, now).run()
    return
  }
  const usable = sql`exists (select 1 from ${plans} where ${plans.id} = ${id} and ${plans.archivedAt} is null)`
  const [, set] = await db.batch([
    db
      .update(plans)
      .set({ isDefault: false, updatedAt: now })
      .where(and(eq(plans.isDefault, true), sql`${plans.id} <> ${id}`, usable)),
    db
      .update(plans)
      .set({ isDefault: true, updatedAt: now })
      .where(and(eq(plans.id, id), isNull(plans.archivedAt))),
  ])
  if (set.meta.changes === 0) throw new PlanError('not-found')
}

// Archives a plan and its prices in one batch, and clears its default flag.
// Refused with ConflictError('subscriptions') while any org has a
// subscriptions row on the plan that is active, trialing, past_due or
// paused; the check is part of the archiving statement, so a subscription
// written meanwhile cannot slip between them. That check reads every org's
// rows, so pass a database handle without the strict tenant guard (as for
// expireTrials). Archiving an archived plan changes nothing. Resolves to the
// plan with all its prices, for the caller to archive them at the provider.
export async function archivePlan(
  db: TenantDatabase,
  id: PlanId,
  now: number = Date.now(),
): Promise<PlanRecord> {
  const subscribed = sql`exists (select 1 from ${subscriptions} where ${subscriptions.plan} = ${id} and ${inArray(subscriptions.status, [...inUse])})`
  const [archived] = await db.batch([
    db
      .update(plans)
      .set({ archivedAt: now, isDefault: false, updatedAt: now })
      .where(
        and(eq(plans.id, id), isNull(plans.archivedAt), sql`not ${subscribed}`),
      ),
    db
      .update(planPrices)
      .set({ archivedAt: now })
      .where(
        and(
          eq(planPrices.planId, id),
          isNull(planPrices.archivedAt),
          sql`exists (select 1 from ${plans} where ${plans.id} = ${id} and ${plans.archivedAt} = ${now})`,
        ),
      ),
  ])
  const plan = await getPlan(db, id)
  if (!plan) throw new PlanError('not-found')
  if (archived.meta.changes === 0 && plan.archivedAt === null) {
    throw new ConflictError('subscriptions')
  }
  return plan
}

// Restores an archived plan (ADR-010 amendment 2026-11-02: archiving is
// reversible): clears its archivedAt, and that of the prices archived with
// it (the same archivedAt); a price archived on its own before stays
// archived. The default flag that archiving cleared is not set again
// (setDefaultPlan). Restoring a plan that is not archived changes nothing.
// PlanError('not-found') for an unknown plan. Resolves to the plan with all
// its prices, for the caller to restore the restored ones at the provider.
export async function restorePlan(
  db: TenantDatabase,
  id: PlanId,
  now: number = Date.now(),
): Promise<PlanRecord> {
  const before = await getPlan(db, id)
  if (!before) throw new PlanError('not-found')
  const archivedAt = before.archivedAt
  if (archivedAt === null) return before
  await db.batch([
    db
      .update(planPrices)
      .set({ archivedAt: null })
      .where(
        and(eq(planPrices.planId, id), eq(planPrices.archivedAt, archivedAt)),
      ),
    db
      .update(plans)
      .set({ archivedAt: null, updatedAt: now })
      .where(and(eq(plans.id, id), eq(plans.archivedAt, archivedAt))),
  ])
  const plan = await getPlan(db, id)
  if (!plan) throw new PlanError('not-found')
  return plan
}

// Adds a price to a plan that is not archived. ConflictError when the
// provider already has a price with that id in the catalog.
export async function addPrice(
  db: TenantDatabase,
  planId: PlanId,
  price: NewPlanPrice,
  now: number = Date.now(),
): Promise<PlanPriceRecord> {
  assertValid(priceIssues(price))
  const plan = await db
    .select({ archivedAt: plans.archivedAt })
    .from(plans)
    .where(eq(plans.id, planId))
    .get()
  if (!plan || plan.archivedAt !== null) throw new PlanError('not-found')
  try {
    const row = await db
      .insert(planPrices)
      .values(priceValues(planId, price, now))
      .returning()
      .get()
    return toPrice(row)
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError('plan_prices')
    throw error
  }
}

// Archives one price; resolves to false when it is unknown or archived
// already. Subscriptions on it keep resolving to its plan.
export async function archivePrice(
  db: TenantDatabase,
  provider: string,
  id: string,
  now: number = Date.now(),
): Promise<boolean> {
  const result = await db
    .update(planPrices)
    .set({ archivedAt: now })
    .where(
      and(
        eq(planPrices.provider, provider),
        eq(planPrices.id, id),
        isNull(planPrices.archivedAt),
      ),
    )
    .run()
  return result.meta.changes === 1
}

// The price a checkout sells for a plan: the newest price of the provider
// and period that is not archived, on a plan that is not archived; null when
// there is none.
export async function priceForPlan(
  db: TenantDatabase,
  provider: string,
  planId: PlanId,
  period: PricePeriod,
): Promise<PlanPriceRecord | null> {
  const row = await db
    .select({ price: planPrices })
    .from(planPrices)
    .innerJoin(plans, eq(plans.id, planPrices.planId))
    .where(
      and(
        eq(planPrices.provider, provider),
        eq(planPrices.planId, planId),
        eq(planPrices.period, period),
        isNull(planPrices.archivedAt),
        isNull(plans.archivedAt),
      ),
    )
    .orderBy(desc(planPrices.createdAt), desc(planPrices.id))
    .get()
  return row ? toPrice(row.price) : null
}

// The plan a provider's price grants, archived or not: a subscription keeps
// its plan after the price is archived. Null for a price not in the catalog.
export async function planForPrice(
  db: TenantDatabase,
  provider: string,
  priceId: string,
): Promise<PlanId | null> {
  const row = await db
    .select({ planId: planPrices.planId })
    .from(planPrices)
    .where(and(eq(planPrices.provider, provider), eq(planPrices.id, priceId)))
    .get()
  return row?.planId ?? null
}

export interface PlanCatalog {
  // Every plan's values, archived plans included: a subscription on an
  // archived plan keeps its values.
  plans: Plans
  // The plan that is not archived and has the default flag, or null.
  defaultPlan: PlanId | null
}

export async function loadPlanCatalog(
  db: TenantDatabase,
): Promise<PlanCatalog> {
  const rows = await db
    .select({
      id: plans.id,
      entitlements: plans.entitlements,
      isDefault: plans.isDefault,
      archivedAt: plans.archivedAt,
    })
    .from(plans)
    .all()
  const values: Record<PlanId, Record<EntitlementKey, EntitlementValue>> = {}
  let defaultPlan: PlanId | null = null
  for (const row of rows) {
    values[row.id] = row.entitlements
    if (row.isDefault && row.archivedAt === null) defaultPlan = row.id
  }
  return { plans: values, defaultPlan }
}

// The catalog as the policy engine reads it: loaded once and kept for ttlMs
// in this isolate (a module-level source lives as long as the isolate).
// invalidate() drops it, so the next call reloads; the catalog code calls it
// after every write. Concurrent calls share one load.
export interface PlanSource {
  (): Promise<PlanCatalog>
  invalidate(): void
}

export function planSource(
  db: TenantDatabase,
  options: { ttlMs?: number; now?: () => number } = {},
): PlanSource {
  const { ttlMs = 60_000, now = Date.now } = options
  let cached: { at: number; catalog: Promise<PlanCatalog> } | null = null
  const source = (() => {
    const at = now()
    if (cached && at - cached.at < ttlMs) return cached.catalog
    const entry = { at, catalog: loadPlanCatalog(db) }
    cached = entry
    // A failed load is not kept.
    entry.catalog.catch(() => {
      if (cached === entry) cached = null
    })
    return entry.catalog
  }) as PlanSource
  source.invalidate = () => {
    cached = null
  }
  return source
}
