// TenantContext, resolveTenant, isolation strategies and the tenantTable() helper.
export const subpath = 'tenancy' as const

export type OrgId = string
export type UserId = string
export type RoleId = string
export type PlanId = string
export type AdminId = string
export type Locale = string

export interface Actor {
  readonly userId: UserId
  readonly role: RoleId
  // Set only by the admin token path.
  readonly impersonatedBy?: AdminId
}

// Tenant-bound repositories that already carry orgId. Types only for now.
export type TenantDb = Readonly<Record<string, unknown>>

export interface TenantContext {
  readonly orgId: OrgId
  readonly org: {
    id: OrgId
    kind: 'personal' | 'team'
    plan: PlanId
    slug: string
  }
  readonly actor: Actor
  readonly request: { id: string; locale: Locale; ip?: string }
  readonly db: TenantDb
}
