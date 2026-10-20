import type { PlanId } from '@edgekits/kernel/tenancy'
import type { BillingEvent } from '../index'

export type SubscriptionStatus =
  | 'none'
  | 'trialing'
  | 'active'
  | 'paused'
  | 'past_due'
  | 'canceled'
  | 'expired'

// Timestamps are epoch milliseconds; credits are units.
export interface SubscriptionState {
  plan: PlanId | null
  status: SubscriptionStatus
  seats: number
  periodEnd: number | null
  cancelAt: number | null
  credits: number
  appliedEventIds: string[]
}

const initial = (): SubscriptionState => ({
  plan: null,
  status: 'none',
  seats: 0,
  periodEnd: null,
  cancelAt: null,
  credits: 0,
  appliedEventIds: [],
})

const byOccurrence = (a: BillingEvent, b: BillingEvent) =>
  a.occurredAt - b.occurredAt ||
  (a.providerEventId < b.providerEventId
    ? -1
    : a.providerEventId > b.providerEventId
      ? 1
      : 0)

function apply(state: SubscriptionState, event: BillingEvent) {
  switch (event.type) {
    case 'subscription.activated':
      state.plan = event.plan
      state.seats = event.seats
      state.periodEnd = event.periodEnd
      state.status = event.trial ? 'trialing' : 'active'
      state.cancelAt = null
      break
    case 'subscription.updated':
      state.plan = event.plan
      state.seats = event.seats
      state.periodEnd = event.periodEnd
      break
    case 'subscription.paused':
      state.status = 'paused'
      break
    case 'subscription.resumed':
      state.status = 'active'
      break
    case 'subscription.scheduled_cancel':
      state.cancelAt = event.effectiveAt
      break
    case 'subscription.canceled':
      state.status = 'canceled'
      break
    case 'subscription.past_due':
      state.status = 'past_due'
      break
    case 'subscription.expired':
      state.status = 'expired'
      break
    case 'invoice.paid':
      if (state.status === 'past_due') state.status = 'active'
      break
    case 'credits.granted':
      state.credits += event.amount
      break
    case 'credits.consumed':
      state.credits -= event.amount
      break
    case 'credits.exhausted':
      state.credits = 0
      break
    // Recorded as applied; no subscription state of their own yet.
    case 'customer.linked':
    case 'invoice.failed':
    case 'refund.created':
    case 'dispute.opened':
    case 'license.issued':
      break
  }
}

// Pure: the same event set yields the same state in any array order. Events
// are applied by (occurredAt, providerEventId); a repeated id is applied once.
export function applySubscriptionEvents(
  events: readonly BillingEvent[],
): SubscriptionState {
  const state = initial()
  const seen = new Set<string>()
  for (const event of [...events].sort(byOccurrence)) {
    if (seen.has(event.providerEventId)) continue
    seen.add(event.providerEventId)
    apply(state, event)
  }
  state.appliedEventIds = [...seen].sort()
  return state
}
