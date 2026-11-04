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
  SettingRecord,
  SubscriptionRecord,
  SuspensionRecord,
} from '@edgekits/kernel/policy'
import type { PricePeriod, ProviderTransaction } from '@edgekits/kernel/ports'
import type {
  AdminId,
  OrgClaimRecord,
  OrgClaimStatus,
  OrgId,
  OrgRecord,
  PlanId,
  RoleId,
  UserId,
} from '@edgekits/kernel/tenancy'

// accessIdentity() verifies the Access JWT (ADR-002a). Its mode 'dev' trusts
// a fixed identity and is for local runs only: the consumer passes the build
// it runs in (`build: import.meta.env.PROD ? 'production' : 'dev'`), and mode
// 'dev' with build 'production' throws at construction (audit F5).
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
  // When an operator blocked the user (blockUser), null when not blocked.
  blockedAt: number | null
}

// A pending invitation of an org that has not expired, the members' own or
// an operator's (inviteMember); invitedBy is the inviting user's id.
export interface OrgInvitation {
  id: string
  email: string
  role: RoleId
  invitedBy: UserId
  createdAt: number
  expiresAt: number
}

// A user of the deployment, for the admin's users list.
export interface UserSummary {
  id: UserId
  email: string
  name: string
  createdAt: number
  blockedAt: number | null
  // The orgs the user is a member of, the personal workspace included.
  orgCount: number
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
  // Pending invitations that have not expired, oldest first (P1-10d).
  invitations: OrgInvitation[]
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
  // The email of the org's customer at the billing provider (its billing
  // contact, audit F55), or null while the org has no customer.
  billingContact: string | null
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

// A deployment setting (ADR-010), such as billing.trialPlan: /policy's
// SettingRecord, the row listSettings() returns. value is the setting's
// JSON value. getSettings() reports billing.currencies with its default
// (['USD'], updatedAt 0) when it is unset, and setSetting() refuses a
// billing.currencies value that is not a non-empty list of codes in the
// active provider's manifest (currenciesIssues() in /policy).
export type { SettingRecord } from '@edgekits/kernel/policy'

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
  // admin.refund_issued once the provider accepts the refund of the org's
  // latest transaction, then admin.refund_cancel once its subscription is
  // canceled now (cancel('now')). A retry after a failed cancel finds the
  // admin.refund_issued row and does not refund again.
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

  // P1-10d (rulings 2026-11-02).
  // admin.org_claim_created: an org for a person without an account (an
  // org never exists without an owner). The app derives the slug from the
  // name, mails the claim's link to email, and creates the org when that
  // person accepts on their first sign-in (admin.org_claim_accepted). One
  // open claim per email (409 otherwise); ttlDays defaults to the app's.
  createOrgClaim(
    admin: AdminContext,
    input: { name: string; email: string; ttlDays?: number },
  ): Promise<OrgClaimRecord>
  listOrgClaims(
    admin: AdminContext,
    query: { status: OrgClaimStatus | 'all' },
  ): Promise<OrgClaimRecord[]>
  // admin.org_claim_canceled
  cancelOrgClaim(admin: AdminContext, claimId: string): Promise<void>
  // admin.member_invited: an ordinary invitation into an existing org,
  // written on the org's first owner's behalf (mailed like any other).
  inviteMember(
    admin: AdminContext,
    orgId: OrgId,
    email: string,
    role: RoleId,
  ): Promise<{ invitationId: string }>
  // admin.invitation_canceled: a pending invitation of the org.
  cancelInvitation(
    admin: AdminContext,
    orgId: OrgId,
    invitationId: string,
  ): Promise<void>
  // Users newest first, 50 a page; q matches the email or the name.
  listUsers(
    admin: AdminContext,
    query: { q?: string; cursor?: string },
  ): Promise<Page<UserSummary>>
  // admin.user_blocked: the user keeps their rows but no sessions; their
  // sessions end and a new one is refused (BlockedError, 403 'blocked').
  blockUser(admin: AdminContext, userId: UserId, reason: string): Promise<void>
  // admin.user_unblocked
  unblockUser(admin: AdminContext, userId: UserId): Promise<void>
  // admin.plan_restored: the plan, the prices archived with it, and their
  // product and prices at the provider (restoreProduct, restorePrice).
  restorePlan(admin: AdminContext, planId: PlanId): Promise<PlanRecord>
  // admin.billing_contact_set: the org's billing contact becomes userId, an
  // owner of the org (audit F55). The provider customer's email changes to
  // that user's, so the provider's portal and receipts follow.
  setBillingContact(
    admin: AdminContext,
    orgId: OrgId,
    userId: UserId,
  ): Promise<void>
}
