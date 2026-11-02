// The kit's event vocabulary (KernelEvent: billing, organization,
// lifecycle and admin events), InboundEvent and the EventBus.
import type { AdminId, OrgId, PlanId, UserId } from '@edgekits/kernel/tenancy'

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
// for the kit itself (such as 'system:lifecycle'), `admin:<adminId>` for an
// operator acting through AdminRpc (such as 'admin:<Access sub>'), or
// `provider:<id>` for a billing provider (such as 'provider:paddle'). Billing
// events carry no actorId: their actor is the provider that sent them.

// The reserved org id of events that belong to no org: the deployment's
// plan catalog and settings (admin.plan_*, admin.setting_changed). No org
// can have it; a subscriber records such events under this id.
export const systemOrgId = 'system' as const

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
// subject are the same user. member.invitation_canceled is a pending
// invitation withdrawn before it was accepted.
export type OrgEvent = KernelEventCommon & { actorId: string } & (
    | { type: 'org.created' }
    | {
        type: 'member.invited'
        invitationId: string
        email: string
        role: string
      }
    | {
        type: 'member.invitation_canceled'
        invitationId: string
        email: string
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

// What an operator did through AdminRpc (P1-10). The actor is
// `admin:<adminId>`; adminEmail is the operator's Access email, kept for the
// log's readability. Events that belong to no org carry orgId 'system'
// (systemOrgId): the catalog, settings, org claims before their org exists,
// and user blocks (a user is not one org's). admin.setting_changed names
// the key only, because a setting may hold ids. admin.impersonation_ended is
// recorded when an impersonation session ends, and admin.org_claim_accepted
// when the claim's person accepts it (under the new org's id, the actor the
// operator who made the claim), not by an AdminRpc method. Timestamps are
// epoch milliseconds; amounts are in the currency's minor unit.
export type AdminEvent = KernelEventCommon & {
  actorId: `admin:${AdminId}`
  adminEmail: string
} & (
    | {
        type: 'admin.override_set'
        key: string
        value: number | boolean
        reason: string
        expiresAt?: number
      }
    | { type: 'admin.override_cleared'; key: string }
    // reason: the operator's note; message: the members' text, null for the
    // app's default.
    | { type: 'admin.suspended'; reason: string; message: string | null }
    | { type: 'admin.unsuspended' }
    | { type: 'admin.trial_started'; plan: PlanId; endsAt: number }
    | { type: 'admin.trial_extended'; endsAt: number }
    | { type: 'admin.trial_ended'; reason: string }
    | {
        type: 'admin.refund_cancel'
        providerSubscriptionId: string
        transactionId: string
        amount: number
        currency: Currency
      }
    | { type: 'admin.plan_created'; orgId: typeof systemOrgId; plan: PlanId }
    | { type: 'admin.plan_updated'; orgId: typeof systemOrgId; plan: PlanId }
    | { type: 'admin.plan_archived'; orgId: typeof systemOrgId; plan: PlanId }
    | { type: 'admin.setting_changed'; orgId: typeof systemOrgId; key: string }
    | { type: 'admin.impersonated'; userId: UserId; ttlSeconds: number }
    | { type: 'admin.impersonation_ended'; userId: UserId }
    // Org claims (P1-10d).
    | {
        type: 'admin.org_claim_created'
        orgId: typeof systemOrgId
        claimId: string
        name: string
        slug: string
        email: string
      }
    | {
        type: 'admin.org_claim_canceled'
        orgId: typeof systemOrgId
        claimId: string
      }
    | { type: 'admin.org_claim_accepted'; claimId: string; userId: UserId }
    // Invitations into an existing org, written on its first owner's behalf.
    | {
        type: 'admin.member_invited'
        invitationId: string
        email: string
        role: string
      }
    | { type: 'admin.invitation_canceled'; invitationId: string }
    // User blocks: the user keeps their rows but no sessions.
    | {
        type: 'admin.user_blocked'
        orgId: typeof systemOrgId
        userId: UserId
        reason: string
      }
    | {
        type: 'admin.user_unblocked'
        orgId: typeof systemOrgId
        userId: UserId
      }
    | { type: 'admin.plan_restored'; orgId: typeof systemOrgId; plan: PlanId }
  )

export type KernelEvent = BillingEvent | OrgEvent | LifecycleEvent | AdminEvent

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
