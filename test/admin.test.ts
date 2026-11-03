import { Hono } from 'hono'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  accessIdentity,
  subpath,
  type AccessIdentityOptions,
  type AdminVariables,
  type Jwks,
} from '@edgekits/kernel/admin'

const teamDomain = 'https://edgekits.cloudflareaccess.com'
const aud = 'aud-tag-0123456789'
const now = () => Math.floor(Date.now() / 1000)

const base64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
const encodePart = (part: object) =>
  base64url(new TextEncoder().encode(JSON.stringify(part)))

const generateKeys = () =>
  crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  ) as Promise<CryptoKeyPair>

// Signs an RS256 JWT with Web Crypto directly, independent of Hono.
async function signJwt(privateKey: CryptoKey, kid: string, payload: object) {
  const input = `${encodePart({ alg: 'RS256', typ: 'JWT', kid })}.${encodePart(payload)}`
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    privateKey,
    new TextEncoder().encode(input),
  )
  return `${input}.${base64url(signature)}`
}

let keys: CryptoKeyPair
let otherKeys: CryptoKeyPair
let jwks: Jwks
let rotatedJwks: Jwks

beforeAll(async () => {
  keys = await generateKeys()
  otherKeys = await generateKeys()
  const publicJwk = (await crypto.subtle.exportKey(
    'jwk',
    keys.publicKey,
  )) as JsonWebKey
  jwks = { keys: [{ ...publicJwk, kid: 'k1', alg: 'RS256' }] }
  const otherJwk = (await crypto.subtle.exportKey(
    'jwk',
    otherKeys.publicKey,
  )) as JsonWebKey
  rotatedJwks = {
    keys: [...jwks.keys, { ...otherJwk, kid: 'k2', alg: 'RS256' }],
  }
})

const claims = (overrides: object = {}) => ({
  iss: teamDomain,
  aud: [aud],
  sub: 'admin-1',
  email: 'ops@edgekits.dev',
  iat: now(),
  exp: now() + 300,
  ...overrides,
})

function app(options: Partial<AccessIdentityOptions> = {}) {
  const hono = new Hono<{ Variables: AdminVariables }>()
  hono.use(
    accessIdentity({
      teamDomain,
      aud,
      mode: 'production',
      build: 'production',
      fetchJwks: async () => jwks,
      ...options,
    }),
  )
  hono.get('/', (c) => c.json(c.var.admin.admin))
  return hono
}

const withToken = (token: string) => ({
  headers: { 'Cf-Access-Jwt-Assertion': token },
})

