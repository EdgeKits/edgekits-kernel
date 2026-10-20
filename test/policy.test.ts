import { describe, expect, it } from 'vitest'
import { PolicyError, subpath } from '@edgekits/kernel/policy'

describe('@edgekits/kernel/policy', () => {
  it('exposes the public entry', () => {
    expect(subpath).toBe('policy')
  })

  it('carries the denied decision on PolicyError', () => {
    const decision = {
      ok: false,
      reason: 'forbidden',
      permission: 'billing.write',
    } as const
    const error = new PolicyError(decision)
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('PolicyError')
    expect(error.decision).toBe(decision)
  })
})
