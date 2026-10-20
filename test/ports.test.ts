import { describe, expect, it } from 'vitest'
import {
  billingCapabilitiesSchema,
  paddleCapabilities,
  subpath,
} from '@edgekits/kernel/ports'

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
