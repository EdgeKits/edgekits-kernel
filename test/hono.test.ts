import { drizzle } from 'drizzle-orm/d1'
import { env } from 'cloudflare:workers'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  errors,
  errorSummary,
  HSTS_DEFAULT,
  type DenialEntry,
  noStore,
  requirePlan,
  sameOrigin,
  securityHeaders,
  subpath,
  tenant,
  type SessionInfo,
  type TenantVariables,
} from '@edgekits/kernel/hono'
import {
  PlanError,
  PolicyError,
  type PolicyEngine,
} from '@edgekits/kernel/policy'
import {
  BlockedError,
  ConflictError,
  createTenantContext,
  TenancyError,
  TenantGuardError,
  type OrgRecord,
} from '@edgekits/kernel/tenancy'
import { createProjectsSql, projects } from './projects.tables.js'

const orgs: Record<string, OrgRecord> = {
  A: { id: 'A', kind: 'team', slug: 'org-a' },
  B: { id: 'B', kind: 'team', slug: 'org-b' },
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
  hono.get('/app/paywall', () => {
    throw new PolicyError({ ok: false, reason: 'paywall' })
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

beforeAll(async () => {
  for (const sql of createProjectsSql) await env.DB.prepare(sql).run()
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

    it('maps a paywall PolicyError to 402 with the decision', async () => {
      const { hono } = app()
      const res = await hono.request('/app/paywall', as('alice'))
      expect(res.status).toBe(402)
      expect(await res.json()).toEqual({
        error: 'paywall',
        decision: { ok: false, reason: 'paywall' },
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

    it('maps a ConflictError to 409 without detail', async () => {
      const hono = new Hono()
      hono.onError(errors({ log: () => {} }))
      hono.get('/conflict', () => {
        throw new ConflictError('projects')
      })
      const res = await hono.request('/conflict')
      expect(res.status).toBe(409)
      expect(await res.json()).toEqual({ error: 'conflict' })
    })

    it('answers 409 when a repository insert hits the (org_id, id) key', async () => {
      const ctx = createTenantContext({
        orgId: 'A',
        org: orgs.A as OrgRecord,
        actor: { userId: 'alice', role: 'admin' },
        request: { id: 'req', locale: 'en', source: 'session' },
        db: drizzle(env.DB),
      })
      const hono = new Hono()
      hono.onError(errors({ log: () => {} }))
      hono.post('/projects', async (c) => {
        const row = await ctx.db.repo(projects).insert({ id: 'p1', name: 'x' })
        return c.json(row, 201)
      })
      expect((await hono.request('/projects', { method: 'POST' })).status).toBe(
        201,
      )
      const again = await hono.request('/projects', { method: 'POST' })
      expect(again.status).toBe(409)
      expect(await again.json()).toEqual({ error: 'conflict' })
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

  describe('errors(): denial logging (audit F6)', () => {
    afterEach(() => {
      vi.restoreAllMocks()
    })

    // A Hono app whose errors() reports into `entries`; /tenant/* runs
    // behind tenant(), /admin/* with an operator in c.var.admin.
    function logged() {
      const entries: DenialEntry[] = []
      const hono = new Hono<{ Variables: TenantVariables }>()
      hono.onError(
        errors({ log: () => {}, denied: (entry) => entries.push(entry) }),
      )
      hono.use('/tenant/*', tenantMiddleware)
      hono.get('/tenant/forbidden', () => {
        throw new PolicyError({
          ok: false,
          reason: 'forbidden',
          permission: 'billing.write',
        })
      })
      hono.get('/tenant/suspended', () => {
        throw new PolicyError({ ok: false, reason: 'suspended' })
      })
      hono.get('/tenant/paywall', () => {
        throw new PolicyError({ ok: false, reason: 'paywall' })
      })
      hono.use('/admin/*', async (c, next) => {
        c.set(
          'admin' as never,
          {
            admin: { id: 'adm-1', email: 'ops@example.com' },
            request: { id: 'req-admin' },
          } as never,
        )
        await next()
      })
      hono.post('/admin/plans', () => {
        throw new PlanError('not-found', [])
      })
      hono.get('/login', () => {
        throw new HTTPException(401, { message: 'sign in' })
      })
      hono.get('/org/:id', () => {
        throw new TenancyError('not-a-member', 'Z')
      })
      hono.get('/conflict', () => {
        throw new ConflictError('projects')
      })
      hono.get('/blocked', () => {
        throw new BlockedError('user-9')
      })
      hono.get('/boom', () => {
        throw new Error('boom')
      })
      return { hono, entries }
    }

    it('401: an HTTPException, anonymous, with the cf-ray request id', async () => {
      const { hono, entries } = logged()
      const res = await hono.request('/login?token=secret', {
        headers: { 'cf-ray': 'ray-401', Authorization: 'Bearer secret' },
      })
      expect(res.status).toBe(401)
      expect(entries).toEqual([
        {
          status: 401,
          reason: 'http-exception',
          path: '/login',
          method: 'GET',
          requestId: 'ray-401',
          actor: 'anonymous',
        },
      ])
      // The query string, the header values and the body stay out.
      expect(JSON.stringify(entries)).not.toMatch(/secret|sign in/)
    })

    it("403: forbidden and suspended, with the tenant's user and request id", async () => {
      const { hono, entries } = logged()
      const init = as('alice', { headers: { 'cf-ray': 'ray-403' } })
      expect((await hono.request('/tenant/forbidden', init)).status).toBe(403)
      expect((await hono.request('/tenant/suspended', init)).status).toBe(403)
      expect(entries).toEqual([
        {
          status: 403,
          reason: 'forbidden',
          path: '/tenant/forbidden',
          method: 'GET',
          requestId: 'ray-403',
          actor: 'alice',
        },
        {
          status: 403,
          reason: 'suspended',
          path: '/tenant/suspended',
          method: 'GET',
          requestId: 'ray-403',
          actor: 'alice',
        },
      ])
    })

    it("403: a blocked user's session, with the reason blocked and no user id", async () => {
      const { hono, entries } = logged()
      const res = await hono.request('/blocked', {
        headers: { 'cf-ray': 'ray-blocked' },
      })
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'blocked' })
      expect(entries).toEqual([
        {
          status: 403,
          reason: 'blocked',
          path: '/blocked',
          method: 'GET',
          requestId: 'ray-blocked',
          actor: 'anonymous',
        },
      ])
    })

    it('404: a TenancyError, and a missing plan with the operator', async () => {
      const { hono, entries } = logged()
      expect((await hono.request('/org/Z')).status).toBe(404)
      const res = await hono.request('/admin/plans', { method: 'POST' })
      expect(res.status).toBe(404)
      expect(entries).toEqual([
        {
          status: 404,
          reason: 'not-a-member',
          path: '/org/Z',
          method: 'GET',
          requestId: null,
          actor: 'anonymous',
        },
        {
          status: 404,
          reason: 'plan-not-found',
          path: '/admin/plans',
          method: 'POST',
          requestId: 'req-admin',
          actor: 'admin:adm-1',
        },
      ])
    })

    it('reports nothing for 402, 409 and 500', async () => {
      const { hono, entries } = logged()
      const paywall = await hono.request('/tenant/paywall', as('alice'))
      expect(paywall.status).toBe(402)
      expect((await hono.request('/conflict')).status).toBe(409)
      expect((await hono.request('/boom')).status).toBe(500)
      expect(entries).toEqual([])
    })

    it('defaults to one JSON line on console.warn; a throwing hook keeps the answer', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const plain = new Hono()
      plain.onError(errors({ log: () => {} }))
      plain.get('/x', () => {
        throw new TenancyError('no-such-org', 'Z')
      })
      expect((await plain.request('/x')).status).toBe(404)
      expect(warn).toHaveBeenCalledTimes(1)
      expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toEqual({
        status: 404,
        reason: 'no-such-org',
        path: '/x',
        method: 'GET',
        requestId: null,
        actor: 'anonymous',
      })

      const throwing = new Hono()
      throwing.onError(
        errors({
          log: () => {},
          denied: () => {
            throw new Error('log down')
          },
        }),
      )
      throwing.get('/x', () => {
        throw new TenancyError('no-such-org', 'Z')
      })
      const res = await throwing.request('/x')
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: 'not-found' })
    })
  })

  describe('securityHeaders()', () => {
    const appWith = (
      options?: Parameters<typeof securityHeaders>[0],
      own?: [string, string],
    ) => {
      const hono = new Hono()
      hono.use(securityHeaders(options))
      hono.get('/', (c) => {
        if (own) c.header(own[0], own[1])
        return c.text('ok')
      })
      return hono
    }

    it('sets the five headers', async () => {
      const res = await appWith().request('/')
      expect(res.headers.get('Content-Security-Policy')).toBe(
        "default-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
      )
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
      expect(res.headers.get('Referrer-Policy')).toBe(
        'strict-origin-when-cross-origin',
      )
      expect(res.headers.get('X-Frame-Options')).toBe('DENY')
      expect(res.headers.get('Permissions-Policy')).toBe(
        'camera=(), microphone=(), geolocation=()',
      )
    })

    it('sets Strict-Transport-Security on https only (audit F43)', async () => {
      const https = await appWith().request('https://app.example.com/')
      expect(https.headers.get('Strict-Transport-Security')).toBe(HSTS_DEFAULT)
      expect(HSTS_DEFAULT).toBe('max-age=31536000; includeSubDomains')
      const http = await appWith().request('http://localhost:8787/')
      expect(http.headers.get('Strict-Transport-Security')).toBeNull()
      const off = await appWith({ hsts: false }).request(
        'https://app.example.com/',
      )
      expect(off.headers.get('Strict-Transport-Security')).toBeNull()
      const own = await appWith({ hsts: 'max-age=60' }).request(
        'https://app.example.com/',
      )
      expect(own.headers.get('Strict-Transport-Security')).toBe('max-age=60')
    })

    it('keeps a header the response already has', async () => {
      const res = await appWith(undefined, [
        'Content-Security-Policy',
        "default-src 'none'",
      ]).request('/')
      expect(res.headers.get('Content-Security-Policy')).toBe(
        "default-src 'none'",
      )
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    })

    it('takes a csp and a frame-ancestors directive', async () => {
      const custom = await appWith({
        csp: "default-src 'self'; script-src 'self' 'sha256-abc'",
      }).request('/')
      expect(custom.headers.get('Content-Security-Policy')).toBe(
        "default-src 'self'; script-src 'self' 'sha256-abc'",
      )
      const framed = await appWith({ frameAncestors: "'self'" }).request('/')
      expect(framed.headers.get('Content-Security-Policy')).toBe(
        "default-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'",
      )
      expect(framed.headers.get('X-Frame-Options')).toBe('SAMEORIGIN')
      const partner = await appWith({
        frameAncestors: 'https://partner.example',
      }).request('/')
      expect(partner.headers.get('X-Frame-Options')).toBeNull()
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

  describe('requirePlan()', () => {
    // Org A resolves to no plan (the paywall), org B to pro.
    const policy = {
      resolve: async (ctx: { orgId: string }) =>
        ctx.orgId === 'A'
          ? { plan: null, source: 'none', values: {} }
          : { plan: 'pro', source: 'subscription', values: {} },
    } as unknown as PolicyEngine

    function paywalled() {
      const hono = new Hono<{ Variables: TenantVariables }>()
      hono.onError(errors({ log: () => {} }))
      hono.use(
        '/app/*',
        tenantMiddleware,
        requirePlan({
          policy,
          allow: ['/app/billing', '/app/o/*'],
          billingPath: '/app/billing',
        }),
      )
      hono.all('/app/*', (c) => c.text(`reached ${c.req.path}`))
      return hono
    }

    const browser =
      'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    const request = (
      path: string,
      init: { method?: string; accept?: string; org?: 'B' } = {},
    ) =>
      paywalled().request(
        path,
        as('alice', {
          method: init.method ?? 'GET',
          headers: {
            ...(init.accept ? { Accept: init.accept } : {}),
            ...(init.org ? { Authorization: 'Bearer key-for-B' } : {}),
          },
        }),
      )

    it('redirects a navigation without a plan to the billing path', async () => {
      const res = await request('/app/projects', { accept: browser })
      expect(res.status).toBe(302)
      expect(res.headers.get('Location')).toBe('/app/billing')
    })

    it('refuses a call without a plan with 402 paywall', async () => {
      const paywall = {
        error: 'paywall',
        decision: { ok: false, reason: 'paywall' },
      }
      for (const init of [
        { accept: 'application/json' },
        {},
        { accept: '*/*' },
        { accept: 'application/json, text/html;q=0.9' },
        { method: 'POST', accept: browser },
      ]) {
        const res = await request('/app/projects', init)
        expect(res.status, JSON.stringify(init)).toBe(402)
        expect(await res.json()).toEqual(paywall)
      }
    })

    it('lets allowed paths through without a plan, exact and by prefix', async () => {
      for (const path of ['/app/billing', '/app/o/acme', '/app/o']) {
        const res = await request(path, { accept: browser })
        expect(res.status, path).toBe(200)
        expect(await res.text()).toBe(`reached ${path}`)
      }
      const post = await request('/app/billing', { method: 'POST' })
      expect(post.status).toBe(200)
      const near = await request('/app/billing/x', { accept: browser })
      expect(near.status).toBe(302)
    })

    it('lets an org with a plan through, navigation or call', async () => {
      const page = await request('/app/projects', { accept: browser, org: 'B' })
      expect(page.status).toBe(200)
      const call = await request('/app/projects', { method: 'POST', org: 'B' })
      expect(call.status).toBe(200)
    })

    describe('a suspended org', () => {
      // Both orgs suspended: A without a plan, B with pro.
      const suspendedPolicy = {
        resolve: async (ctx: { orgId: string }) => ({
          ...(ctx.orgId === 'A'
            ? { plan: null, source: 'none', values: {} }
            : { plan: 'pro', source: 'subscription', values: {} }),
          suspended: { reason: 'abuse', message: null, at: 1000 },
        }),
      } as unknown as PolicyEngine

      function gated(allowSuspended?: readonly string[]) {
        const hono = new Hono<{ Variables: TenantVariables }>()
        hono.onError(errors({ log: () => {}, denied: () => {} }))
        hono.use(
          '/app/*',
          tenantMiddleware,
          requirePlan({
            policy: suspendedPolicy,
            allow: ['/app/billing', '/app/o/*'],
            ...(allowSuspended ? { allowSuspended } : {}),
            billingPath: '/app/billing',
          }),
        )
        hono.all('/app/*', (c) => c.text(`reached ${c.req.path}`))
        return hono
      }
      const call = (
        hono: Hono<{ Variables: TenantVariables }>,
        path: string,
        init: { method?: string; accept?: string; org?: 'B' } = {},
      ) =>
        hono.request(
          path,
          as('alice', {
            method: init.method ?? 'GET',
            headers: {
              ...(init.accept ? { Accept: init.accept } : {}),
              ...(init.org ? { Authorization: 'Bearer key-for-B' } : {}),
            },
          }),
        )
      const refusal = {
        error: 'suspended',
        decision: { ok: false, reason: 'suspended' },
      }

      it('is refused with 403 before the paywall, navigation or call, plan or not', async () => {
        const hono = gated(['/app/o/*'])
        const cases: Array<[string, Parameters<typeof call>[2]]> = [
          ['navigation, no plan', { accept: browser }],
          ['call, no plan', { method: 'POST' }],
          ['navigation, pro', { accept: browser, org: 'B' }],
          ['call, pro', { method: 'POST', org: 'B' }],
        ]
        for (const [label, init] of cases) {
          const res = await call(hono, '/app/projects', init)
          expect(res.status, label).toBe(403)
          expect(await res.json()).toEqual(refusal)
        }
      })

      it('passes only allowSuspended paths when it is given', async () => {
        const hono = gated(['/app/o/*', '/app/leave'])
        const deepLink = await call(hono, '/app/o/acme', { accept: browser })
        expect(deepLink.status).toBe(200)
        // On the paywall's list but not on allowSuspended.
        const billing = await call(hono, '/app/billing', { method: 'POST' })
        expect(billing.status).toBe(403)
        // On allowSuspended only: the paywall still applies after it.
        const leaveNoPlan = await call(hono, '/app/leave', { accept: browser })
        expect(leaveNoPlan.status).toBe(302)
        const leavePro = await call(hono, '/app/leave', { org: 'B' })
        expect(leavePro.status).toBe(200)
      })

      it('passes the allow paths when allowSuspended is not given', async () => {
        const hono = gated()
        for (const path of ['/app/billing', '/app/o/acme']) {
          const res = await call(hono, path, { method: 'POST' })
          expect(res.status, path).toBe(200)
        }
        const projects = await call(hono, '/app/projects', { org: 'B' })
        expect(projects.status).toBe(403)
      })
    })
  })
})

describe('errorSummary() (audit F38)', () => {
  it('keeps the name and the database code, never the message', () => {
    // As drizzle-orm 0.45 builds it: the message carries the bound values.
    class DrizzleQueryError extends Error {
      constructor(query: string, params: unknown[], cause: Error) {
        super(`Failed query: ${query}
params: ${params.join(',')}`)
        this.name = 'DrizzleQueryError'
        this.cause = cause
      }
    }
    const d1 = new Error(
      'D1_ERROR: UNIQUE constraint failed: user.email: SQLITE_CONSTRAINT',
    )
    const error = new DrizzleQueryError(
      'insert into "user" ("email") values (?)',
      ['ada@example.com'],
      d1,
    )
    const summary = errorSummary(error)
    expect(summary).toEqual({ name: 'DrizzleQueryError', code: 'D1_ERROR' })
    expect(JSON.stringify(summary)).not.toContain('ada@example.com')
    expect(
      errorSummary(Object.assign(new Error('x'), { code: 'E_LIMIT' })),
    ).toEqual({ name: 'Error', code: 'E_LIMIT' })
    expect(errorSummary(new TypeError('secret value'))).toEqual({
      name: 'TypeError',
      code: null,
    })
    expect(errorSummary('a string')).toEqual({ name: 'string', code: null })
  })

  it("is errors()' default log", async () => {
    const lines: unknown[] = []
    const spy = vi
      .spyOn(console, 'error')
      .mockImplementation((line) => void lines.push(line))
    const hono = new Hono()
    hono.onError(errors())
    hono.get('/', () => {
      throw new Error('params: ada@example.com')
    })
    const res = await hono.request('/')
    spy.mockRestore()
    expect(res.status).toBe(500)
    expect(lines).toEqual([
      JSON.stringify({ event: 'error', name: 'Error', code: null }),
    ])
  })
})
