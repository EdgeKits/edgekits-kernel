import type { SubscriptionStatus as EventStatus } from '@edgekits/kernel/events'
import type { PlanId } from '@edgekits/kernel/tenancy'

export const subscriptionKinds = ['subscription', 'lifetime'] as const
export type SubscriptionKind = (typeof subscriptionKinds)[number]

// The reducer's statuses in /events, without 'none': an org with no
// subscription has no row.
export const subscriptionStatuses = [
  'trialing',
  'active',
  'paused',
  'past_due',
  'canceled',
  'expired',
] as const satisfies readonly Exclude<EventStatus, 'none'>[]
export type SubscriptionStatus = (typeof subscriptionStatuses)[number]

// The provider of a trial the kernel runs without a card.
export const kernelProvider = 'kernel'

// Timestamps are epoch milliseconds.
export interface SubscriptionRecord {
  id: string
  kind: SubscriptionKind
  plan: PlanId
  status: SubscriptionStatus
  seats: number
  periodEnd: number | null
  trialEndsAt: number | null
  // A scheduled cancellation's effective time, or null.
  cancelAt: number | null
  credits: number
  provider: string | null
  providerSubscriptionId: string | null
  updatedAt: number
}

// A provider's subscription as the billing Workflow writes it, after it has
// re-fetched the subscription from the provider (ADR-007). updatedAt is the
// provider's own last-change time, so an older fetch never overwrites a newer
// one. Timestamps are epoch milliseconds.
export interface ProviderSubscriptionRecord {
  provider: string
  providerSubscriptionId: string
  kind: SubscriptionKind
  plan: PlanId
  status: SubscriptionStatus
  seats: number
  periodEnd: number | null
  trialEndsAt: number | null
  // The scheduled cancellation's effective time; null clears one that was
  // removed.
  cancelAt: number | null
  updatedAt: number
}

// An org's suspension row (P1-10); liftedAt is null while it is in force.
export interface SuspensionRecord {
  reason: string
  adminId: string
  at: number
  liftedAt: number | null
}

// A suspension in force, as the policy engine reports it.
export interface Suspension {
  reason: string
  at: number
}

// One override per entitlement key and org (ADR-006): id is the key.
export interface EntitlementOverrideRecord {
  id: string
  value: number | boolean
  reason: string
  expiresAt: number | null
  adminId: string
  createdAt: number
}
