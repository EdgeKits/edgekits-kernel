// Uses the built declarations in dist/ the way a consumer does. tsconfig.json
// maps @edgekits/kernel/* to ../../dist/*/index.d.ts; check.mjs type-checks
// this file and every dist .d.ts with skipLibCheck off. Never executed.
import { text } from 'drizzle-orm/sqlite-core'
import { toLocals } from '@edgekits/kernel/astro'
import { accessIdentity } from '@edgekits/kernel/admin'
import {
  composeEnv,
  defaultRoles,
  defineEnv,
  defineSaaS,
  oneOf,
  parseEnv,
  url,
  type Blueprint,
} from '@edgekits/kernel/config'
import { applySubscriptionEvents } from '@edgekits/kernel/events'
import { errors, securityHeaders, tenant } from '@edgekits/kernel/hono'
import {
  createPolicyEngine,
  entitlementOverrides,
  expireTrials,
  loadPolicyRows,
  PolicyError,
  resolveEntitlements,
  setTrialEnd,
  startKernelTrial,
  subscriptions,
  type PolicyEngine,
  type ResolvedEntitlements,
} from '@edgekits/kernel/policy'
import { paddleCapabilities, type MailProvider } from '@edgekits/kernel/ports'
import {
  ConflictError,
  tenantReference,
  tenantTable,
  type TenantDb,
} from '@edgekits/kernel/tenancy'

export const projects = tenantTable('projects', {
  id: text(),
  name: text().notNull(),
})

export const projectsRepo = (db: TenantDb) => db.repo(projects)

type Row = NonNullable<
  Awaited<ReturnType<ReturnType<typeof projectsRepo>['findById']>>
>
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false

// Column inference survives the declaration boundary: the row is exactly
// the declared columns plus org_id, not any and not a widened shape.
export const rowShape: Equal<Row, { id: string; name: string; orgId: string }> =
  true

// A parsed blueprint is what the policy engine takes.
export const engineFor = (blueprint: Blueprint): PolicyEngine =>
  createPolicyEngine({ blueprint })

export const resolved: ResolvedEntitlements = resolveEntitlements({
  plans: { free: { projects: 3, ai: false } },
  subscriptions: [],
  overrides: [],
  now: 0,
})

// The env output type survives the declaration boundary.
const composedEnv = composeEnv([
  defineEnv('core', {
    MODE: oneOf(['dev', 'production']),
    PUBLIC_SITE_URL: url().optional(),
  }),
])
export const parsedEnv = parseEnv(composedEnv, {})
export const envShape: Equal<
  typeof parsedEnv,
  {
    readonly MODE: 'dev' | 'production'
    readonly PUBLIC_SITE_URL: string | undefined
  }
> = true

// The policy tables are exported for a consumer's migrations.
export const policyTables = [subscriptions, entitlementOverrides] as const

export const subpathExports = [
  toLocals,
  accessIdentity,
  defineSaaS,
  applySubscriptionEvents,
  errors,
  securityHeaders,
  tenant,
  PolicyError,
  defaultRoles,
  expireTrials,
  loadPolicyRows,
  setTrialEnd,
  startKernelTrial,
  ConflictError,
  tenantReference,
  paddleCapabilities,
] as const

export const mailPort: MailProvider = {
  id: 'dev',
  send: async () => ({ id: 'm1' }),
}
