import { describe, expect, it } from 'vitest'
import { subpath } from '@edgekits/kernel/admin'

describe('@edgekits/kernel/admin', () => {
  it('exposes the public entry', () => {
    expect(subpath).toBe('admin')
  })
})
