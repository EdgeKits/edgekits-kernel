import { createMiddleware } from 'hono/factory'
import { Jwt } from 'hono/utils/jwt'
import type { AdminId } from '@edgekits/kernel/tenancy'
import type { AdminContext } from '../index'

export interface Jwks {
  keys: Array<JsonWebKey & { kid?: string }>
}

export interface AccessIdentityOptions {
  // https://<team>.cloudflareaccess.com; also the expected iss.
  teamDomain: string
  // The Access application's AUD tag.
  aud: string
  mode: 'production' | 'dev'
  // Used only in mode 'dev', where the header is never read.
  devIdentity?: { id: AdminId; email: string }
  // Defaults to fetching <teamDomain>/cdn-cgi/access/certs, cached for the
  // process lifetime.
  fetchJwks?: () => Promise<Jwks>
}

export type AdminVariables = { admin: AdminContext }

const jwksCache = new Map<string, Promise<Jwks>>()

function cachedJwks(url: string): () => Promise<Jwks> {
  return () => {
    let jwks = jwksCache.get(url)
    if (!jwks) {
      jwks = fetch(url).then(async (response) => {
        if (!response.ok) {
          throw new Error(`Access JWKS fetch failed: ${response.status}`)
        }
        return (await response.json()) as Jwks
      })
      // A failed fetch is not cached.
      jwks.catch(() => jwksCache.delete(url))
      jwksCache.set(url, jwks)
    }
    return jwks
  }
}

const requestId = (header: string | undefined) => header ?? crypto.randomUUID()

// ADR-002a: the admin identity comes from the Cf-Access-Jwt-Assertion JWT,
// verified as RS256 against the team JWKS with iss, aud and exp checked.
export function accessIdentity(options: AccessIdentityOptions) {
  const issuer = options.teamDomain.replace(/\/+$/, '')
  const fetchJwks =
    options.fetchJwks ?? cachedJwks(`${issuer}/cdn-cgi/access/certs`)
  const devIdentity = options.devIdentity
  if (options.mode === 'dev' && !devIdentity) {
    throw new Error("accessIdentity: mode 'dev' requires devIdentity")
  }

  return createMiddleware<{ Variables: AdminVariables }>(async (c, next) => {
    const request = { id: requestId(c.req.header('cf-ray')) }
    if (options.mode === 'dev' && devIdentity) {
      c.set('admin', { admin: { ...devIdentity }, request })
      return next()
    }

    const token = c.req.header('Cf-Access-Jwt-Assertion')
    if (!token) return c.json({ error: 'forbidden' }, 403)
    // A JWKS fetch failure is an outage, not a bad token: it propagates.
    const { keys } = await fetchJwks()
    let payload: Awaited<ReturnType<typeof Jwt.verifyWithJwks>>
    try {
      payload = await Jwt.verifyWithJwks(token, {
        keys,
        allowedAlgorithms: ['RS256'],
        verification: { iss: issuer, aud: options.aud },
      })
    } catch {
      return c.json({ error: 'forbidden' }, 403)
    }
    // Hono checks exp only when present; Access tokens always carry it.
    if (
      typeof payload.exp !== 'number' ||
      typeof payload.sub !== 'string' ||
      typeof payload.email !== 'string'
    ) {
      return c.json({ error: 'forbidden' }, 403)
    }
    c.set('admin', {
      admin: { id: payload.sub, email: payload.email },
      request,
    })
    await next()
  })
}
