import { describe, expect, it } from 'vitest'
import { subpath } from '@edgekits/kernel/tenancy'

describe('@edgekits/kernel/tenancy', () => {
  it('exposes the public entry', () => {
    expect(subpath).toBe('tenancy')
  })
})
