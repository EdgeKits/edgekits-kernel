import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { AdminVariables } from '@edgekits/kernel/admin'
import { subpath, toLocals } from '@edgekits/kernel/astro'

describe('@edgekits/kernel/astro', () => {
  it('exposes the public entry', () => {
    expect(subpath).toBe('astro')
  })

  it('copies the kernel variables from a Hono context into locals', async () => {
    const hono = new Hono<{ Variables: AdminVariables }>()
    hono.use(async (c, next) => {
      c.set('admin', {
        admin: { id: 'admin-1', email: 'ops@edgekits.dev' },
        request: { id: 'req-1' },
      })
      await next()
    })
    hono.get('/', (c) => c.json(toLocals(c)))
    const res = await hono.request('/')
    expect(await res.json()).toEqual({
      admin: {
        admin: { id: 'admin-1', email: 'ops@edgekits.dev' },
        request: { id: 'req-1' },
      },
    })
  })
})
