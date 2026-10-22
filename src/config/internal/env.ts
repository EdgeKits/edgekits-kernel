import { z } from 'zod'

// The parts of Standard Schema v1 (https://standardschema.dev) json() uses,
// so a schema from any Zod copy, or another library, can describe a value.
export interface StandardSchema<Output = unknown> {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (
      value: unknown,
    ) => StandardResult<Output> | Promise<StandardResult<Output>>
    readonly types?: { readonly input: unknown; readonly output: Output }
  }
}

type StandardResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | {
      readonly issues: ReadonlyArray<{
        readonly message: string
        readonly path?: ReadonlyArray<
          PropertyKey | { readonly key: PropertyKey }
        >
      }>
    }

type StandardOutput<S extends StandardSchema> = NonNullable<
  S['~standard']['types']
>['output']

export type EnvPresence = 'required' | 'optional' | 'default'

type Check<T> = (raw: unknown) => { ok: true; value: T } | { ok: false }

// A validator for one env key. `expected` is the problem text for an invalid
// value; it describes the type, never the value, so a message built from it
// cannot leak a secret.
export class EnvVar<T, P extends EnvPresence = 'required'> {
  constructor(
    readonly expected: string,
    readonly signature: string,
    readonly check: Check<T>,
    readonly presence: P,
    readonly fallback?: T,
  ) {}

  // The key may be unset; the parsed value is then undefined.
  optional(): EnvVar<T, 'optional'> {
    return new EnvVar(this.expected, this.signature, this.check, 'optional')
  }

  // The key may be unset; the parsed value is then `value`. Defaults are for
  // non-sensitive fallbacks only: a credential never belongs in source.
  default(value: T): EnvVar<T, 'default'> {
    return new EnvVar(
      this.expected,
      this.signature,
      this.check,
      'default',
      value,
    )
  }
}

function fromZod<T>(schema: z.ZodType<T>): Check<T> {
  return (raw) => {
    const result = schema.safeParse(raw)
    return result.success ? { ok: true, value: result.data } : { ok: false }
  }
}

const variable = <T>(expected: string, signature: string, check: Check<T>) =>
  new EnvVar<T>(expected, signature, check, 'required')

export function string(): EnvVar<string> {
  return variable('expected a string', 'string', fromZod(z.string()))
}

// A number, or a string holding one ("8787").
export function number(): EnvVar<number> {
  const numeric = z.number().refine(Number.isFinite)
  return variable('expected a number', 'number', (raw) =>
    typeof raw === 'string'
      ? fromZod(z.string().trim().min(1).pipe(z.coerce.number()).pipe(numeric))(
          raw,
        )
      : fromZod(numeric)(raw),
  )
}

// A boolean, or a string such as "true", "false", "1", "0".
export function boolean(): EnvVar<boolean> {
  return variable('expected a boolean (true or false)', 'boolean', (raw) =>
    typeof raw === 'boolean'
      ? { ok: true, value: raw }
      : fromZod(z.stringbool())(raw),
  )
}

export function url(): EnvVar<string> {
  return variable('expected a URL', 'url', fromZod(z.url()))
}

export function email(): EnvVar<string> {
  return variable('expected an email address', 'email', fromZod(z.email()))
}

export function oneOf<const V extends readonly [string, ...string[]]>(
  values: V,
): EnvVar<V[number]> {
  return variable(
    `expected one of: ${values.join(', ')}`,
    `oneOf(${JSON.stringify(values)})`,
    fromZod(z.enum(values as unknown as [V[number], ...V[number][]])),
  )
}

// json() validators are identical only when they share the schema object.
const schemaIds = new WeakMap<object, number>()
let nextSchemaId = 1
const schemaId = (schema: object) => {
  let id = schemaIds.get(schema)
  if (id === undefined) schemaIds.set(schema, (id = nextSchemaId++))
  return id
}

// A JSON value: a string holding JSON, or a value Wrangler already parsed (a
// JSON object or array in `vars`), checked against a synchronous Standard
// Schema such as a Zod schema.
export function json<S extends StandardSchema>(
  schema: S,
): EnvVar<StandardOutput<S>> {
  const expected = 'expected JSON matching the declared schema'
  return variable(expected, `json#${schemaId(schema)}`, (raw) => {
    let value = raw
    if (typeof raw === 'string') {
      try {
        value = JSON.parse(raw)
      } catch {
        return { ok: false }
      }
    }
    const result = schema['~standard'].validate(value)
    if (result instanceof Promise) {
      throw new Error('json(): the schema must validate synchronously')
    }
    return result.issues
      ? { ok: false }
      : { ok: true, value: result.value as StandardOutput<S> }
  })
}

export type EnvShape = Record<string, EnvVar<unknown, EnvPresence>>

export interface EnvFragment<S extends EnvShape = EnvShape> {
  readonly name: string
  readonly shape: S
}

const KEY = /^[A-Z][A-Z0-9_]*$/

// One module's env keys. Keys are upper snake case; a key starting with
// PUBLIC_ is a client value (Astro's convention), any other a server value.
export function defineEnv<const S extends EnvShape>(
  name: string,
  shape: S,
): EnvFragment<S> {
  for (const key of Object.keys(shape)) {
    if (!KEY.test(key)) {
      throw new Error(
        `defineEnv('${name}'): key ${key} must be upper snake case (A-Z, 0-9, _)`,
      )
    }
  }
  return { name, shape }
}

