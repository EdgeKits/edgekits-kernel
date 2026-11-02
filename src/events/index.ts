// The kit's event vocabulary (KernelEvent: billing, organization and
// lifecycle events), InboundEvent and the EventBus.
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

// Every event names its org, says when it happened (epoch milliseconds) and
// carries sourceId: the idempotency key of the fact itself, the same on every
// delivery and every retry of one fact, distinct between two facts.
export interface KernelEventCommon {
  orgId: OrgId
  occurredAt: number
  sourceId: string
}

// Who caused an event, as `actorId: string`: a user id, `system:<module>`
// for the kit itself (such as 'system:lifecycle'), or `provider:<id>` for a
// billing provider (such as 'provider:paddle'). Billing events carry no
// actorId: their actor is the provider that sent them.

// Billing events also carry the provider's event id; with occurredAt it
// orders events and identifies duplicates in the reducer. Their sourceId is
// the provider's event id plus the event type, so one notification that maps
// to several events keeps one key per event.
export interface BillingEventCommon extends KernelEventCommon {
  providerEventId: string
}

// Timestamps are epoch milliseconds; amounts are in the currency's minor unit.
export type BillingEvent = BillingEventCommon &
  (
    | { type: 'customer.linked'; providerCustomerId: string }
    // The provider created the subscription; same payload as activated.
    | {
        type: 'subscription.created'
        plan: PlanId
        seats: number
        periodEnd: number
        trial: boolean
      }
    | {
        type: 'subscription.activated'
        plan: PlanId
        seats: number
        periodEnd: number
        trial: boolean
      }
    | {
        type: 'subscription.updated'
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

// Organization events: the actor is the signed-in user who acted. userId
// and memberId name the member acted upon; for member.left the actor and the
// subject are the same user.
export type OrgEvent = KernelEventCommon & { actorId: string } & (
    | { type: 'org.created' }
    | {
        type: 'member.invited'
        invitationId: string
        email: string
        role: string
      }
    | { type: 'member.joined'; userId: string; memberId: string; role: string }
    | {
        type: 'member.role_changed'
        userId: string
        memberId: string
        role: string
        previousRole: string
      }
    | { type: 'member.removed'; userId: string; memberId: string }
    | { type: 'member.left'; userId: string; memberId: string }
  )

// The organization lifecycle (ADR-012): the actor is the kit, the id the
// lifecycle Workflow uses for its tenant context.
export type LifecycleEvent = KernelEventCommon & {
  actorId: 'system:lifecycle'
} & (
    | { type: 'trial.started'; plan: PlanId; endsAt: number }
    | { type: 'trial.subscribed'; plan: PlanId }
    | { type: 'trial.expired'; plan: PlanId }
  )

export type KernelEvent = BillingEvent | OrgEvent | LifecycleEvent

export interface InboundEvent<T = unknown> {
  // Dedupe key.
  providerEventId: string
  provider: ProviderId
  receivedAt: number
  // Kept for audit; never used for decisions under api_callback.
  raw: T
}

// Where events go once the fact they record is written: the audit log
// (P1-09) is the first subscriber. publish() is often called from a Workflow
// step, so it may run more than once for one event; a subscriber therefore
// dedupes on the event's sourceId.
export interface EventBus {
  publish(orgId: OrgId, event: KernelEvent): Promise<void>
}

// A bus without subscribers.
export const noopEventBus: EventBus = {
  publish: async () => {},
}
