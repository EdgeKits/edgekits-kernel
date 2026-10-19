import { describe, expect, it } from 'vitest'
import { subpath } from '@edgekits/kernel/hono'

describe('@edgekits/kernel/hono', () => {
  it('exposes the public entry', () => {
    expect(subpath).toBe('hono')
  })
})
