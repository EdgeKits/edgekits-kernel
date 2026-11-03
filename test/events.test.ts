import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  applySubscriptionEvents,
  noopEventBus,
  subpath,
  systemOrgId,
  type AdminEvent,
  type BillingEvent,
  type EventBus,
  type KernelEvent,
  type LifecycleEvent,
  type OrgEvent,
} from '@edgekits/kernel/events'
import type { OrgId } from '@edgekits/kernel/tenancy'
import { seeded, shuffle } from './random.js'

const periodEnd = Date.UTC(2026, 11, 1)

// One subscription's events. evt_05 arrives twice; evt_03 and evt_03b share
// a timestamp, so the id decides their order.
const fixture: BillingEvent[] = [
  {
    type: 'customer.linked',
    occurredAt: 500,
    providerEventId: 'evt_01',
    sourceId: 'evt_01:customer.linked',
    orgId: 'A',
    providerCustomerId: 'ctm_1',
  },
  {
    type: 'subscription.activated',
    occurredAt: 1000,
    providerEventId: 'evt_02',
    sourceId: 'evt_02:subscription.activated',
    orgId: 'A',
    plan: 'pro',
    seats: 3,
    periodEnd,
    trial: false,
  },
  {
    type: 'subscription.updated',
    occurredAt: 2000,
    providerEventId: 'evt_03',
    sourceId: 'evt_03:subscription.updated',
    orgId: 'A',
    plan: 'pro',
    seats: 5,
    periodEnd,
  },
  {
    type: 'subscription.updated',
    occurredAt: 2000,
    providerEventId: 'evt_03b',
    sourceId: 'evt_03b:subscription.updated',
    orgId: 'A',
    plan: 'pro',
    seats: 7,
    periodEnd,
  },
  {
    type: 'invoice.paid',
    occurredAt: 2500,
    providerEventId: 'evt_04',
    sourceId: 'evt_04:invoice.paid',
    orgId: 'A',
    amount: 4900,
    currency: 'USD',
  },
  {
    type: 'credits.granted',
    occurredAt: 3000,
    providerEventId: 'evt_05',
    sourceId: 'evt_05:credits.granted',
    orgId: 'A',
    amount: 500,
  },
  {
    type: 'credits.granted',
    occurredAt: 3000,
    providerEventId: 'evt_05',
    sourceId: 'evt_05:credits.granted',
    orgId: 'A',
    amount: 500,
  },
  {
    type: 'credits.consumed',
    occurredAt: 4000,
    providerEventId: 'evt_06',
    sourceId: 'evt_06:credits.consumed',
    orgId: 'A',
    amount: 120,
  },
  {
    type: 'subscription.scheduled_cancel',
    occurredAt: 5000,
    providerEventId: 'evt_07',
    sourceId: 'evt_07:subscription.scheduled_cancel',
    orgId: 'A',
    effectiveAt: periodEnd,
  },
  {
    type: 'refund.created',
    occurredAt: 6000,
    providerEventId: 'evt_08',
    sourceId: 'evt_08:refund.created',
    orgId: 'A',
    amount: 900,
  },
]

describe('@edgekits/kernel/events', () => {
  it('exposes the public entry', () => {
    expect(subpath).toBe('events')
  })

  it('section 5 test 3: any order of the same events converges', () => {
    const expected = {
      plan: 'pro',
      status: 'active',
      seats: 7,
      periodEnd,
      cancelAt: periodEnd,
      credits: 380,
      appliedEventIds: [
        'evt_01',
        'evt_02',
        'evt_03',
        'evt_03b',
        'evt_04',
        'evt_05',
        'evt_06',
        'evt_07',
        'evt_08',
      ],
    }
    expect(applySubscriptionEvents(fixture)).toEqual(expected)

    const random = seeded(0xb111)
    let permutations = 0
    for (let i = 0; i < 25; i++) {
      const order = shuffle(fixture, random)
      expect(applySubscriptionEvents(order)).toEqual(expected)
      expect(applySubscriptionEvents([...order].reverse())).toEqual(expected)
      permutations += 2
    }
    expect(permutations).toBe(50)
  })

  it('does not mutate its input', () => {
    const copy = structuredClone(fixture)
    applySubscriptionEvents(fixture)
    expect(fixture).toEqual(copy)
  })
})

