import { describe, expect, it } from 'vitest'
import { subpath } from '@edgekits/kernel/ports'

describe('@edgekits/kernel/ports', () => {
  it('exposes the public entry', () => {
    expect(subpath).toBe('ports')
  })
})
