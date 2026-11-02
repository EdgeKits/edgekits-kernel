// AdminContext and the AdminRpc contract exposed to the admin Worker.
import type { Currency } from '@edgekits/kernel/events'
import type {
  EntitlementKey,
  EntitlementOverrideRecord,
  EntitlementSource,
  EntitlementValue,
  PlanPatch,
  PlanRecord,
  PlanTrial,
  SubscriptionRecord,
  SuspensionRecord,
} from '@edgekits/kernel/policy'
import type { PricePeriod, ProviderTransaction } from '@edgekits/kernel/ports'
import type {
  AdminId,
  OrgId,
  OrgRecord,
  PlanId,
  RoleId,
  UserId,
} from '@edgekits/kernel/tenancy'

export {
  accessIdentity,
  type AccessIdentityOptions,
  type AdminVariables,
  type Jwks,
} from './internal/access.js'

export const subpath = 'admin' as const

export interface AdminContext {
  // From the Access JWT (ADR-002a): id is sub, email is email.
  readonly admin: { id: AdminId; email: string }
  readonly request: { id: string }
}

// One page of a list; next is the cursor of the following page, or null on
// the last one.
export interface Page<T> {
  items: T[]
  next: string | null
}

// active: a paid subscription; trialing: a provider or kernel trial;
// suspended: an admin suspended it (whatever its plan); none: no
// subscription or trial (the default plan, if any).
export type OrgStatus = 'active' | 'trialing' | 'suspended' | 'none'

// Timestamps are epoch milliseconds.
export interface OrgSummary {
  id: OrgId
  name: string
  slug: string
  kind: OrgRecord['kind']
  // The resolved plan and its source (policy resolve()); plan null when no
  // source grants one.
  plan: PlanId | null
  source: EntitlementSource
  status: OrgStatus
  memberCount: number
  createdAt: number
}

export interface OrgMember {
  memberId: string
  userId: UserId
  email: string
  name: string
  role: RoleId
  createdAt: number
}

// One row of an org's audit log (P1-09), newest first in lists. subject is
// the event's payload without its common fields.
export interface ActivityEntry {
  id: string
  at: number
  type: string
  actorId: string
  sourceId: string
  subject: Record<string, string | number | boolean | null>
  requestId: string | null
}

// One page of an org's audit log, with a name for each user it names.
export interface ActivityPage extends Page<ActivityEntry> {
  names: UserNames
}

// A user's display name by user id (the profile name, or the email when the
// name is empty) for the users a list of activity entries names: actors,
// subject.userId and subject.asUser, whether or not they are still members.
// An id without a user row is absent.
export type UserNames = Record<UserId, string>

export interface OrgDetail extends OrgSummary {
  members: OrgMember[]
  // The provider subscription the plan comes from, or null.
  subscription: SubscriptionRecord | null
  // Each key's value and where it comes from: 'override' when an admin
  // override applies to it, otherwise the plan's source.
  entitlements: Record<
    EntitlementKey,
    { value: EntitlementValue; source: EntitlementSource }
  >
  overrides: EntitlementOverrideRecord[]
  // The kernel's card-free trial row (provider 'kernel'), or null.
  kernelTrial: SubscriptionRecord | null
  // The org's suspension row, in force or lifted, or null.
  suspension: SuspensionRecord | null
  // The last 20 audit log rows, newest first, and the names of the users
  // they name.
  activity: ActivityEntry[]
  names: UserNames
}

// A price of a plan written through createPlan(). amount is in the
// currency's minor unit. Import mode: a price and product that exist at the
// provider already; both ids or neither, and with them no provider call is
// made.
export interface CatalogPrice {
  period: PricePeriod
  amount: number
  currency: Currency
  trialDays?: number
  existingProviderPriceId?: string
  existingProviderProductId?: string
}

// A new plan with its prices (ADR-010's catalog write path): the plan's
// rows in the kernel's catalog and, for prices without existing ids, a
// product and prices at the active provider.
export interface CatalogPlanInput {
  id: PlanId
  name: string
  entitlements: Record<EntitlementKey, EntitlementValue>
  isDefault?: boolean
  trial?: PlanTrial | null
  sortOrder?: number
  prices?: readonly CatalogPrice[]
}

