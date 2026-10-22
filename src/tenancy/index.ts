// TenantContext, resolveTenant, isolation strategies and the tenantTable() helper.
import type { TenantDb } from './internal/repository.js'

export {
  createTenantContext,
  resolveTenant,
  TenancyError,
  type Session,
  type TenancyDeps,
} from './internal/context.js'
export { TenantGuardError, tenantGuardLogger } from './internal/guard.js'
export {
  ConflictError,
  type RepositoryTable,
  type TenantDatabase,
  type TenantDb,
  type TenantRepository,
} from './internal/repository.js'
export {
  isTenantTable,
  tenantReference,
  tenantTable,
  type TenantBrand,
  type TenantTable,
} from './internal/table.js'

export const subpath = 'tenancy' as const

export type OrgId = string
export type UserId = string
export type RoleId = string
export type PlanId = string
export type AdminId = string
export type Locale = string

// Where the org id of a request came from (ADR-005).
export type OrgSource = 'session' | 'api-key' | 'explicit'

export interface OrgRecord {
  id: OrgId
  kind: 'personal' | 'team'
  plan: PlanId
  slug: string
}

export interface Actor {
  readonly userId: UserId
  readonly role: RoleId
  // Set only by the admin token path.
  readonly impersonatedBy?: AdminId
}

export interface TenantContext {
  readonly orgId: OrgId
  readonly org: OrgRecord
  readonly actor: Actor
  readonly request: {
    id: string
    locale: Locale
    ip?: string
    source: OrgSource
  }
  readonly db: TenantDb
}
