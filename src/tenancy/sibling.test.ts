import { describe, expect, it } from 'vitest'
import { subpath } from '@edgekits/kernel/policy'

describe('sibling subpath import from src/tenancy', () => {
  it('resolves @edgekits/kernel/policy', () => {
    expect(subpath).toBe('policy')
  })
})
