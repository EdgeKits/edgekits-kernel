import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { errors } from '@edgekits/kernel/hono'
import {
  assertPriceSupported,
  billingCapabilitiesSchema,
  CapabilityError,
  paddleCapabilities,
  priceCapabilityIssues,
  subpath,
} from '@edgekits/kernel/ports'

const monthly = {
  amount: 900,
  currency: 'USD',
  period: 'month',
  model: 'flat',
} as const

describe('@edgekits/kernel/ports', () => {
  it('exposes the public entry', () => {
    expect(subpath).toBe('ports')
  })

  it('ships a Paddle manifest that matches the capabilities schema', () => {
    expect(billingCapabilitiesSchema.parse(paddleCapabilities)).toEqual(
      paddleCapabilities,
    )
  })
})

describe('catalog price capability checks', () => {
  it('accepts a price the manifest allows, with or without a trial', () => {
    expect(priceCapabilityIssues(paddleCapabilities, monthly)).toEqual([])
    expect(
      priceCapabilityIssues(paddleCapabilities, { ...monthly, trialDays: 14 }),
    ).toEqual([])
    expect(
      priceCapabilityIssues(paddleCapabilities, {
        ...monthly,
        period: 'once',
        amount: 0,
      }),
    ).toEqual([])
  })

  it('refuses a currency, model or trial the manifest does not list', () => {
    expect(
      priceCapabilityIssues(paddleCapabilities, {
        ...monthly,
        currency: 'XXX',
        model: 'credits',
      }),
    ).toEqual([
      'currency XXX (capability: currencies)',
      'billing model credits (capability: models)',
    ])
    expect(
      priceCapabilityIssues(
        { ...paddleCapabilities, trials: false },
        { ...monthly, trialDays: 7 },
      ),
    ).toEqual(['a trial (capability: trials)'])
  })

  it('refuses a trial on a one-time price and amounts that are not whole', () => {
    expect(
      priceCapabilityIssues(paddleCapabilities, {
        ...monthly,
        period: 'once',
        trialDays: 7,
      }),
    ).toEqual(['a trial on a one-time price'])
    expect(
      priceCapabilityIssues(paddleCapabilities, {
        ...monthly,
        amount: 9.5,
        trialDays: -1,
      }),
    ).toEqual([
      'amount must be a non-negative integer, got 9.5',
      'trialDays must be a non-negative integer, got -1',
    ])
  })

  it('assertPriceSupported throws CapabilityError, and errors() answers 400', async () => {
    expect(() =>
      assertPriceSupported('paddle', paddleCapabilities, monthly),
    ).not.toThrow()
    const refuse = () =>
      assertPriceSupported('paddle', paddleCapabilities, {
        ...monthly,
        currency: 'XXX',
      })
    expect(refuse).toThrow(CapabilityError)

    const app = new Hono()
    app.onError(errors())
    app.post('/prices', () => {
      refuse()
      return new Response(null, { status: 201 })
    })
    const response = await app.request('/prices', { method: 'POST' })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: 'unsupported',
      issues: ['currency XXX (capability: currencies)'],
    })
  })
})
