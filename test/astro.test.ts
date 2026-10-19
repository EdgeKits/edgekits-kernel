import { describe, expect, it } from 'vitest'
import { subpath } from '@edgekits/kernel/astro'

describe('@edgekits/kernel/astro', () => {
  it('exposes the public entry', () => {
    expect(subpath).toBe('astro')
  })
})
