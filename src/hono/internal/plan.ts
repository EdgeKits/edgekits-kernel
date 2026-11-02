import type { MiddlewareHandler } from 'hono'
import { createMiddleware } from 'hono/factory'
import { PolicyError, type PolicyEngine } from '@edgekits/kernel/policy'
import type { TenantVariables } from './tenant.js'

export interface RequirePlanOptions {
  // The engine whose resolve() decides; the app's one engine.
  policy: PolicyEngine
  // Paths that pass without a plan: exact ('/app/settings/billing'), or a
  // prefix ending in '/*' ('/app/o/*', which also matches '/app/o').
  allow: readonly string[]
  // Paths that pass for a suspended org, in the same form. Defaults to
  // allow. Keep what a member needs to leave the org: sign-out, Better
  // Auth's endpoints (sign-out, set-active) and any deep link that switches
  // org; leave out what buys or changes a plan (checkout, plan change).
  allowSuspended?: readonly string[]
  // Where a navigation without a plan is sent.
  billingPath: string
}

// The quality an Accept header gives a media type: the most specific
// matching range wins (type/subtype, then type/*, then */*); 0 when none
// matches. A missing header accepts everything equally.
function quality(accept: string, type: string): number {
  const [major] = type.split('/')
  let best = { specificity: -1, q: 0 }
  for (const part of accept.split(',')) {
    const [range = '', ...params] = part.trim().toLowerCase().split(';')
    const specificity =
      range === type ? 2 : range === `${major}/*` ? 1 : range === '*/*' ? 0 : -1
    if (specificity < best.specificity || specificity < 0) continue
    const qParam = params.map((p) => p.trim()).find((p) => p.startsWith('q='))
    const q = qParam ? Number(qParam.slice(2)) : 1
    best = { specificity, q: Number.isFinite(q) ? q : 0 }
  }
  return best.q
}

// A browser navigation: a GET whose Accept prefers HTML over JSON. A
// navigation sends text/html explicitly; fetch() sends */* or JSON, and a
// tie is not a navigation.
function isNavigation(method: string, accept: string | undefined): boolean {
  if (method !== 'GET') return false
  const header = accept ?? '*/*'
  return quality(header, 'text/html') > quality(header, 'application/json')
}

function allowed(path: string, allow: readonly string[]): boolean {
  return allow.some((entry) => {
    if (!entry.endsWith('/*')) return path === entry
    const prefix = entry.slice(0, -2)
    return path === prefix || path.startsWith(`${prefix}/`)
  })
}

// ADR-010's paywall and the admin's suspension (P1-10), mounted after
// tenant(). A suspended org is refused first, navigation or not, with a
// PolicyError 'suspended', which errors() renders as 403 { error:
// 'suspended', decision }; paths in allowSuspended pass. Then, when the org
// resolves to no plan (no default plan, subscription or trial), a
// navigation is redirected 302 to billingPath and any other request is
// refused with a PolicyError 'paywall', which errors() renders as 402
// { error: 'paywall', decision }. Paths in allow pass, as does every org with
// a plan.
export function requirePlan(
  options: RequirePlanOptions,
): MiddlewareHandler<{ Variables: TenantVariables }> {
  const { policy, allow, billingPath } = options
  const allowSuspended = options.allowSuspended ?? allow
  return createMiddleware<{ Variables: TenantVariables }>(async (c, next) => {
    const path = c.req.path
    const passesPaywall = allowed(path, allow)
    const passesSuspension = allowed(path, allowSuspended)
    if (passesPaywall && passesSuspension) return next()
    const ctx = c.var.tenant
    if (!ctx) throw new Error('requirePlan() runs after tenant()')
    const { plan, suspended } = await policy.resolve(ctx)
    if (suspended && !passesSuspension) {
      throw new PolicyError({ ok: false, reason: 'suspended' })
    }
    if (passesPaywall || plan !== null) return next()
    if (isNavigation(c.req.method, c.req.header('Accept'))) {
      return c.redirect(billingPath, 302)
    }
    throw new PolicyError({ ok: false, reason: 'paywall' })
  })
}