describe('EventBus', () => {
  it('noopEventBus accepts any event and resolves', async () => {
    const event = fixture[1] as BillingEvent
    await expect(noopEventBus.publish('A', event)).resolves.toBeUndefined()
  })

  it('a subscriber receives the org and the event', async () => {
    const seen: Array<[string, string]> = []
    const bus: EventBus = {
      publish: async (orgId, event) => {
        seen.push([orgId, event.type])
      },
    }
    for (const event of fixture.slice(0, 2)) await bus.publish('A', event)
    expect(seen).toEqual([
      ['A', 'customer.linked'],
      ['A', 'subscription.activated'],
    ])
  })
})

describe('subscription.created', () => {
  it('applies like subscription.activated', () => {
    const common = { occurredAt: 1000, providerEventId: 'evt_c', orgId: 'A' }
    const payload = { plan: 'pro', seats: 2, periodEnd, trial: true }
    const created = applySubscriptionEvents([
      {
        ...common,
        ...payload,
        type: 'subscription.created',
        sourceId: 'evt_c:subscription.created',
      },
    ])
    const activated = applySubscriptionEvents([
      {
        ...common,
        ...payload,
        type: 'subscription.activated',
        sourceId: 'evt_c:subscription.activated',
      },
    ])
    expect(created).toEqual(activated)
    expect(created.status).toBe('trialing')
  })
})

