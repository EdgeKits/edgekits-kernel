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
import {
  applySubscriptionEvents,
  noopEventBus,
  type EventBus,
} from '@edgekits/kernel/events'
import { errors, securityHeaders, tenant } from '@edgekits/kernel/hono'
import {
  addPrice,
  applyProviderSubscription,
  archivePlan,
  archivePrice,
  createPlan,
  createPolicyEngine,
  entitlementOverrides,
  expireTrials,
  getPlan,
  listPlans,
  loadPolicyRows,
  PlanError,
  planForPrice,
  planInputIssues,
  planPrices,
  plans,
  planSource,
  PolicyError,
  priceForPlan,
  resolveEntitlements,
  setDefaultPlan,
  setTrialEnd,
  startKernelTrial,
  subscriptions,
  updatePlan,
  type EntitlementSource,
  type PlanRecord,
  type PlanSource,
  type PolicyEngine,
  type ResolvedEntitlements,
} from '@edgekits/kernel/policy'
import {
  assertPriceSupported,
  CapabilityError,
  paddleCapabilities,
  type BillingProvider,
  type CatalogPriceInput,
  type MailProvider,
  type ProrationMode,
} from '@edgekits/kernel/ports'
import {
  ConflictError,
  tenantReference,
  tenantTable,
  type OrgRecord,
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

// An org record carries no plan: the policy engine resolves the plan from the
// org's subscriptions rows.
export const orgShape: Equal<
  OrgRecord,
  { id: string; kind: 'personal' | 'team'; slug: string }
> = true

// The policy engine takes the blueprint's vocabulary and roles and the plan
// catalog's source (ADR-010).
export const engineFor = (
  blueprint: Blueprint,
  source: PlanSource,
): PolicyEngine =>
  createPolicyEngine({
    entitlements: blueprint.entitlements,
    roles: blueprint.roles,
    plans: source,
  })

export const resolved: ResolvedEntitlements = resolveEntitlements({
  plans: { free: { projects: 3, ai: false } },
  defaultPlan: 'free',
  subscriptions: [],
  overrides: [],
  now: 0,
})

// The fallback source is the default plan; the old 'free' member is gone.
export const sources: Equal<
  EntitlementSource,
  'override' | 'lifetime' | 'subscription' | 'trial' | 'default' | 'none'
> = true

export const planShape: Equal<
  keyof PlanRecord,
  | 'id'
  | 'name'
  | 'entitlements'
  | 'isDefault'
  | 'trial'
  | 'sortOrder'
  | 'createdAt'
  | 'updatedAt'
  | 'archivedAt'
  | 'prices'
> = true

// The port's catalog and subscription methods, and changePlan's modes.
type Port = BillingProvider
export const portShape: [
  Equal<Parameters<Port['changePlan']>[2], ProrationMode>,
  Equal<ProrationMode, 'immediate' | 'none' | 'period-end'>,
  Equal<Parameters<Port['cancel']>[1], 'period-end' | 'now'>,
  Equal<
    Awaited<ReturnType<Port['createProduct']>>,
    { providerProductId: string }
  >,
  Equal<Parameters<Port['createPrice']>[0], CatalogPriceInput>,
  Equal<Awaited<ReturnType<Port['createPrice']>>, { providerPriceId: string }>,
  Equal<Parameters<Port['archivePrice']>, [providerPriceId: string]>,
  Equal<Parameters<Port['keep']>[0], Parameters<Port['portalUrl']>[0]>,
] = [true, true, true, true, true, true, true, true]

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
export const policyTables = [
  subscriptions,
  entitlementOverrides,
  plans,
  planPrices,
] as const

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
  applyProviderSubscription,
  expireTrials,
  loadPolicyRows,
  setTrialEnd,
  startKernelTrial,
  addPrice,
  archivePlan,
  archivePrice,
  createPlan,
  getPlan,
  listPlans,
  PlanError,
  planForPrice,
  planInputIssues,
  planSource,
  priceForPlan,
  setDefaultPlan,
  updatePlan,
  ConflictError,
  tenantReference,
  paddleCapabilities,
  assertPriceSupported,
  CapabilityError,
] as const

export const mailPort: MailProvider = {
  id: 'dev',
  send: async () => ({ id: 'm1' }),
}

export const eventBus: EventBus = noopEventBus
