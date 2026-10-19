import { describe, expect, it } from 'vitest'
import { subpath } from '@edgekits/kernel/policy'

describe('@edgekits/kernel/policy', () => {
  it('exposes the public entry', () => {
    expect(subpath).toBe('policy')
  })
})
