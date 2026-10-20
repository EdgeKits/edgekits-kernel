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

beforeAll(async () => {
  keys = await generateKeys()
  otherKeys = await generateKeys()
  const publicJwk = (await crypto.subtle.exportKey(
    'jwk',
    keys.publicKey,
  )) as JsonWebKey
  jwks = { keys: [{ ...publicJwk, kid: 'k1', alg: 'RS256' }] }
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

  it('uses the dev identity in mode dev and never reads the header', async () => {
    const hono = app({
      mode: 'dev',
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
    expect(() => accessIdentity({ teamDomain, aud, mode: 'dev' })).toThrow(
      /devIdentity/,
    )
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
})
