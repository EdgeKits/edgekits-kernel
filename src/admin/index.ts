// AdminContext and the AdminRpc contract exposed to the admin Worker.
import type { EntitlementKey } from '@edgekits/kernel/policy'
import type { AdminId, OrgId, UserId } from '@edgekits/kernel/tenancy'

export {
  accessIdentity,
  type AccessIdentityOptions,
  type AdminVariables,
  type Jwks,
} from './internal/access'

export const subpath = 'admin' as const

export type SignedToken = string

export interface AdminContext {
  // From the Access JWT (ADR-002a): id is sub, email is email.
  readonly admin: { id: AdminId; email: string }
  readonly request: { id: string }
}

// Exposed by the app Worker over a service binding.
export interface AdminRpc {
  impersonate(
    admin: AdminId,
    orgId: OrgId,
    userId: UserId,
    ttlSeconds: number,
  ): Promise<SignedToken>
  setEntitlementOverride(
    orgId: OrgId,
    key: EntitlementKey,
    value: number | null,
  ): Promise<void>
  suspendOrg(orgId: OrgId, reason: string): Promise<void>
}