describe('@edgekits/kernel/admin', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('exposes the public entry', () => {
    expect(subpath).toBe('admin')
  })

  it('accepts a valid Access token and sets c.var.admin', async () => {
    const token = await signJwt(keys.privateKey, 'k1', claims())
    const res = await app().request('/', withToken(token))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      id: 'admin-1',
      email: 'ops@edgekits.dev',
    })
  })

  it('rejects a wrong aud, a wrong iss, an expired token and a missing exp', async () => {
    const bad = [
      claims({ aud: ['another-app'] }),
      claims({ iss: 'https://other.cloudflareaccess.com' }),
      claims({ iat: now() - 600, exp: now() - 60 }),
      claims({ exp: undefined }),
    ]
    for (const payload of bad) {
      const token = await signJwt(keys.privateKey, 'k1', payload)
      const res = await app().request('/', withToken(token))
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'forbidden' })
    }
  })

  it('rejects a token signed by another key', async () => {
    for (const kid of ['k1', 'k2']) {
      const token = await signJwt(otherKeys.privateKey, kid, claims())
      const res = await app().request('/', withToken(token))
      expect(res.status).toBe(403)
    }
  })

  it('rejects a request without the header, and garbage in it', async () => {
    expect((await app().request('/')).status).toBe(403)
    expect((await app().request('/', withToken('not.a.jwt'))).status).toBe(403)
  })

  it('reports each 403 through denied, without the token', async () => {
    const entries: unknown[] = []
    const hono = app({ denied: (entry) => entries.push(entry) })
    const signed = (payload: object) => signJwt(keys.privateKey, 'k1', payload)
    const noEmail: Record<string, unknown> = claims()
    delete noEmail.email
    const unsigned = `${encodePart({ alg: 'RS256' })}.${encodePart(claims())}.c2ln`
    const cases: Array<[string, Record<string, string>]> = [
      ['no-token', {}],
      ['malformed-token', { 'Cf-Access-Jwt-Assertion': 'not-a-jwt' }],
      ['no-kid', { 'Cf-Access-Jwt-Assertion': unsigned }],
      [
        'invalid-token',
        {
          'Cf-Access-Jwt-Assertion': await signed(
            claims({ aud: ['another-app'] }),
          ),
        },
      ],
      ['missing-claims', { 'Cf-Access-Jwt-Assertion': await signed(noEmail) }],
    ]
    for (const [, headers] of cases) {
      const res = await hono.request('/', {
        headers: { ...headers, 'cf-ray': 'ray-1' },
      })
      expect(res.status).toBe(403)
    }
    expect(entries).toEqual(
      cases.map(([reason]) => ({
        status: 403,
        reason,
        path: '/',
        method: 'GET',
        requestId: 'ray-1',
        actor: 'anonymous',
      })),
    )
    expect(JSON.stringify(entries)).not.toMatch(/eyJ|not-a-jwt|c2ln/)
  })

  it('defaults the denial log to one JSON line on console.warn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await app().request('/')
    expect(res.status).toBe(403)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toMatchObject({
      status: 403,
      reason: 'no-token',
      actor: 'anonymous',
    })
  })

  it('uses the dev identity in mode dev and never reads the header', async () => {
    const hono = app({
      mode: 'dev',
      build: 'dev',
      devIdentity: { id: 'dev-admin', email: 'dev@localhost' },
      fetchJwks: () => {
        throw new Error('mode dev must not fetch the JWKS')
      },
    })
    const res = await hono.request('/', withToken('ignored'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      id: 'dev-admin',
      email: 'dev@localhost',
    })
    expect((await hono.request('/')).status).toBe(200)
  })

  it('refuses mode dev without a dev identity', () => {
    expect(() =>
      accessIdentity({ teamDomain, aud, mode: 'dev', build: 'dev' }),
    ).toThrow(/devIdentity/)
  })

  // Audit F5: a dev identity never reaches a production build.
  it('refuses mode dev in a production build, at construction', () => {
    expect(() =>
      accessIdentity({
        teamDomain,
        aud,
        mode: 'dev',
        build: 'production',
        devIdentity: { id: 'dev-admin', email: 'dev@localhost' },
      }),
    ).toThrow(/refused in a production build/)
  })

  it('accepts mode production in a dev build', () => {
    expect(() =>
      accessIdentity({ teamDomain, aud, mode: 'production', build: 'dev' }),
    ).not.toThrow()
  })

  it('fetches the team certs once by default', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => Response.json(jwks))
    const domain = 'https://cached.cloudflareaccess.com'
    const hono = app({ teamDomain: `${domain}/`, fetchJwks: undefined })
    for (let i = 0; i < 2; i++) {
      const token = await signJwt(
        keys.privateKey,
        'k1',
        claims({ iss: domain }),
      )
      expect((await hono.request('/', withToken(token))).status).toBe(200)
    }
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
      `${domain}/cdn-cgi/access/certs`,
    )
  })

  it('treats a JWKS fetch slower than 5 s as an outage', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_input, init) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(init.signal?.reason),
          )
        }),
    )
    const domain = 'https://slow.cloudflareaccess.com'
    const hono = new Hono<{ Variables: AdminVariables }>()
    hono.onError(() => new Response('outage', { status: 500 }))
    hono.use(
      accessIdentity({
        teamDomain: domain,
        aud,
        mode: 'production',
        build: 'production',
      }),
    )
    hono.get('/', (c) => c.text('ok'))
    const token = await signJwt(keys.privateKey, 'k1', claims({ iss: domain }))
    const started = Date.now()
    const res = await hono.request('/', withToken(token))
    expect(res.status).toBe(500)
    expect(Date.now() - started).toBeGreaterThanOrEqual(4_900)
    expect(fetchSpy.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
  }, 10_000)

  it('treats a malformed JWKS as an outage and does not cache it', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ keys: [{ kty: 'RSA' }] }))
      .mockResolvedValueOnce(Response.json({ nope: true }))
      .mockImplementation(async () => Response.json(jwks))
    const domain = 'https://malformed.cloudflareaccess.com'
    const hono = new Hono<{ Variables: AdminVariables }>()
    hono.onError(() => new Response('outage', { status: 500 }))
    hono.use(
      accessIdentity({
        teamDomain: domain,
        aud,
        mode: 'production',
        build: 'production',
      }),
    )
    hono.get('/', (c) => c.text('ok'))
    const token = await signJwt(keys.privateKey, 'k1', claims({ iss: domain }))
    expect((await hono.request('/', withToken(token))).status).toBe(500)
    expect((await hono.request('/', withToken(token))).status).toBe(500)
    expect((await hono.request('/', withToken(token))).status).toBe(200)
    expect((await hono.request('/', withToken(token))).status).toBe(200)
    expect(fetchSpy).toHaveBeenCalledTimes(3)
  })

  it('refetches the JWKS once when a rotated key signs the token', async () => {
    const domain = 'https://rotate.cloudflareaccess.com'
    const fetchJwks = vi
      .fn<() => Promise<Jwks>>()
      .mockResolvedValueOnce(jwks)
      .mockResolvedValue(rotatedJwks)
    const hono = app({ teamDomain: domain, fetchJwks })
    const sign = (privateKey: CryptoKey, kid: string) =>
      signJwt(privateKey, kid, claims({ iss: domain }))

    const before = await sign(keys.privateKey, 'k1')
    expect((await hono.request('/', withToken(before))).status).toBe(200)
    expect(fetchJwks).toHaveBeenCalledTimes(1)

    const rotated = await sign(otherKeys.privateKey, 'k2')
    expect((await hono.request('/', withToken(rotated))).status).toBe(200)
    expect(fetchJwks).toHaveBeenCalledTimes(2)

    expect((await hono.request('/', withToken(rotated))).status).toBe(200)
    expect(fetchJwks).toHaveBeenCalledTimes(2)
  })

  it('throttles refetches for unknown kids to one per minute', async () => {
    const domain = 'https://throttle.cloudflareaccess.com'
    const fetchJwks = vi.fn<() => Promise<Jwks>>().mockResolvedValue(jwks)
    const hono = app({ teamDomain: domain, fetchJwks })
    const unknown = await signJwt(
      otherKeys.privateKey,
      'k9',
      claims({ iss: domain }),
    )
    const start = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(start)

    // First load, then one refetch for the unknown kid.
    expect((await hono.request('/', withToken(unknown))).status).toBe(403)
    expect(fetchJwks).toHaveBeenCalledTimes(2)

    clock.mockReturnValue(start + 59_999)
    expect((await hono.request('/', withToken(unknown))).status).toBe(403)
    expect(fetchJwks).toHaveBeenCalledTimes(2)

    clock.mockReturnValue(start + 60_000)
    expect((await hono.request('/', withToken(unknown))).status).toBe(403)
    expect(fetchJwks).toHaveBeenCalledTimes(3)
  })
})