type UnionToIntersection<U> = (
  U extends unknown ? (u: U) => void : never
) extends (i: infer I) => void
  ? I
  : never

type Merged<F extends readonly EnvFragment[]> = {
  [K in keyof UnionToIntersection<F[number]['shape']>]: UnionToIntersection<
    F[number]['shape']
  >[K]
}

export interface ComposedEnv<S = EnvShape> {
  readonly schema: S
  readonly keys: { server: string[]; client: string[] }
  // The fragments that declare each key.
  readonly sources: Readonly<Record<string, readonly string[]>>
}

const isClientKey = (key: string) => key.startsWith('PUBLIC_')

const describe = (v: EnvVar<unknown, EnvPresence>) =>
  `${v.signature}${v.presence === 'required' ? '' : `.${v.presence}(${v.presence === 'default' ? JSON.stringify(v.fallback) : ''})`}`

// Merges fragments into one schema. A key declared by two fragments must be
// declared the same way (type, presence and default); it is then merged.
export function composeEnv<const F extends readonly EnvFragment[]>(
  fragments: F,
): ComposedEnv<Merged<F>> {
  const schema: EnvShape = {}
  const sources: Record<string, string[]> = {}
  for (const fragment of fragments) {
    for (const [key, variable] of Object.entries(fragment.shape)) {
      const existing = schema[key]
      if (existing && describe(existing) !== describe(variable)) {
        throw new Error(
          `composeEnv: ${key} is declared as ${describe(existing)} by fragment "${sources[key]?.join('", "')}" and as ${describe(variable)} by fragment "${fragment.name}"`,
        )
      }
      schema[key] = existing ?? variable
      ;(sources[key] ??= []).push(fragment.name)
    }
  }
  const keys = Object.keys(schema).sort()
  return {
    schema: schema as Merged<F>,
    keys: {
      server: keys.filter((key) => !isClientKey(key)),
      client: keys.filter(isClientKey),
    },
    sources,
  }
}

export interface EnvIssue {
  key: string
  problem: 'missing' | 'invalid'
  // Names the key and the expected type; never contains the value.
  message: string
}

export type EnvCheckResult = { ok: true } | { ok: false; issues: EnvIssue[] }

// Unset: absent, null, or an empty string.
const isUnset = (raw: unknown) =>
  raw === undefined || raw === null || raw === ''

const missing = (key: string): EnvIssue => ({
  key,
  problem: 'missing',
  message: `${key} is required and not set`,
})

type Values = Readonly<Record<string, unknown>>

function evaluate(composed: ComposedEnv, values: Values) {
  const issues: EnvIssue[] = []
  const parsed: Record<string, unknown> = {}
  // Sorted by key, so a report reads the same whatever the fragment order.
  for (const key of Object.keys(composed.schema).sort()) {
    const variable = composed.schema[key] as EnvVar<unknown, EnvPresence>
    const raw = Object.hasOwn(values, key) ? values[key] : undefined
    if (isUnset(raw)) {
      if (variable.presence === 'required') issues.push(missing(key))
      else parsed[key] = variable.fallback
      continue
    }
    const result = variable.check(raw)
    if (result.ok) parsed[key] = result.value
    else {
      issues.push({
        key,
        problem: 'invalid',
        message: `${key} is invalid: ${variable.expected}`,
      })
    }
  }
  return { issues, parsed }
}

// 'local' validates values against the schema. 'names' takes the names that
// are set (for example from `wrangler secret list` and the deployed vars) and
// reports the required server keys among them that are missing; client keys
// are build-time values and are not checked there.
export function checkEnv(
  composed: ComposedEnv,
  values: Values,
  options: { mode: 'local' },
): EnvCheckResult
export function checkEnv(
  composed: ComposedEnv,
  names: readonly string[],
  options: { mode: 'names' },
): EnvCheckResult
export function checkEnv(
  composed: ComposedEnv,
  input: Values | readonly string[],
  options: { mode: 'local' | 'names' },
): EnvCheckResult {
  let issues: EnvIssue[]
  if (options.mode === 'names') {
    const names = new Set(input as readonly string[])
    issues = composed.keys.server
      .filter((key) => composed.schema[key]?.presence === 'required')
      .filter((key) => !names.has(key))
      .map(missing)
  } else {
    issues = evaluate(composed, input as Values).issues
  }
  return issues.length === 0 ? { ok: true } : { ok: false, issues }
}

// Read-only: parseEnv() freezes the object it returns.
export type EnvOutput<S> = {
  readonly [K in keyof S]: S[K] extends EnvVar<infer T, infer P>
    ? P extends 'optional'
      ? T | undefined
      : T
    : never
}

// Thrown by parseEnv(); the message and issues name keys, never values.
export class EnvError extends Error {
  override name = 'EnvError'

  constructor(readonly issues: EnvIssue[]) {
    super(`Invalid environment: ${issues.map((i) => i.message).join('; ')}`)
  }
}

// The typed values of the composed keys; throws EnvError naming every
// missing or invalid key.
export function parseEnv<S>(
  composed: ComposedEnv<S>,
  values: Values,
): EnvOutput<S> {
  // S is the shape composeEnv() built; every value in it is an EnvVar.
  const { issues, parsed } = evaluate(composed as ComposedEnv, values)
  if (issues.length > 0) throw new EnvError(issues)
  return Object.freeze(parsed) as EnvOutput<S>
}
