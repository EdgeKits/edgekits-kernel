import type { Context, Env, MiddlewareHandler } from 'hono'
import { createMiddleware } from 'hono/factory'
import {
  resolveTenant,
  TenancyError,
  type OrgId,
  type TenancyDeps,
  type TenantContext,
  type UserId,
} from '@edgekits/kernel/tenancy'

export type TenantVariables = { tenant: TenantContext }

export interface SessionInfo {
  userId: UserId
  activeOrgId: OrgId | null
}

// An org named by the caller's credential (an API key) or by a trusted
// server-side argument; never by a query string or client header.
export interface ExplicitOrg {
  orgId: OrgId
  source: 'api-key' | 'explicit'
}

type MaybeAsync<T> = T | Promise<T>

export type TenantDeps = Omit<TenancyDeps, 'source' | 'request'>

export interface TenantOptions<E extends Env = Env> {
  session(c: Context<E>): MaybeAsync<SessionInfo | null>
  orgFromRequest(c: Context<E>): MaybeAsync<ExplicitOrg | null>
  deps: TenantDeps | ((c: Context<E>) => MaybeAsync<TenantDeps>)
  // Defaults: id from cf-ray or a random UUID, locale 'en', ip from
  // cf-connecting-ip.
  request?(c: Context<E>): TenancyDeps['request']
}

function defaultRequest(c: Context): TenancyDeps['request'] {
  const ip = c.req.header('cf-connecting-ip')
  return {
    id: c.req.header('cf-ray') ?? crypto.randomUUID(),
    locale: 'en',
    ...(ip ? { ip } : {}),
  }
}

// Resolves the tenant for the request (ADR-005): an explicit org wins over
// the session's active org, and membership is re-verified by resolveTenant.
// No session, no org, or a TenancyError responds 404.
export function tenant<E extends Env = Env>(
  options: TenantOptions<E>,
): MiddlewareHandler<E & { Variables: TenantVariables }> {
  return createMiddleware<E & { Variables: TenantVariables }>(
    async (c, next) => {
      const notFound = () => c.json({ error: 'not-found' }, 404)
      // Hono's Context is invariant in its env, so the callbacks see the
      // app's env without the variables this middleware adds.
      const ctx = c as unknown as Context<E>
      const session = await options.session(ctx)
      if (!session) return notFound()
      const explicit = await options.orgFromRequest(ctx)
      const orgId = explicit ? explicit.orgId : session.activeOrgId
      if (!orgId) return notFound()
      const deps =
        typeof options.deps === 'function'
          ? await options.deps(ctx)
          : options.deps
      const result = await resolveTenant({ userId: session.userId }, orgId, {
        ...deps,
        source: explicit ? explicit.source : 'session',
        request: options.request ? options.request(ctx) : defaultRequest(c),
      })
      if (result instanceof TenancyError) return notFound()
      c.set('tenant', result)
      await next()
    },
  )
}
