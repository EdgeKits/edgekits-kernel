import { integer, text } from 'drizzle-orm/sqlite-core'
import { tenantTable } from '@edgekits/kernel/tenancy'
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
