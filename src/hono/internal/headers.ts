import { createMiddleware } from 'hono/factory'
import type { TenantVariables } from './tenant'

// After the handler: an authenticated response (c.var.tenant set) gets
// Cache-Control: no-store unless the route set its own Cache-Control.
export function noStore() {
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
export function sameOrigin({ allowed }: { allowed: string[] }) {
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