// A deployment setting (ADR-010), such as billing.trialPlan. value is the
// setting's JSON value.
export interface SettingRecord {
  key: string
  value: unknown
  updatedAt: number
}

// Exposed by the app Worker (AppEntrypoint) over the service binding APP;
// the admin Worker keeps no D1 binding and reaches data only through it.
// The binding is the trust boundary (audit F15): every method takes the
// caller's AdminContext first, as accessIdentity() verified it, and refuses
// without one. Every write emits its admin.* event (/events AdminEvent) with
// actorId `admin:<admin.id>` and adminEmail admin.email; catalog and setting
// writes under orgId 'system'. The app enforces both (P1-10b).
export interface AdminRpc {
  // Reads.
  listOrgs(
    admin: AdminContext,
    query: { q?: string; cursor?: string },
  ): Promise<Page<OrgSummary>>
  getOrg(admin: AdminContext, orgId: OrgId): Promise<OrgDetail>
  listActivity(
    admin: AdminContext,
    orgId: OrgId,
    cursor?: string,
  ): Promise<ActivityPage>
  // The catalog, archived plans included, each with its prices.
  listPlans(admin: AdminContext): Promise<PlanRecord[]>
  getSettings(admin: AdminContext): Promise<SettingRecord[]>
  // What refundCancel would refund: the org's latest paid transaction at
  // the provider, or null when it has none (or no open subscription). For
  // the confirm that names the amount; it writes nothing.
  previewRefund(
    admin: AdminContext,
    orgId: OrgId,
  ): Promise<ProviderTransaction | null>

  // Writes, each with the event it emits.
  // admin.override_set
  setOverride(
    admin: AdminContext,
    orgId: OrgId,
    key: EntitlementKey,
    value: EntitlementValue,
    reason: string,
    expiresAt?: number,
  ): Promise<void>
  // admin.override_cleared
  clearOverride(
    admin: AdminContext,
    orgId: OrgId,
    key: EntitlementKey,
  ): Promise<void>
  // admin.suspended: reason is the operator's note (the admin's card and
  // the audit log); message, optional, is the text the org's members are
  // shown (absent or empty: the app's default).
  suspendOrg(
    admin: AdminContext,
    orgId: OrgId,
    reason: string,
    message?: string,
  ): Promise<void>
  // admin.unsuspended
  liftSuspension(admin: AdminContext, orgId: OrgId): Promise<void>
  // admin.trial_started: a kernel trial of plan for days.
  startTrial(
    admin: AdminContext,
    orgId: OrgId,
    plan: PlanId,
    days: number,
  ): Promise<void>
  // admin.trial_extended: moves the kernel trial's end (epoch ms).
  extendTrial(admin: AdminContext, orgId: OrgId, endsAt: number): Promise<void>
  // admin.trial_ended: ends the kernel trial now.
  endTrial(admin: AdminContext, orgId: OrgId, reason: string): Promise<void>
  // admin.refund_cancel: refunds the org's latest transaction at the
  // provider, then cancels its subscription now (cancel('now')).
  refundCancel(admin: AdminContext, orgId: OrgId): Promise<void>
  // admin.plan_created
  createPlan(admin: AdminContext, input: CatalogPlanInput): Promise<PlanRecord>
  // admin.plan_updated
  updatePlan(
    admin: AdminContext,
    planId: PlanId,
    patch: PlanPatch,
  ): Promise<PlanRecord>
  // admin.plan_archived: archives the plan and its prices at the provider.
  archivePlan(admin: AdminContext, planId: PlanId): Promise<PlanRecord>
  // admin.setting_changed (the key only)
  setSetting(admin: AdminContext, key: string, value: unknown): Promise<void>
  // admin.impersonated: a sign-in URL for userId in orgId through the
  // kernel's own token path, valid for ttlSeconds; expiresAt is epoch ms.
  // admin.impersonation_ended is recorded when that session ends.
  impersonate(
    admin: AdminContext,
    orgId: OrgId,
    userId: UserId,
    ttlSeconds: number,
  ): Promise<{ url: string; expiresAt: number }>
}
