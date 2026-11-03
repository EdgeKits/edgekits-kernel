import type { MiddlewareHandler } from 'hono'
import { createMiddleware } from 'hono/factory'
import type { TenantVariables } from './tenant.js'

// After the handler: an authenticated response (c.var.tenant set) gets
// Cache-Control: no-store unless the route set its own Cache-Control.
export function noStore(): MiddlewareHandler<{
  Variables: Partial<TenantVariables>
}> {
  return createMiddleware<{ Variables: Partial<TenantVariables> }>(
    async (c, next) => {
      await next()
      if (c.var.tenant && !c.res.headers.has('Cache-Control')) {
        c.header('Cache-Control', 'no-store')
      }
    },
  )
}

const mutating = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

// A POST, PUT, PATCH or DELETE is rejected with 403 when its Origin header is
// present and not in `allowed`, or when Origin is absent and the request
// carries a Cookie (a browser request whose origin cannot be checked). Other
// methods, and cookieless requests without Origin, pass.
export function sameOrigin({
  allowed,
}: {
  allowed: string[]
}): MiddlewareHandler {
  const origins = new Set(allowed)
  return createMiddleware(async (c, next) => {
    if (mutating.has(c.req.method)) {
      const origin = c.req.header('Origin')
      const rejected =
        origin === undefined
          ? c.req.header('Cookie') !== undefined
          : !origins.has(origin)
      if (rejected) return c.json({ error: 'forbidden' }, 403)
    }
    await next()
  })
}

export interface SecurityHeadersOptions {
  // Replaces the whole Content-Security-Policy.
  csp?: string
  // Sets the frame-ancestors directive, for example "'self'".
  frameAncestors?: string
  // Strict-Transport-Security on https requests (audit F43). Default
  // HSTS_DEFAULT; false leaves the header out. Never sent over plain http,
  // so a local http://localhost run is not pinned to https.
  hsts?: string | false
}

export const HSTS_DEFAULT = 'max-age=31536000; includeSubDomains'

const DEFAULT_CSP =
  "default-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"

// Puts frame-ancestors in place of an existing one, or appends it.
function withFrameAncestors(csp: string, value: string): string {
  const directive = `frame-ancestors ${value}`
  const directives = csp
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
  const at = directives.findIndex((part) =>
    part.toLowerCase().startsWith('frame-ancestors '),
  )
  if (at === -1) directives.push(directive)
  else directives[at] = directive
  return directives.join('; ')
}

// After the handler: sets each header below unless the response already has
// it. The default CSP allows no inline script, and Astro islands hydrate
// through inline scripts, so an Astro app passes its own csp with the
// script-src it needs (hashes or nonces); the kernel default stays strict.
// X-Frame-Options follows frame-ancestors for older browsers: DENY for
// 'none', SAMEORIGIN for 'self', and absent for any other source list.
export function securityHeaders(
  options: SecurityHeadersOptions = {},
): MiddlewareHandler {
  const ancestors = options.frameAncestors
  const csp =
    ancestors === undefined
      ? (options.csp ?? DEFAULT_CSP)
      : withFrameAncestors(options.csp ?? DEFAULT_CSP, ancestors)
  const frameOptions =
    ancestors === undefined || ancestors === "'none'"
      ? 'DENY'
      : ancestors === "'self'"
        ? 'SAMEORIGIN'
        : undefined
  const headers: [string, string][] = [
    ['Content-Security-Policy', csp],
    ['X-Content-Type-Options', 'nosniff'],
    ['Referrer-Policy', 'strict-origin-when-cross-origin'],
    ...(frameOptions
      ? [['X-Frame-Options', frameOptions] as [string, string]]
      : []),
    ['Permissions-Policy', 'camera=(), microphone=(), geolocation=()'],
  ]
  const hsts = options.hsts === undefined ? HSTS_DEFAULT : options.hsts
  return createMiddleware(async (c, next) => {
    await next()
    for (const [name, value] of headers) {
      if (!c.res.headers.has(name)) c.header(name, value)
    }
    if (
      hsts &&
      new URL(c.req.url).protocol === 'https:' &&
      !c.res.headers.has('Strict-Transport-Security')
    ) {
      c.header('Strict-Transport-Security', hsts)
    }
  })
}