// One sample per KernelEvent type. The mapped type makes the record
// exhaustive: a member added to KernelEvent without a sample here fails the
// typecheck.
type Samples = {
  [T in KernelEvent['type']]: Extract<KernelEvent, { type: T }>
}
const at = 1_700_000_000_000
const billing = (providerEventId: string, type: BillingEvent['type']) => ({
  orgId: 'A',
  occurredAt: at,
  providerEventId,
  sourceId: `${providerEventId}:${type}`,
  type,
})
const user = { orgId: 'A', occurredAt: at, actorId: 'user_1' }
const lifecycle = {
  orgId: 'A',
  occurredAt: at,
  actorId: 'system:lifecycle',
} as const
const admin = {
  orgId: 'A',
  occurredAt: at,
  actorId: 'admin:adm_1',
  adminEmail: 'ops@example.com',
} as const
const catalog = { ...admin, orgId: systemOrgId }
const samples: Samples = {
  'customer.linked': {
    ...billing('e1', 'customer.linked'),
    type: 'customer.linked',
    providerCustomerId: 'ctm_1',
  },
  'billing.rejected': {
    ...billing('e0', 'billing.rejected'),
    type: 'billing.rejected',
    providerSubscriptionId: 'sub_1',
    reason: 'foreign-customer',
  },
  'subscription.created': {
    ...billing('e2', 'subscription.created'),
    type: 'subscription.created',
    plan: 'pro',
    seats: 1,
    periodEnd,
    trial: false,
  },
  'subscription.activated': {
    ...billing('e3', 'subscription.activated'),
    type: 'subscription.activated',
    plan: 'pro',
    seats: 1,
    periodEnd,
    trial: false,
  },
  'subscription.updated': {
    ...billing('e4', 'subscription.updated'),
    type: 'subscription.updated',
    plan: 'pro',
    seats: 2,
    periodEnd,
  },
  'subscription.paused': {
    ...billing('e5', 'subscription.paused'),
    type: 'subscription.paused',
  },
  'subscription.resumed': {
    ...billing('e6', 'subscription.resumed'),
    type: 'subscription.resumed',
  },
  'subscription.scheduled_cancel': {
    ...billing('e7', 'subscription.scheduled_cancel'),
    type: 'subscription.scheduled_cancel',
    effectiveAt: periodEnd,
  },
  'subscription.canceled': {
    ...billing('e8', 'subscription.canceled'),
    type: 'subscription.canceled',
  },
  'subscription.past_due': {
    ...billing('e9', 'subscription.past_due'),
    type: 'subscription.past_due',
  },
  'subscription.expired': {
    ...billing('e10', 'subscription.expired'),
    type: 'subscription.expired',
  },
  'invoice.paid': {
    ...billing('e11', 'invoice.paid'),
    type: 'invoice.paid',
    amount: 4900,
    currency: 'USD',
  },
  'invoice.failed': {
    ...billing('e12', 'invoice.failed'),
    type: 'invoice.failed',
  },
  'refund.created': {
    ...billing('e13', 'refund.created'),
    type: 'refund.created',
    amount: 900,
  },
  'dispute.opened': {
    ...billing('e14', 'dispute.opened'),
    type: 'dispute.opened',
  },
  'credits.granted': {
    ...billing('e15', 'credits.granted'),
    type: 'credits.granted',
    amount: 10,
  },
  'credits.consumed': {
    ...billing('e16', 'credits.consumed'),
    type: 'credits.consumed',
    amount: 5,
  },
  'credits.exhausted': {
    ...billing('e17', 'credits.exhausted'),
    type: 'credits.exhausted',
  },
  'license.issued': {
    ...billing('e18', 'license.issued'),
    type: 'license.issued',
    key: 'k',
    productId: 'p',
  },
  'org.created': { ...user, sourceId: 'u1', type: 'org.created' },
  'member.invited': {
    ...user,
    sourceId: 'u2',
    type: 'member.invited',
    invitationId: 'inv_1',
    email: 'b@example.com',
    role: 'member',
  },
  'member.invitation_canceled': {
    ...user,
    sourceId: 'u2c',
    type: 'member.invitation_canceled',
    invitationId: 'inv_1',
    email: 'b@example.com',
  },
  'member.joined': {
    ...user,
    sourceId: 'u3',
    type: 'member.joined',
    userId: 'user_1',
    memberId: 'mem_1',
    role: 'member',
  },
  'member.role_changed': {
    ...user,
    sourceId: 'u4',
    type: 'member.role_changed',
    userId: 'user_2',
    memberId: 'mem_2',
    role: 'admin',
    previousRole: 'member',
  },
  'member.removed': {
    ...user,
    sourceId: 'u5',
    type: 'member.removed',
    userId: 'user_2',
    memberId: 'mem_2',
  },
  'member.left': {
    ...user,
    sourceId: 'u6',
    type: 'member.left',
    userId: 'user_1',
    memberId: 'mem_1',
  },
  'trial.started': {
    ...lifecycle,
    sourceId: 'wf:start-trial',
    type: 'trial.started',
    plan: 'pro',
    endsAt: periodEnd,
  },
  'trial.subscribed': {
    ...lifecycle,
    sourceId: 'wf:close-trial',
    type: 'trial.subscribed',
    plan: 'pro',
  },
  'trial.expired': {
    ...lifecycle,
    sourceId: 'wf:expire-trial',
    type: 'trial.expired',
    plan: 'pro',
  },
  'admin.override_set': {
    ...admin,
    sourceId: 'a1',
    type: 'admin.override_set',
    key: 'members',
    value: 10,
    reason: 'pilot',
    expiresAt: periodEnd,
  },
  'admin.override_cleared': {
    ...admin,
    sourceId: 'a2',
    type: 'admin.override_cleared',
    key: 'members',
  },
  'admin.suspended': {
    ...admin,
    sourceId: 'a3',
    type: 'admin.suspended',
    reason: 'abuse report',
    message: null,
  },
  'admin.unsuspended': { ...admin, sourceId: 'a4', type: 'admin.unsuspended' },
  'admin.trial_started': {
    ...admin,
    sourceId: 'a5',
    type: 'admin.trial_started',
    plan: 'team',
    endsAt: periodEnd,
  },
  'admin.trial_extended': {
    ...admin,
    sourceId: 'a6',
    type: 'admin.trial_extended',
    endsAt: periodEnd,
  },
  'admin.trial_ended': {
    ...admin,
    sourceId: 'a7',
    type: 'admin.trial_ended',
    reason: 'converted by phone',
  },
  'admin.refund_issued': {
    ...admin,
    sourceId: 'adj_1:issued',
    type: 'admin.refund_issued',
    adjustmentId: 'adj_1',
    transactionId: 'txn_1',
    amount: 4900,
    currency: 'USD',
  },
  'admin.refund_cancel': {
    ...admin,
    sourceId: 'a8',
    type: 'admin.refund_cancel',
    adjustmentId: 'adj_1',
    providerSubscriptionId: 'sub_1',
    transactionId: 'txn_1',
    amount: 4900,
    currency: 'USD',
  },
  'admin.plan_created': {
    ...catalog,
    sourceId: 'a9',
    type: 'admin.plan_created',
    plan: 'team',
  },
  'admin.plan_updated': {
    ...catalog,
    sourceId: 'a10',
    type: 'admin.plan_updated',
    plan: 'team',
  },
  'admin.plan_archived': {
    ...catalog,
    sourceId: 'a11',
    type: 'admin.plan_archived',
    plan: 'team',
  },
  'admin.setting_changed': {
    ...catalog,
    sourceId: 'a12',
    type: 'admin.setting_changed',
    key: 'billing.trialPlan',
  },
  'admin.impersonated': {
    ...admin,
    sourceId: 'a13',
    type: 'admin.impersonated',
    userId: 'user_1',
    ttlSeconds: 900,
  },
  'admin.impersonation_ended': {
    ...admin,
    sourceId: 'a14',
    type: 'admin.impersonation_ended',
    userId: 'user_1',
  },
  'admin.org_claim_created': {
    ...catalog,
    sourceId: 'a15',
    type: 'admin.org_claim_created',
    claimId: 'claim_1',
    name: 'Acme',
    slug: 'acme',
    email: 'owner@example.com',
  },
  'admin.org_claim_canceled': {
    ...catalog,
    sourceId: 'a16',
    type: 'admin.org_claim_canceled',
    claimId: 'claim_1',
  },
  'admin.org_claim_accepted': {
    ...admin,
    sourceId: 'a17',
    type: 'admin.org_claim_accepted',
    claimId: 'claim_2',
    userId: 'user_9',
  },
  'admin.member_invited': {
    ...admin,
    sourceId: 'a18',
    type: 'admin.member_invited',
    invitationId: 'inv_9',
    email: 'c@example.com',
    role: 'member',
  },
  'admin.invitation_canceled': {
    ...admin,
    sourceId: 'a19',
    type: 'admin.invitation_canceled',
    invitationId: 'inv_9',
  },
  'admin.user_blocked': {
    ...catalog,
    sourceId: 'a20',
    type: 'admin.user_blocked',
    userId: 'user_1',
    reason: 'spam',
  },
  'admin.user_unblocked': {
    ...catalog,
    sourceId: 'a21',
    type: 'admin.user_unblocked',
    userId: 'user_1',
  },
  'admin.plan_restored': {
    ...catalog,
    sourceId: 'a22',
    type: 'admin.plan_restored',
    plan: 'team',
  },
}

