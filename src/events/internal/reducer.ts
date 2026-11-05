import type { PlanId } from '@edgekits/kernel/tenancy'
import type { BillingEvent } from '../index.js'

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

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

// Sibling events (one provider notification, one providerEventId) are
// applied in this order: the subscription's terms first, then status
// changes, terminal statuses last; the sourceId breaks a remaining tie.
// [updated, canceled] of one notification therefore ends 'canceled' in any
// array order (audit F90).
const siblingRank: Record<BillingEvent['type'], number> = {
  'customer.linked': 0,
  'billing.rejected': 0,
  'subscription.created': 1,
  'subscription.activated': 1,
  'subscription.updated': 2,
  'subscription.scheduled_cancel': 3,
  'subscription.resumed': 3,
  'invoice.paid': 3,
  'invoice.failed': 3,
  'refund.created': 3,
  'dispute.opened': 3,
  'license.issued': 3,
  'credits.granted': 3,
  'credits.consumed': 3,
  'credits.exhausted': 3,
  'subscription.paused': 4,
  'subscription.past_due': 4,
  'subscription.canceled': 5,
  'subscription.expired': 5,
}

const byOccurrence = (a: BillingEvent, b: BillingEvent) =>
  a.occurredAt - b.occurredAt ||
  compare(a.providerEventId, b.providerEventId) ||
  siblingRank[a.type] - siblingRank[b.type] ||
  compare(a.sourceId, b.sourceId)

function apply(state: SubscriptionState, event: BillingEvent) {
  switch (event.type) {
    case 'subscription.created':
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
// are applied by (occurredAt, providerEventId, sibling rank, sourceId); a
// repeated sourceId (a redelivery of one fact) is applied once. The dedup key
// is the fact's sourceId, not the providerEventId its siblings share: keyed
// on providerEventId, only the first sibling in array order was applied
// (audit F90). appliedEventIds lists the provider event ids applied.
export function applySubscriptionEvents(
  events: readonly BillingEvent[],
): SubscriptionState {
  const state = initial()
  const seen = new Set<string>()
  const providerIds = new Set<string>()
  for (const event of [...events].sort(byOccurrence)) {
    if (seen.has(event.sourceId)) continue
    seen.add(event.sourceId)
    providerIds.add(event.providerEventId)
    apply(state, event)
  }
  state.appliedEventIds = [...providerIds].sort()
  return state
}
