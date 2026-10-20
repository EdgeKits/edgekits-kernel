import { drizzle } from 'drizzle-orm/d1'
import { env } from 'cloudflare:workers'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { describe, expect, it } from 'vitest'
import {
  errors,
  noStore,
  sameOrigin,
  subpath,
  tenant,
  type SessionInfo,
  type TenantVariables,
} from '@edgekits/kernel/hono'
import { PolicyError } from '@edgekits/kernel/policy'
import {
  TenancyError,
  TenantGuardError,
  type OrgRecord,
} from '@edgekits/kernel/tenancy'

const orgs: Record<string, OrgRecord> = {
  A: { id: 'A', kind: 'team', plan: 'pro', slug: 'org-a' },
  B: { id: 'B', kind: 'team', plan: 'free', slug: 'org-b' },
}
const members = new Map([
  ['A:alice', 'admin'],
  ['B:alice', 'member'],
])
const sessions: Record<string, SessionInfo> = {
  alice: { userId: 'alice', activeOrgId: 'A' },
  bob: { userId: 'bob', activeOrgId: 'A' },
  carol: { userId: 'carol', activeOrgId: 'Z' },
}

const tenantMiddleware = tenant({
  session: (c) => {
    const user = /session=(\w+)/.exec(c.req.header('Cookie') ?? '')?.[1]
    return user ? (sessions[user] ?? null) : null
  },
  orgFromRequest: (c) =>
    c.req.header('Authorization') === 'Bearer key-for-B'
      ? { orgId: 'B', source: 'api-key' }
      : null,
  deps: {
    membership: async (userId, orgId) => {
      const role = members.get(`${orgId}:${userId}`)
      return role ? { role } : null
    },
    org: async (orgId) => orgs[orgId] ?? null,
    db: drizzle(env.DB),
  },
})

function app() {
  const handled: string[] = []
  const hono = new Hono<{ Variables: TenantVariables }>()
  hono.onError(errors({ log: () => {} }))
  hono.use('/app/*', noStore(), tenantMiddleware)
  hono.get('/app/whoami', (c) => {
    handled.push(c.var.tenant.orgId)
    return c.json({
      orgId: c.var.tenant.orgId,
      role: c.var.tenant.actor.role,
      source: c.var.tenant.request.source,
    })
  })
  hono.get('/app/cached', (c) => {
    c.header('Cache-Control', 'private, max-age=60')
    return c.text('ok')
  })
  hono.get('/app/entitlement', () => {
    throw new PolicyError({
      ok: false,
      reason: 'entitlement',
      key: 'projects',
      limit: 3,
      current: 3,
      upgradeTo: 'pro',
    })
  })
  hono.get('/app/forbidden', () => {
    throw new PolicyError({
      ok: false,
      reason: 'forbidden',
      permission: 'billing.write',
    })
  })
  hono.get('/guard', () => {
    throw new TenantGuardError(
      'Statement on tenant table projects has no org_id predicate: select "id" from "projects"',
    )
  })
  return { hono, handled }
}

const as = (user: string, init: RequestInit = {}) => ({
  ...init,
  headers: { Cookie: `session=${user}`, ...init.headers },
})