describe('KernelEvent', () => {
  it('each family narrows on type', () => {
    const family = (event: KernelEvent) => {
      switch (event.type) {
        case 'admin.org_claim_created':
          expectTypeOf(event).toExtend<AdminEvent>()
          expectTypeOf(event.email).toBeString()
          expectTypeOf(event.orgId).toEqualTypeOf<'system'>()
          return 'admin'
        case 'admin.user_blocked':
          expectTypeOf(event.userId).toBeString()
          expectTypeOf(event.reason).toBeString()
          return 'admin'
        case 'subscription.created':
          expectTypeOf(event).toExtend<BillingEvent>()
          expectTypeOf(event.providerEventId).toBeString()
          expectTypeOf(event.trial).toBeBoolean()
          return 'billing'
        case 'member.role_changed':
          expectTypeOf(event).toExtend<OrgEvent>()
          expectTypeOf(event.previousRole).toBeString()
          expectTypeOf(event.actorId).toBeString()
          return 'org'
        case 'member.invited':
          expectTypeOf(event).toExtend<OrgEvent>()
          expectTypeOf(event.email).toBeString()
          return 'org'
        case 'trial.started':
          expectTypeOf(event).toExtend<LifecycleEvent>()
          expectTypeOf(event.endsAt).toBeNumber()
          expectTypeOf(event.actorId).toEqualTypeOf<'system:lifecycle'>()
          return 'lifecycle'
        default:
          return 'other'
      }
    }
    expect(family(samples['subscription.created'])).toBe('billing')
    expect(family(samples['member.role_changed'])).toBe('org')
    expect(family(samples['member.invited'])).toBe('org')
    expect(family(samples['trial.started'])).toBe('lifecycle')
    expect(family(samples['invoice.paid'])).toBe('other')
    expect(family(samples['admin.org_claim_created'])).toBe('admin')
    expect(family(samples['admin.user_blocked'])).toBe('admin')
    expectTypeOf<OrgEvent['type']>().toEqualTypeOf<
      | 'org.created'
      | 'member.invited'
      | 'member.invitation_canceled'
      | 'member.joined'
      | 'member.role_changed'
      | 'member.removed'
      | 'member.left'
    >()
    expectTypeOf<LifecycleEvent['type']>().toEqualTypeOf<
      'trial.started' | 'trial.subscribed' | 'trial.expired'
    >()
  })

  it('every member carries occurredAt, sourceId and orgId', () => {
    // At the type level: no member lacks them.
    expectTypeOf<
      Exclude<
        KernelEvent,
        { occurredAt: number; sourceId: string; orgId: OrgId }
      >
    >().toBeNever()
    // At run time, over one sample of each type (Samples is exhaustive).
    const all = Object.values(samples) as KernelEvent[]
    expect(all).toHaveLength(52)
    for (const event of all) {
      expect(typeof event.occurredAt, event.type).toBe('number')
      expect(typeof event.sourceId, event.type).toBe('string')
      expect(typeof event.orgId, event.type).toBe('string')
    }
    expect(new Set(all.map((event) => event.sourceId)).size).toBe(all.length)
  })

  it('admin events carry the operator, and catalog events the system org', () => {
    expectTypeOf<AdminEvent['actorId']>().toEqualTypeOf<`admin:${string}`>()
    expectTypeOf<AdminEvent['adminEmail']>().toBeString()
    expectTypeOf<
      Extract<
        AdminEvent,
        {
          type:
            | 'admin.plan_created'
            | 'admin.plan_updated'
            | 'admin.plan_archived'
            | 'admin.setting_changed'
            | 'admin.plan_restored'
            | 'admin.org_claim_created'
            | 'admin.org_claim_canceled'
            | 'admin.user_blocked'
            | 'admin.user_unblocked'
        }
      >['orgId']
    >().toEqualTypeOf<'system'>()
    // Written under an org: the claim's new org, the invitation's org.
    expectTypeOf<
      Extract<
        AdminEvent,
        {
          type:
            | 'admin.org_claim_accepted'
            | 'admin.member_invited'
            | 'admin.invitation_canceled'
        }
      >['orgId']
    >().toEqualTypeOf<string>()
    // A setting's value never travels in its event.
    expectTypeOf<
      Extract<AdminEvent, { type: 'admin.setting_changed' }>
    >().not.toHaveProperty('value')
    expect(systemOrgId).toBe('system')
    const admins = (Object.values(samples) as KernelEvent[]).filter((event) =>
      event.type.startsWith('admin.'),
    ) as AdminEvent[]
    expect(admins).toHaveLength(23)
    for (const event of admins) {
      expect(event.actorId, event.type).toMatch(/^admin:/)
    }
  })

  it('the bus takes every family', async () => {
    const seen: string[] = []
    const bus: EventBus = {
      publish: async (orgId, event) => {
        seen.push(`${orgId}:${event.type}`)
      },
    }
    await bus.publish('A', samples['subscription.created'])
    await bus.publish('A', samples['org.created'])
    await bus.publish('A', samples['trial.expired'])
    await bus.publish(systemOrgId, samples['admin.plan_created'])
    await expect(
      noopEventBus.publish('A', samples['member.left']),
    ).resolves.toBeUndefined()
    expect(seen).toEqual([
      'A:subscription.created',
      'A:org.created',
      'A:trial.expired',
      'system:admin.plan_created',
    ])
  })
})
