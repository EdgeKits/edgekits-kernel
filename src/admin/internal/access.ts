import type { MiddlewareHandler } from 'hono'
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
  // Loads <teamDomain>/cdn-cgi/access/certs; defaults to fetch() with a 5 s
  // timeout. The result must be { keys: [{ kty, kid, ... }] }; anything else
  // counts as a failed load. It is cached per JWKS URL for the process
  // lifetime and refetched when a token names an unknown kid, at most once
  // per 60 seconds per URL.
  fetchJwks?: () => Promise<Jwks>
}

export type AdminVariables = { admin: AdminContext }

const REFETCH_INTERVAL_MS = 60_000
const FETCH_TIMEOUT_MS = 5_000

interface JwksState {
  jwks?: Promise<Jwks>
  refetchedAt: number
}

const jwksStates = new Map<string, JwksState>()

function fetchFrom(url: string): () => Promise<Jwks> {
  return async () => {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!response.ok) {
      throw new Error(`Access JWKS fetch failed: ${response.status}`)
    }
    return (await response.json()) as Jwks
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

// Rejects a body that is not a JWKS, so that it fails like an outage (500,
// not cached) instead of breaking token checks later.
function checkJwks(value: unknown): Jwks {
  const keys = isRecord(value) ? value.keys : undefined
  const valid =
    Array.isArray(keys) &&
    keys.every(
      (key) =>
        isRecord(key) &&
        typeof key.kty === 'string' &&
        typeof key.kid === 'string',
    )
  if (!valid) throw new Error('Access JWKS has an invalid shape')
  return value as Jwks
}

// The cached JWKS for one URL. refetch() returns null while throttled, so a
// stream of tokens with unknown kids costs at most one fetch per interval.
function jwksCache(url: string, load: () => Promise<Jwks>) {
  let state = jwksStates.get(url)
  if (!state) {
    state = { refetchedAt: -Infinity }
    jwksStates.set(url, state)
  }
  const cached = state
  const loadNow = () => {
    const jwks = load().then(checkJwks)
    cached.jwks = jwks
    // A failed fetch or an invalid body is not cached.
    jwks.catch(() => {
      if (cached.jwks === jwks) cached.jwks = undefined
    })
    return jwks
  }
  return {
    current: (): Promise<Jwks> => cached.jwks ?? loadNow(),
    refetch: (): Promise<Jwks> | null => {
      const now = Date.now()
      if (now - cached.refetchedAt < REFETCH_INTERVAL_MS) return null
      cached.refetchedAt = now
      return loadNow()
    },
  }
}

const requestId = (header: string | undefined) => header ?? crypto.randomUUID()

// ADR-002a: the admin identity comes from the Cf-Access-Jwt-Assertion JWT,
// verified as RS256 against the team JWKS with iss, aud and exp checked.
export function accessIdentity(
  options: AccessIdentityOptions,
): MiddlewareHandler<{ Variables: AdminVariables }> {
  const issuer = options.teamDomain.replace(/\/+$/, '')
  const url = `${issuer}/cdn-cgi/access/certs`
  const jwks = jwksCache(url, options.fetchJwks ?? fetchFrom(url))
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

    const forbidden = () => c.json({ error: 'forbidden' }, 403)
    const token = c.req.header('Cf-Access-Jwt-Assertion')
    if (!token) return forbidden()
    let kid: string | undefined
    try {
      kid = Jwt.decode(token).header.kid
    } catch {
      return forbidden()
    }
    if (!kid) return forbidden()
    // A JWKS fetch failure is an outage, not a bad token: it propagates.
    let { keys } = await jwks.current()
    if (!keys.some((key) => key.kid === kid)) {
      // Access rotates its signing keys: an unknown kid refetches the JWKS.
      const refetched = jwks.refetch()
      if (!refetched) return forbidden()
      keys = (await refetched).keys
    }
    let payload: Awaited<ReturnType<typeof Jwt.verifyWithJwks>>
    try {
      payload = await Jwt.verifyWithJwks(token, {
        keys,
        allowedAlgorithms: ['RS256'],
        verification: { iss: issuer, aud: options.aud },
      })
    } catch {
      return forbidden()
    }
    // Hono checks exp only when present; Access tokens always carry it.
    if (
      typeof payload.exp !== 'number' ||
      typeof payload.sub !== 'string' ||
      typeof payload.email !== 'string'
    ) {
      return forbidden()
    }
    c.set('admin', {
      admin: { id: payload.sub, email: payload.email },
      request,
    })
    await next()
  })
}
