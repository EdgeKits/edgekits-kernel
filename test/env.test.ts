import { describe, expect, expectTypeOf, it } from 'vitest'
import { z } from 'zod'
import {
  boolean,
  checkEnv,
  composeEnv,
  defineEnv,
  email,
  EnvError,
  json,
  number,
  oneOf,
  parseEnv,
  string,
  url,
  type EnvVar,
} from '@edgekits/kernel/config'

const SECRET = 'sk_live_do-not-echo-0123456789'

// Parses one value through a one-key fragment.
function one<T>(variable: EnvVar<T, 'required' | 'optional' | 'default'>) {
  const composed = composeEnv([defineEnv('one', { KEY: variable })])
  return (raw: unknown) => {
    try {
      return { ok: true, value: parseEnv(composed, { KEY: raw }).KEY }
    } catch (error) {
      if (error instanceof EnvError) return { ok: false, issues: error.issues }
      throw error
    }
  }
}

const origins = z.array(z.url()).min(1)

describe('env validators', () => {
  it('string()', () => {
    expect(one(string())('abc')).toEqual({ ok: true, value: 'abc' })
    expect(one(string())(42).ok).toBe(false)
  })

  it('string({ min }) refuses a shorter value without naming it (audit F42)', () => {
    const secret = string({ min: 32 })
    expect(one(secret)('x'.repeat(32))).toEqual({
      ok: true,
      value: 'x'.repeat(32),
    })
    const short = one(secret)('short-secret')
    expect(short.ok).toBe(false)
    expect(JSON.stringify(short)).not.toContain('short-secret')
    expect(JSON.stringify(short)).toContain('at least 32 characters')
    expect(() => string({ min: 0 })).toThrow()
  })

  it('number() takes a number or a numeric string', () => {
    expect(one(number())('8787')).toEqual({ ok: true, value: 8787 })
    expect(one(number())(1.5)).toEqual({ ok: true, value: 1.5 })
    expect(one(number())('12px').ok).toBe(false)
    expect(one(number())(' ').ok).toBe(false)
    expect(one(number())(Infinity).ok).toBe(false)
  })

  it('boolean() takes a boolean or a boolean string', () => {
    expect(one(boolean())(true)).toEqual({ ok: true, value: true })
    expect(one(boolean())('false')).toEqual({ ok: true, value: false })
    expect(one(boolean())('1')).toEqual({ ok: true, value: true })
    expect(one(boolean())('maybe').ok).toBe(false)
  })

  it('url() and email()', () => {
    expect(one(url())('https://example.com/x').ok).toBe(true)
    expect(one(url())('example.com').ok).toBe(false)
    expect(one(email())('ops@example.com').ok).toBe(true)
    expect(one(email())('ops').ok).toBe(false)
  })

  // Audit F19.
  it('url({ https: true }) refuses every scheme but https:', () => {
    const https = one(url({ https: true }))
    expect(https('https://team.cloudflareaccess.com').ok).toBe(true)
    expect(https('http://team.cloudflareaccess.com').ok).toBe(false)
    expect(https('http://localhost:8787').ok).toBe(false)
    expect(https('ftp://example.com').ok).toBe(false)
    expect(https('nope').ok).toBe(false)
    expect(https('http://example.com')).toEqual({
      ok: false,
      issues: [
        {
          key: 'KEY',
          problem: 'invalid',
          message: 'KEY is invalid: expected an https URL',
        },
      ],
    })
  })

  it('url({ https: true, allowLocalhost: true }) also takes http://localhost', () => {
    const local = one(url({ https: true, allowLocalhost: true }))
    expect(local('https://app.example.com').ok).toBe(true)
    expect(local('http://localhost:8787').ok).toBe(true)
    expect(local('http://localhost').ok).toBe(true)
    expect(local('http://127.0.0.1:8787').ok).toBe(false)
    expect(local('http://localhost.example.com').ok).toBe(false)
    expect(local('ws://localhost:8787').ok).toBe(false)
    // allowLocalhost alone changes nothing: the plain url() takes any scheme.
    expect(one(url({ allowLocalhost: true }))('ftp://example.com').ok).toBe(
      true,
    )
  })

  it('url() options are part of the declaration composeEnv compares', () => {
    expect(() =>
      composeEnv([
        defineEnv('a', { SITE: url({ https: true }) }),
        defineEnv('b', { SITE: url() }),
      ]),
    ).toThrow(/SITE is declared as url\(\{"https":true/)
  })

  it('oneOf()', () => {
    expect(one(oneOf(['dev', 'production']))('dev')).toEqual({
      ok: true,
      value: 'dev',
    })
    const result = one(oneOf(['dev', 'production']))('staging')
    expect(result.ok).toBe(false)
    expect(!result.ok && result.issues?.[0]?.message).toBe(
      'KEY is invalid: expected one of: dev, production',
    )
  })

  it('json() takes a JSON string or an already parsed value', () => {
    const list = ['http://localhost:8787', 'https://app.example.com']
    expect(one(json(origins))(JSON.stringify(list))).toEqual({
      ok: true,
      value: list,
    })
    expect(one(json(origins))(list)).toEqual({ ok: true, value: list })
    expect(one(json(origins))('["not a url"]').ok).toBe(false)
    expect(one(json(origins))('[unclosed').ok).toBe(false)
  })

  it('optional(): unset gives undefined; an empty string counts as unset', () => {
    expect(one(url().optional())(undefined)).toEqual({
      ok: true,
      value: undefined,
    })
    expect(one(url().optional())('')).toEqual({ ok: true, value: undefined })
    expect(one(url().optional())('nope').ok).toBe(false)
  })

  it('default(): unset gives the default; a set value wins', () => {
    expect(one(number().default(3))(undefined)).toEqual({ ok: true, value: 3 })
    expect(one(number().default(3))('5')).toEqual({ ok: true, value: 5 })
    expect(one(string())('').ok).toBe(false)
  })

  it('defineEnv refuses a key that is not upper snake case', () => {
    expect(() => defineEnv('bad', { apiKey: string() })).toThrow(
      /upper snake case/,
    )
  })
})

const core = defineEnv('core', {
  ALLOWED_ORIGINS: json(origins),
  LOG_LEVEL: oneOf(['debug', 'info', 'warn']).default('info'),
  PUBLIC_SITE_URL: url(),
})
const billing = defineEnv('billing', {
  PADDLE_API_KEY: string(),
  PADDLE_ENVIRONMENT: oneOf(['sandbox', 'production']),
  PUBLIC_PADDLE_CLIENT_TOKEN: string().optional(),
})

describe('composeEnv', () => {
  it('merges fragments and splits client from server keys', () => {
    const composed = composeEnv([core, billing])
    expect(composed.keys).toEqual({
      server: [
        'ALLOWED_ORIGINS',
        'LOG_LEVEL',
        'PADDLE_API_KEY',
        'PADDLE_ENVIRONMENT',
      ],
      client: ['PUBLIC_PADDLE_CLIENT_TOKEN', 'PUBLIC_SITE_URL'],
    })
    expect(composed.sources.PADDLE_API_KEY).toEqual(['billing'])
  })

  it('merges a key two fragments declare the same way', () => {
    const again = defineEnv('again', {
      PADDLE_ENVIRONMENT: oneOf(['sandbox', 'production']),
      LOG_LEVEL: oneOf(['debug', 'info', 'warn']).default('info'),
    })
    const composed = composeEnv([core, billing, again])
    expect(composed.sources.PADDLE_ENVIRONMENT).toEqual(['billing', 'again'])
    expect(composed.sources.LOG_LEVEL).toEqual(['core', 'again'])
  })

  it('refuses a key declared differently, naming both fragments', () => {
    const clash = defineEnv('mail', { PADDLE_API_KEY: url() })
    expect(() => composeEnv([core, billing, clash])).toThrow(
      /PADDLE_API_KEY is declared as string by fragment "billing" and as url by fragment "mail"/,
    )
    const optional = defineEnv('mail', { PADDLE_API_KEY: string().optional() })
    expect(() => composeEnv([billing, optional])).toThrow(/"billing".*"mail"/)
    const otherDefault = defineEnv('logs', {
      LOG_LEVEL: oneOf(['debug', 'info', 'warn']).default('warn'),
    })
    expect(() => composeEnv([core, otherDefault])).toThrow(/"core".*"logs"/)
  })

  it('treats json() validators as identical only when they share the schema', () => {
    const shared = defineEnv('shared', { ALLOWED_ORIGINS: json(origins) })
    expect(() => composeEnv([core, shared])).not.toThrow()
    const copy = defineEnv('copy', {
      ALLOWED_ORIGINS: json(z.array(z.url()).min(1)),
    })
    expect(() => composeEnv([core, copy])).toThrow(/"core".*"copy"/)
  })
})

describe('checkEnv', () => {
  const composed = composeEnv([core, billing])
  const valid = {
    ALLOWED_ORIGINS: '["http://localhost:8787"]',
    PUBLIC_SITE_URL: 'http://localhost:8787',
    PADDLE_API_KEY: SECRET,
    PADDLE_ENVIRONMENT: 'sandbox',
  }

  it('local: passes complete values', () => {
    expect(checkEnv(composed, valid, { mode: 'local' })).toEqual({ ok: true })
  })

  it('local: reports missing and invalid keys without echoing a value', () => {
    const result = checkEnv(
      composed,
      {
        ...valid,
        PADDLE_API_KEY: '',
        PADDLE_ENVIRONMENT: SECRET,
        ALLOWED_ORIGINS: `["${SECRET}"]`,
        PUBLIC_SITE_URL: SECRET,
      },
      { mode: 'local' },
    )
    expect(result.ok).toBe(false)
    const issues = result.ok ? [] : result.issues
    expect(issues.map(({ key, problem }) => ({ key, problem }))).toEqual([
      { key: 'ALLOWED_ORIGINS', problem: 'invalid' },
      { key: 'PADDLE_API_KEY', problem: 'missing' },
      { key: 'PADDLE_ENVIRONMENT', problem: 'invalid' },
      { key: 'PUBLIC_SITE_URL', problem: 'invalid' },
    ])
    for (const issue of issues) {
      expect(issue.message).not.toContain(SECRET)
      expect(issue.message).not.toContain('do-not-echo')
      expect(issue.message.startsWith(issue.key)).toBe(true)
    }
  })

  it('local: an unparsable JSON value is invalid, and the parser text is not echoed', () => {
    const result = checkEnv(
      composed,
      { ...valid, ALLOWED_ORIGINS: `{${SECRET}` },
      { mode: 'local' },
    )
    expect(result).toEqual({
      ok: false,
      issues: [
        {
          key: 'ALLOWED_ORIGINS',
          problem: 'invalid',
          message:
            'ALLOWED_ORIGINS is invalid: expected JSON matching the declared schema',
        },
      ],
    })
  })

  it('names: reports only required server keys that are not set', () => {
    expect(checkEnv(composed, ['PADDLE_API_KEY'], { mode: 'names' })).toEqual({
      ok: false,
      issues: [
        {
          key: 'ALLOWED_ORIGINS',
          problem: 'missing',
          message: 'ALLOWED_ORIGINS is required and not set',
        },
        {
          key: 'PADDLE_ENVIRONMENT',
          problem: 'missing',
          message: 'PADDLE_ENVIRONMENT is required and not set',
        },
      ],
    })
    expect(
      checkEnv(
        composed,
        ['ALLOWED_ORIGINS', 'PADDLE_API_KEY', 'PADDLE_ENVIRONMENT'],
        {
          mode: 'names',
        },
      ),
    ).toEqual({ ok: true })
  })
})

describe('checkEnv: cross-field checks', () => {
  // Two key pairs and a provider switch, as the starter declares them.
  const auth = defineEnv(
    'auth',
    {
      GOOGLE_CLIENT_ID: string().optional(),
      GOOGLE_CLIENT_SECRET: string().optional(),
    },
    {
      check: (env) =>
        env.isSet('GOOGLE_CLIENT_ID') === env.isSet('GOOGLE_CLIENT_SECRET')
          ? []
          : [
              {
                key: env.isSet('GOOGLE_CLIENT_ID')
                  ? 'GOOGLE_CLIENT_SECRET'
                  : 'GOOGLE_CLIENT_ID',
                problem: 'missing',
                message:
                  'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET go together',
              },
            ],
    },
  )
  const mail = defineEnv(
    'mail',
    {
      MAIL_PROVIDER: oneOf(['cloudflare', 'resend']).optional(),
      RESEND_API_KEY: string().optional(),
    },
    {
      check: (env) => {
        expectTypeOf(env.value('MAIL_PROVIDER')).toEqualTypeOf<
          'cloudflare' | 'resend' | undefined
        >()
        return env.value('MAIL_PROVIDER') === 'resend' &&
          !env.isSet('RESEND_API_KEY')
          ? [
              {
                key: 'RESEND_API_KEY',
                problem: 'missing',
                message: 'RESEND_API_KEY is required with MAIL_PROVIDER=resend',
              },
            ]
          : []
      },
    },
  )
  const composed = composeEnv([auth, mail])
  const keys = (result: ReturnType<typeof checkEnv>) =>
    result.ok ? [] : result.issues.map((issue) => issue.key)

  it('composeEnv keeps each fragment check, in fragment order', () => {
    expect(composed.checks.map((c) => c.fragment)).toEqual(['auth', 'mail'])
    expect(composeEnv([core]).checks).toEqual([])
  })

  it('local: runs the checks over the values', () => {
    expect(checkEnv(composed, {}, { mode: 'local' })).toEqual({ ok: true })
    expect(
      keys(checkEnv(composed, { GOOGLE_CLIENT_ID: 'id' }, { mode: 'local' })),
    ).toEqual(['GOOGLE_CLIENT_SECRET'])
    expect(
      keys(checkEnv(composed, { MAIL_PROVIDER: 'resend' }, { mode: 'local' })),
    ).toEqual(['RESEND_API_KEY'])
    expect(
      checkEnv(
        composed,
        { MAIL_PROVIDER: 'resend', RESEND_API_KEY: SECRET },
        { mode: 'local' },
      ),
    ).toEqual({ ok: true })
  })

  it('local: an invalid value is not passed to a check', () => {
    expect(
      keys(checkEnv(composed, { MAIL_PROVIDER: 'smtp' }, { mode: 'local' })),
    ).toEqual(['MAIL_PROVIDER'])
  })

  it('local: a key in present counts as set, with no value and no issue', () => {
    expect(
      checkEnv(
        composed,
        { GOOGLE_CLIENT_ID: 'id' },
        {
          mode: 'local',
          present: ['GOOGLE_CLIENT_SECRET'],
        },
      ),
    ).toEqual({ ok: true })
    // MAIL_PROVIDER's value is unknown, so the provider rule cannot fire.
    expect(
      checkEnv(composed, {}, { mode: 'local', present: ['MAIL_PROVIDER'] }),
    ).toEqual({ ok: true })
    // A required key named in present is not reported missing.
    expect(
      checkEnv(
        composeEnv([billing]),
        { PADDLE_ENVIRONMENT: 'sandbox' },
        {
          mode: 'local',
          present: ['PADDLE_API_KEY'],
        },
      ),
    ).toEqual({ ok: true })
  })

  it('names: isSet from the names, value() from the known values only', () => {
    expect(
      keys(checkEnv(composed, ['GOOGLE_CLIENT_SECRET'], { mode: 'names' })),
    ).toEqual(['GOOGLE_CLIENT_ID'])
    expect(
      keys(
        checkEnv(composed, ['MAIL_PROVIDER'], {
          mode: 'names',
          values: { MAIL_PROVIDER: 'resend' },
        }),
      ),
    ).toEqual(['RESEND_API_KEY'])
    expect(
      checkEnv(composed, ['MAIL_PROVIDER', 'RESEND_API_KEY'], {
        mode: 'names',
        values: { MAIL_PROVIDER: 'resend' },
      }),
    ).toEqual({ ok: true })
    // Without a known value the provider rule cannot fire; a known value of
    // a key that is not in the names does not count.
    expect(checkEnv(composed, ['MAIL_PROVIDER'], { mode: 'names' })).toEqual({
      ok: true,
    })
    expect(
      checkEnv(composed, [], {
        mode: 'names',
        values: { MAIL_PROVIDER: 'resend' },
      }),
    ).toEqual({ ok: true })
  })
})

describe('parseEnv', () => {
  const composed = composeEnv([core, billing])

  it('returns the typed values', () => {
    const env = parseEnv(composed, {
      ALLOWED_ORIGINS: ['http://localhost:8787'],
      PUBLIC_SITE_URL: 'http://localhost:8787',
      PADDLE_API_KEY: SECRET,
      PADDLE_ENVIRONMENT: 'production',
      UNDECLARED: 'ignored',
    })
    expect(env).toEqual({
      ALLOWED_ORIGINS: ['http://localhost:8787'],
      LOG_LEVEL: 'info',
      PUBLIC_SITE_URL: 'http://localhost:8787',
      PADDLE_API_KEY: SECRET,
      PADDLE_ENVIRONMENT: 'production',
      PUBLIC_PADDLE_CLIENT_TOKEN: undefined,
    })
    expect(Object.isFrozen(env)).toBe(true)
    expectTypeOf(env.ALLOWED_ORIGINS).toEqualTypeOf<string[]>()
    expectTypeOf(env.LOG_LEVEL).toEqualTypeOf<'debug' | 'info' | 'warn'>()
    expectTypeOf(env.PADDLE_ENVIRONMENT).toEqualTypeOf<
      'sandbox' | 'production'
    >()
    expectTypeOf(env.PADDLE_API_KEY).toEqualTypeOf<string>()
    expectTypeOf(env.PUBLIC_PADDLE_CLIENT_TOKEN).toEqualTypeOf<
      string | undefined
    >()
    expectTypeOf<keyof typeof env>().toEqualTypeOf<
      | 'ALLOWED_ORIGINS'
      | 'LOG_LEVEL'
      | 'PUBLIC_SITE_URL'
      | 'PADDLE_API_KEY'
      | 'PADDLE_ENVIRONMENT'
      | 'PUBLIC_PADDLE_CLIENT_TOKEN'
    >()
  })

  it('throws EnvError naming every bad key and no value', () => {
    let error: unknown
    try {
      parseEnv(composed, { PADDLE_API_KEY: SECRET, PADDLE_ENVIRONMENT: SECRET })
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(EnvError)
    const { message, issues } = error as EnvError
    expect(issues.map((issue) => issue.key)).toEqual([
      'ALLOWED_ORIGINS',
      'PADDLE_ENVIRONMENT',
      'PUBLIC_SITE_URL',
    ])
    expect(message).toMatch(
      /ALLOWED_ORIGINS.*PADDLE_ENVIRONMENT.*PUBLIC_SITE_URL/,
    )
    expect(message).not.toContain(SECRET)
  })
})
