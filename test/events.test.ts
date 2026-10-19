import { describe, expect, it } from 'vitest'
import { subpath } from '@edgekits/kernel/events'

describe('@edgekits/kernel/events', () => {
  it('exposes the public entry', () => {
    expect(subpath).toBe('events')
  })
})