describe('@edgekits/kernel/hono', () => {
  it('exposes the public entry', () => {
    expect(subpath).toBe('hono')
  })

  describe('tenant()', () => {
    it('resolves a member to the active org', async () => {
      const { hono } = app()
      const res = await hono.request('/app/whoami', as('alice'))
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({
        orgId: 'A',
        role: 'admin',
        source: 'session',
      })
    })

    it('responds 404 to a non-member, an unknown org and no session', async () => {
      const { hono, handled } = app()
      for (const init of [as('bob'), as('carol'), {}]) {
        const res = await hono.request('/app/whoami', init)
        expect(res.status).toBe(404)
        expect(await res.json()).toEqual({ error: 'not-found' })
      }
      expect(handled).toEqual([])
    })

    it('ignores an org in the query string', async () => {
      const { hono } = app()
      const res = await hono.request('/app/whoami?org=B', as('alice'))
      expect(await res.json()).toMatchObject({ orgId: 'A' })
      const denied = await hono.request('/app/whoami?org=A', as('bob'))
      expect(denied.status).toBe(404)
    })

    it('lets an explicit api-key org win over the active org', async () => {
      const { hono } = app()
      const res = await hono.request(
        '/app/whoami',
        as('alice', { headers: { Authorization: 'Bearer key-for-B' } }),
      )
      expect(await res.json()).toEqual({
        orgId: 'B',
        role: 'member',
        source: 'api-key',
      })
      const denied = await hono.request(
        '/app/whoami',
        as('bob', { headers: { Authorization: 'Bearer key-for-B' } }),
      )
      expect(denied.status).toBe(404)
    })
  })

  describe('errors()', () => {
    it('maps an entitlement PolicyError to 402 with the decision', async () => {
      const { hono } = app()
      const res = await hono.request('/app/entitlement', as('alice'))
      expect(res.status).toBe(402)
      expect(await res.json()).toEqual({
        error: 'entitlement',
        decision: {
          ok: false,
          reason: 'entitlement',
          key: 'projects',
          limit: 3,
          current: 3,
          upgradeTo: 'pro',
        },
      })
    })

    it('maps a forbidden PolicyError to 403', async () => {
      const { hono } = app()
      const res = await hono.request('/app/forbidden', as('alice'))
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({
        error: 'forbidden',
        decision: {
          ok: false,
          reason: 'forbidden',
          permission: 'billing.write',
        },
      })
    })

    it('maps a TenantGuardError to 500 without the SQL', async () => {
      const { hono } = app()
      const res = await hono.request('/guard')
      expect(res.status).toBe(500)
      const body = await res.text()
      expect(JSON.parse(body)).toEqual({ error: 'internal' })
      expect(body).not.toMatch(/select|projects|org_id/i)
    })

    it('passes an HTTPException through with its own response', async () => {
      const logged: unknown[] = []
      const hono = new Hono()
      hono.onError(errors({ log: (error) => logged.push(error) }))
      hono.get('/auth', () => {
        throw new HTTPException(401, { message: 'x' })
      })
      const res = await hono.request('/auth')
      expect(res.status).toBe(401)
      expect(await res.text()).toBe('x')
      expect(logged).toEqual([])
    })

    it('maps a thrown TenancyError to 404 and logs only 500s', async () => {
      const logged: unknown[] = []
      const hono = new Hono()
      hono.onError(errors({ log: (error) => logged.push(error) }))
      hono.get('/tenancy', () => {
        throw new TenancyError('no-such-org', 'Z')
      })
      hono.get('/boom', () => {
        throw new Error('boom')
      })
      expect((await hono.request('/tenancy')).status).toBe(404)
      const boom = await hono.request('/boom')
      expect(boom.status).toBe(500)
      expect(await boom.json()).toEqual({ error: 'internal' })
      expect(logged).toHaveLength(1)
    })
  })

  describe('noStore()', () => {
    it('sets no-store on an authenticated response', async () => {
      const { hono } = app()
      const res = await hono.request('/app/whoami', as('alice'))
      expect(res.headers.get('Cache-Control')).toBe('no-store')
    })

    it('keeps a Cache-Control the route set itself', async () => {
      const { hono } = app()
      const res = await hono.request('/app/cached', as('alice'))
      expect(res.headers.get('Cache-Control')).toBe('private, max-age=60')
    })

    it('leaves an unauthenticated response alone', async () => {
      const hono = new Hono()
      hono.use(noStore())
      hono.get('/public', (c) => c.text('public'))
      const res = await hono.request('/public')
      expect(res.status).toBe(200)
      expect(res.headers.get('Cache-Control')).toBeNull()
    })
  })

  describe('sameOrigin()', () => {
    const hono = new Hono()
    hono.use(sameOrigin({ allowed: ['https://app.example.com'] }))
    hono.all('/action', (c) => c.text('done'))

    it('passes a POST from an allowed Origin', async () => {
      const res = await hono.request('/action', {
        method: 'POST',
        headers: { Origin: 'https://app.example.com', Cookie: 'session=x' },
      })
      expect(res.status).toBe(200)
    })

    it('rejects a mutating request from a foreign Origin', async () => {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const res = await hono.request('/action', {
          method,
          headers: { Origin: 'https://evil.example' },
        })
        expect(res.status).toBe(403)
        expect(await res.json()).toEqual({ error: 'forbidden' })
      }
    })

    it('rejects a POST without Origin that carries a Cookie', async () => {
      const res = await hono.request('/action', {
        method: 'POST',
        headers: { Cookie: 'session=x' },
      })
      expect(res.status).toBe(403)
    })

    it('passes a cookieless POST without Origin', async () => {
      const res = await hono.request('/action', { method: 'POST' })
      expect(res.status).toBe(200)
    })

    it('never blocks GET', async () => {
      const res = await hono.request('/action', {
        headers: { Origin: 'https://evil.example', Cookie: 'session=x' },
      })
      expect(res.status).toBe(200)
    })
  })
})
