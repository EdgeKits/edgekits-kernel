import type { z } from 'zod'
import type {
  aiSchema,
  authSchema,
  paddleBillingSchema,
  tenancySchema,
} from './schema.js'

// Each factory tags its options with a kind; defineSaaS() validates them.
type Options<S extends z.ZodType> = Omit<z.input<S>, 'kind'>
type Tagged<K extends string, O = object> = { kind: K } & O

export const tenancy = {
  orgs: (
    opts: Options<typeof tenancySchema>,
  ): Tagged<'orgs', Options<typeof tenancySchema>> => ({
    kind: 'orgs' as const,
    ...opts,
  }),
}

export const auth = {
  betterAuth: (
    opts: Options<typeof authSchema>,
  ): Tagged<'better-auth', Options<typeof authSchema>> => ({
    kind: 'better-auth' as const,
    ...opts,
  }),
}

export const billing = {
  paddle: (
    opts: Options<typeof paddleBillingSchema>,
  ): Tagged<'paddle', Options<typeof paddleBillingSchema>> => ({
    kind: 'paddle' as const,
    ...opts,
  }),
}

export const flags = {
  kv: (): Tagged<'kv'> => ({ kind: 'kv' }),
  flagship: (): Tagged<'flagship'> => ({ kind: 'flagship' }),
}

export const ai = {
  gateway: (
    opts: Options<typeof aiSchema>,
  ): Tagged<'gateway', Options<typeof aiSchema>> => ({
    kind: 'gateway' as const,
    ...opts,
  }),
}

export const admin = {
  worker: (opts: {
    access: 'cloudflare-access'
  }): Tagged<'worker', { access: 'cloudflare-access' }> => ({
    kind: 'worker' as const,
    ...opts,
  }),
  none: (): Tagged<'none'> => ({ kind: 'none' }),
}
