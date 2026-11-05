# @edgekits/kernel

The core of the EdgeKits SaaS Kit for Cloudflare Workers: multi-tenant data access, permissions and entitlements, billing events and provider ports, the admin contract, a typed blueprint and env, and the Hono and Astro middleware that wires them into a Worker. It is TypeScript, runs on `workerd`, stores its data in D1 through Drizzle, and has no Cloudflare runtime dependency beyond types.

## What it is, and what it is not

The kernel is a library of contracts and guarantees. An app imports the pieces it needs and supplies the rest:

- It **is** the tenant boundary (`TenantContext`, tenant tables, tenant-bound repositories), the policy engine, the plan catalog, the event vocabulary, the provider ports, the admin RPC contract and the request middleware.
- It is **not** a framework or an app. It registers no routes, ships no UI, and implements no authentication. Sessions, membership lookup, the billing adapter, the mail sender and the `AdminRpc` implementation are the app's: the kernel defines their shape and checks what it receives.
- It is **not** a hosted service. Nothing calls home, and the only network request the kernel makes is the Cloudflare Access JWKS fetch in `accessIdentity()`.

The **EdgeKits SaaS Starter** is the paid composition built on this kernel: three Workers (site, app, admin) with Better Auth, Paddle billing, Workflows, the admin, the deploy runbook and the module registry. See [edgekits.dev](https://edgekits.dev).

## Install

```sh
npm install @edgekits/kernel drizzle-orm hono
```

- `drizzle-orm` (`^0.45.4`) and `hono` (`^4.13.13`) are peer dependencies, so the app and the kernel share one copy of each.
- `eslint` (`^9` or `^10`) is an optional peer, needed only for `@edgekits/kernel/eslint`.
- `zod` is the kernel's only dependency.
- Node 22 or later runs the tooling. The runtime subpaths target Cloudflare Workers; use `@cloudflare/workers-types` for the D1 types.

## Subpaths

The package root exports nothing. Import from a subpath:

| Subpath                    | What it holds                                                                                                                                                    |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@edgekits/kernel/tenancy` | `TenantContext`, `resolveTenant()`, `tenantTable()`, `tenantReference()`, tenant-bound repositories, the dev-time query guard, org claims                        |
| `@edgekits/kernel/policy`  | the policy engine (`can()`, `entitled()`, `entitlementFlags()`), the entitlement resolver, subscriptions, overrides, suspension, kernel trials, the plan catalog |
| `@edgekits/kernel/events`  | the `KernelEvent` vocabulary, `InboundEvent`, the `EventBus` port, the subscription reducer                                                                      |
| `@edgekits/kernel/ports`   | the `BillingProvider` and `MailProvider` ports, billing capability manifests, price checks                                                                       |
| `@edgekits/kernel/admin`   | the `AdminRpc` contract and `accessIdentity()`, the Cloudflare Access middleware                                                                                 |
| `@edgekits/kernel/config`  | `defineSaaS()`, the typed blueprint, provider validation, the typed env                                                                                          |
| `@edgekits/kernel/hono`    | `tenant()`, `requirePlan()`, `errors()`, `noStore()`, `sameOrigin()`, `securityHeaders()`                                                                        |
| `@edgekits/kernel/astro`   | `KernelLocals` and `toLocals()` for Astro locals                                                                                                                 |
| `@edgekits/kernel/eslint`  | `tenantTables()`, the flat-config fragment with the tenant-table rules                                                                                           |

### `/tenancy`

```ts
import { tenantTable } from '@edgekits/kernel/tenancy'
import { text } from 'drizzle-orm/sqlite-core'

// Adds org_id and its index; the primary key is (org_id, id).
export const projects = tenantTable('projects', {
  id: text(),
  name: text().notNull(),
})

// In a repository: every query is bound to ctx.orgId.
const rows = await ctx.db.repo(projects).findMany()
```

### `/policy`

```ts
import { createPolicyEngine, planSource } from '@edgekits/kernel/policy'

const policy = createPolicyEngine({
  entitlements: blueprint.entitlements,
  roles: blueprint.roles,
  plans: planSource(db),
  counters: { projects: (ctx) => countProjects(ctx) },
})

policy.requirePermission(ctx, 'project.write') // 403 through errors()
await policy.requireEntitlement(ctx, 'projects') // 402 at the limit
```

### `/events`

```ts
import {
  applySubscriptionEvents,
  type BillingEvent,
} from '@edgekits/kernel/events'

// Pure: the same events give the same state in any order, duplicates once.
const state = applySubscriptionEvents(events as BillingEvent[])
state.status // 'active' | 'trialing' | 'canceled' | ...
```

### `/ports`

```ts
import {
  assertPriceSupported,
  paddleCapabilities,
} from '@edgekits/kernel/ports'

// Throws CapabilityError (400 through errors()) before any provider call.
assertPriceSupported('paddle', paddleCapabilities, {
  amount: 1900,
  currency: 'USD',
  period: 'month',
  model: 'flat',
})
```

### `/admin`

```ts
import { accessIdentity } from '@edgekits/kernel/admin'

admin.use(
  accessIdentity({
    teamDomain: env.ACCESS_TEAM_DOMAIN, // https://<team>.cloudflareaccess.com
    aud: env.ACCESS_AUD, // required outside mode 'dev'
    mode: 'production',
    build: import.meta.env.DEV ? 'dev' : 'production',
  }),
)
// c.var.admin is { admin: { id, email }, request }
```

### `/config`

```ts
import { auth, billing, defineSaaS, tenancy } from '@edgekits/kernel/config'

export default defineSaaS({
  name: 'acme',
  locales: ['en'],
  tenancy: tenancy.orgs({
    personalWorkspace: true,
    isolation: 'shared-d1',
    residency: 'none',
  }),
  auth: auth.betterAuth({ methods: ['magic-link'], invitations: true }),
  entitlements: { projects: { kind: 'limit' }, ai: { kind: 'switch' } },
  billing: billing.paddle({ model: 'flat', currency: 'USD' }),
})
```

```ts
import {
  composeEnv,
  defineEnv,
  parseEnv,
  string,
  url,
} from '@edgekits/kernel/config'

const schema = composeEnv([
  defineEnv('auth', {
    AUTH_SECRET: string({ min: 32 }),
    APP_URL: url({ https: true }),
  }),
])
const env = parseEnv(schema, workerEnv) // typed and frozen; errors name keys, never values
```

### `/hono`

```ts
import {
  errors,
  noStore,
  requirePlan,
  sameOrigin,
  securityHeaders,
  tenant,
} from '@edgekits/kernel/hono'

app.use(securityHeaders(), sameOrigin({ allowed: ['https://app.example.com'] }))
app.use(
  '/app/*',
  tenant({ session, orgFromRequest: () => null, deps }),
  noStore(),
)
app.use(
  '/app/*',
  requirePlan({ policy, allow: ['/app/billing'], billingPath: '/app/billing' }),
)
app.onError(errors())
```

### `/astro`

```ts
import { toLocals, type KernelLocals } from '@edgekits/kernel/astro'

declare global {
  namespace App {
    interface Locals extends KernelLocals {}
  }
}
// In the Worker, before the Astro handler: Object.assign(locals, toLocals(c))
```

### `/eslint`

```js
// eslint.config.js
import tseslint from 'typescript-eslint'
import { tenantTables } from '@edgekits/kernel/eslint'

export default tseslint.config(
  ...tseslint.configs.recommended,
  ...tenantTables({ repositories: ['apps/*/src/modules/*/repository.ts'] }),
)
```

## The tenancy guarantee

Tenant data is reached only through a `TenantContext`, and the guarantee holds in three layers:

1. **Tenant-bound repositories.**
   - `tenantTable()` adds the `org_id` column and its index, keys a table with an `id` by `(org_id, id)`, and registers it as a tenant table.
   - `ctx.db.repo(table)` accepts only registered tables. It binds `org_id = ctx.orgId` to every read, update and delete, groups the caller's own predicate inside that binding, and sets `org_id` on every insert. No method takes an org id, and an `orgId` in the values is dropped.
   - `resolveTenant()` builds the context only after it has checked that the org exists and the user is a member, on every request. The org id from a session or an API key is never trusted on its own.
   - `tenantReference()` makes references between tenant tables composite foreign keys that carry `org_id`.
2. **The lint rule.** `@edgekits/kernel/eslint` reports any import of a tenant table outside the repositories and the allowed files, including the kernel's own tenant tables by name.
3. **The dev-time query guard.** `tenantGuardLogger({ mode: 'strict' })`, set on the Drizzle client in development and tests, throws on a select, update or delete of a tenant table without an `org_id` predicate. It catches raw SQL the lint cannot see.

## Billing port and capability manifest

`BillingProvider` is the contract a billing adapter implements:

- **Webhooks:** `verify` over the raw body and secret, `parse`, `normalize` into `BillingEvent`s, and `fetchSubscription` for the re-fetch before entitlements are written.
- **Checkout, portal and plan changes:** checkout and the portal URL, `changePlan()` with every `ProrationMode` (`immediate`, `none`, `period-end`), `cancel()`, `keep()` and refunds.
- **The catalog:** products and prices.

A provider's capabilities are data, a `BillingCapabilities` manifest such as `paddleCapabilities`: currencies, billing models, proration modes, trials and refunds. The manifest is used in two places:

- `validateAgainstProviders(blueprint, capabilities)` in `/config` checks the blueprint's billing choices against it.
- `assertPriceSupported()` checks each price before a provider call.

The kernel's guidance for webhooks:

- verify the raw body byte-exact;
- treat events as unordered and duplicated;
- re-fetch the subscription before writing entitlements (`applyProviderSubscription()` refuses a stale or foreign-provider overwrite);
- acknowledge fast and apply in a durable step.

## The admin contract

`AdminRpc` is the interface an app's Worker entrypoint implements for an operator console. It covers:

- orgs, members, users and activity;
- entitlement overrides, suspension, trials and refunds;
- the plan catalog and settings;
- impersonation, org claims, invitations, user blocks and the billing contact.

Every method takes an `AdminContext`, the verified operator. `accessIdentity()` produces it from the Cloudflare Access JWT in `Cf-Access-Jwt-Assertion`:

- RS256 against the team JWKS;
- `iss`, `aud` and `exp` checked;
- `mode: 'dev'` refused in a production build.

Every write emits its `admin.*` event (`AdminEvent` in `/events`).

## The event vocabulary

`KernelEvent` is one discriminated union:

- **`BillingEvent`:** subscriptions, invoices, refunds, disputes, credits, licenses and rejected notifications.
- **`OrgEvent`:** org creation, members and invitations, the billing contact.
- **`LifecycleEvent`:** trials.
- **`AdminEvent`:** every operator action.

Every event names its org, its time and a `sourceId`, the idempotency key of the fact itself. Events that belong to no org use `systemOrgId`. An `EventBus` publishes them, and `noopEventBus` is the default.

## Versioning

The package follows semantic versioning with the 0.x rule. Until 1.0:

- a minor release (0.2.0) may contain breaking changes, and each is listed in [CHANGELOG.md](./CHANGELOG.md) with its migration;
- a patch release never breaks.

Pin a minor range (`~0.1.0`) or an exact version.

## Development

`npm run ci` runs the whole gate, in order:

1. `npm ci`
2. Prettier
3. ESLint (with the subpath boundary rule)
4. `tsc` (including a check of the built declarations from a consumer's side, and a plain-Node import of every subpath)
5. the Vitest suites (`workerd` with a local D1, and Node)

## Releasing

Releases are published by `.github/workflows/publish.yml` through npm trusted publishing (OIDC): the workflow holds no npm token, and every release carries an npm provenance statement that links the tarball to its commit and workflow run.

1. Bump `version` in `package.json` (and the lockfile's root entry) and add the release to `CHANGELOG.md`; commit.
2. Tag the commit `v<version>` (for example `v0.1.1`) and push the tag.
3. The workflow checks that the tag names `package.json`'s version, runs `npm ci && npm run ci`, and publishes.

0.1.0 was published by hand and carries no provenance; provenance starts with 0.1.1.

## License

MIT
