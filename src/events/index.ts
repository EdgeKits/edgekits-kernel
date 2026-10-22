// Normalized billing events, InboundEvent and the EventBus.
import type { OrgId, PlanId } from '@edgekits/kernel/tenancy'

export {
  applySubscriptionEvents,
  type SubscriptionState,
  type SubscriptionStatus,
} from './internal/reducer.js'

export const subpath = 'events' as const

// A billing provider adapter id, such as 'paddle'.
export type ProviderId = string

// ISO 4217 code, three uppercase letters.
export type Currency = string

// Every event carries when it happened at the provider and the provider's
// event id; together they order events and identify duplicates.
export interface BillingEventCommon {
  occurredAt: number
  providerEventId: string
}

// Timestamps are epoch milliseconds; amounts are in the currency's minor unit.
export type BillingEvent = BillingEventCommon &
  (
    | { type: 'customer.linked'; orgId: OrgId; providerCustomerId: string }
    | {
        type: 'subscription.activated'
        orgId: OrgId
        plan: PlanId
        seats: number
        periodEnd: number
        trial: boolean
      }
    | {
        type: 'subscription.updated'
        orgId: OrgId
        plan: PlanId
        seats: number
        periodEnd: number
      }
    | { type: 'subscription.paused' }
    | { type: 'subscription.resumed' }
    | { type: 'subscription.scheduled_cancel'; effectiveAt: number }
    | { type: 'subscription.canceled' }
    | { type: 'subscription.past_due' }
    | { type: 'subscription.expired' }
    | { type: 'invoice.paid'; amount: number; currency: Currency }
    | { type: 'invoice.failed' }
    | { type: 'refund.created'; amount: number }
    | { type: 'dispute.opened' }
    | { type: 'credits.granted'; amount: number }
    | { type: 'credits.consumed'; amount: number }
    | { type: 'credits.exhausted' }
    | { type: 'license.issued'; key: string; productId: string }
  )

export interface InboundEvent<T = unknown> {
  // Dedupe key.
  providerEventId: string
  provider: ProviderId
  receivedAt: number
  // Kept for audit; never used for decisions under api_callback.
  raw: T
}
