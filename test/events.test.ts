import { describe, expect, it } from 'vitest'
import {
  applySubscriptionEvents,
  subpath,
  type BillingEvent,
} from '@edgekits/kernel/events'
import { seeded, shuffle } from './random'

const periodEnd = Date.UTC(2026, 11, 1)

// One subscription's events. evt_05 arrives twice; evt_03 and evt_03b share
// a timestamp, so the id decides their order.
const fixture: BillingEvent[] = [
  {
    type: 'customer.linked',
    occurredAt: 500,
    providerEventId: 'evt_01',
    orgId: 'A',
    providerCustomerId: 'ctm_1',
  },
  {
    type: 'subscription.activated',
    occurredAt: 1000,
    providerEventId: 'evt_02',
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
    orgId: 'A',
    plan: 'pro',
    seats: 5,
    periodEnd,
  },
  {
    type: 'subscription.updated',
    occurredAt: 2000,
    providerEventId: 'evt_03b',
    orgId: 'A',
    plan: 'pro',
    seats: 7,
    periodEnd,
  },
  {
    type: 'invoice.paid',
    occurredAt: 2500,
    providerEventId: 'evt_04',
    amount: 4900,
    currency: 'USD',
  },
  {
    type: 'credits.granted',
    occurredAt: 3000,
    providerEventId: 'evt_05',
    amount: 500,
  },
  {
    type: 'credits.granted',
    occurredAt: 3000,
    providerEventId: 'evt_05',
    amount: 500,
  },
  {
    type: 'credits.consumed',
    occurredAt: 4000,
    providerEventId: 'evt_06',
    amount: 120,
  },
  {
    type: 'subscription.scheduled_cancel',
    occurredAt: 5000,
    providerEventId: 'evt_07',
    effectiveAt: periodEnd,
  },
  {
    type: 'refund.created',
    occurredAt: 6000,
    providerEventId: 'evt_08',
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
