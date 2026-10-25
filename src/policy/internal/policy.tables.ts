import { sql } from 'drizzle-orm'
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'
import { tenantTable } from '@edgekits/kernel/tenancy'
import { pricePeriods } from '@edgekits/kernel/ports'
import { subscriptionKinds, subscriptionStatuses } from './model.js'

// Written only by the billing Workflow, by AdminRpc and by the kernel trial
// functions in repo.ts. Keyed by (org_id, id) (ADR-008). Timestamps are epoch
// milliseconds.
export const subscriptions = tenantTable('subscriptions', {
  id: text('id'),
  kind: text('kind', { enum: subscriptionKinds }).notNull(),
  plan: text('plan').notNull(),
  status: text('status', { enum: subscriptionStatuses }).notNull(),
  seats: integer('seats').notNull().default(1),
  periodEnd: integer('period_end'),
  trialEndsAt: integer('trial_ends_at'),
  // When a scheduled cancellation ends the subscription; null when none is
  // scheduled. The status stays as it is until the provider ends it.
  cancelAt: integer('cancel_at'),
  credits: integer('credits').notNull().default(0),
  // 'kernel' for a trial the kernel runs; otherwise the billing provider id.
  provider: text('provider'),
  providerSubscriptionId: text('provider_subscription_id'),
  updatedAt: integer('updated_at').notNull(),
})

// Per-org overrides set by an admin (ADR-006); id is the entitlement key.
// The value is a limit or a switch, stored as JSON text.
export const entitlementOverrides = tenantTable('entitlement_overrides', {
  id: text('id'),
  value: text('value', { mode: 'json' }).$type<number | boolean>().notNull(),
  reason: text('reason').notNull(),
  expiresAt: integer('expires_at'),
  adminId: text('admin_id').notNull(),
  createdAt: integer('created_at').notNull(),
})

// The plan catalog (ADR-010). Not tenant tables: a plan belongs to the
// deployment, not to an org, and is keyed by its own id. Written only by
// AdminRpc and the seed, through the functions in plans.ts; read by the
// policy engine's plan source and the pages. A plan is never deleted, only
// archived. Timestamps are epoch milliseconds.
export const plans = sqliteTable(
  'plans',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    // Entitlement key -> limit (-1 is unlimited) or switch, checked against
    // the blueprint's vocabulary when written.
    entitlements: text('entitlements', { mode: 'json' })
      .$type<Record<string, number | boolean>>()
      .notNull(),
    // The plan an org without a subscription or trial resolves to. At most
    // one plan that is not archived has it (the partial unique index below,
    // and setDefaultPlan()).
    isDefault: integer('is_default', { mode: 'boolean' })
      .notNull()
      .default(false),
    trialDays: integer('trial_days'),
    trialRequiresCard: integer('trial_requires_card', { mode: 'boolean' })
      .notNull()
      .default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    archivedAt: integer('archived_at'),
  },
  (t) => [
    uniqueIndex('plans_one_default')
      .on(t.isDefault)
      .where(sql`${t.isDefault} = 1 AND ${t.archivedAt} IS NULL`),
  ],
)

// A plan's prices at a provider; id is the provider's price id. One provider
// is active per deployment; after a provider switch a plan carries a second
// set of prices and the old ones stay for the subscriptions that use them.
export const planPrices = sqliteTable(
  'plan_prices',
  {
    id: text('id').notNull(),
    planId: text('plan_id')
      .notNull()
      .references(() => plans.id),
    provider: text('provider').notNull(),
    providerProductId: text('provider_product_id').notNull(),
    kind: text('kind', { enum: subscriptionKinds }).notNull(),
    period: text('period', { enum: pricePeriods }).notNull(),
    // Minor units of currency.
    amount: integer('amount').notNull(),
    currency: text('currency').notNull(),
    trialDays: integer('trial_days'),
    createdAt: integer('created_at').notNull(),
    archivedAt: integer('archived_at'),
  },
  (t) => [
    primaryKey({ columns: [t.provider, t.id] }),
    index('plan_prices_plan_id_idx').on(t.planId),
  ],
)
