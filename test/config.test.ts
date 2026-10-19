import { describe, expect, it } from 'vitest'
import { subpath } from '@edgekits/kernel/config'

describe('@edgekits/kernel/config', () => {
  it('exposes the public entry', () => {
    expect(subpath).toBe('config')
  })
})
