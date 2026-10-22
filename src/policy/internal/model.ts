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
  credits: number
  provider: string | null
  providerSubscriptionId: string | null
  updatedAt: number
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
