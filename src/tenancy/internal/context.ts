import type {
  Actor,
  Locale,
  OrgId,
  OrgRecord,
  OrgSource,
  RoleId,
  TenantContext,
  UserId,
} from '../index.js'
import { createTenantDb, type TenantDatabase } from './repository.js'

export function createTenantContext(input: {
  orgId: OrgId
  org: OrgRecord
  actor: Actor
  request: TenantContext['request']
  db: TenantDatabase
}): TenantContext {
  if (input.org.id !== input.orgId) {
    throw new Error(
      `Org record ${input.org.id} does not match org id ${input.orgId}.`,
    )
  }
  return {
    orgId: input.orgId,
    org: input.org,
    actor: input.actor,
    request: input.request,
    db: createTenantDb(input.db, input.orgId),
  }
}

// Returned, never thrown, by resolveTenant(). Both reasons map to 404.
export class TenancyError extends Error {
  override name = 'TenancyError'

  constructor(
    readonly reason: 'not-a-member' | 'no-such-org',
    readonly orgId: OrgId,
  ) {
    super(`Tenancy refused for org ${orgId}: ${reason}`)
  }
}

// Thrown by the starter's session resolver when the session's user is
// blocked (P1-10d, ruling 2026-11-02: a blocked user keeps their rows but
// no sessions). The kernel knows nothing of the auth library's user table;
// /hono's errors() answers 403 { error: 'blocked' } and reports reason
// 'blocked' to its denied hook.
export class BlockedError extends Error {
  override name = 'BlockedError'

  constructor(readonly userId: UserId) {
    super('The user is blocked')
  }
}

export interface Session {
  readonly userId: UserId
}

export interface TenancyDeps {
  membership(userId: UserId, orgId: OrgId): Promise<{ role: RoleId } | null>
  org(orgId: OrgId): Promise<OrgRecord | null>
  db: TenantDatabase
  source: OrgSource
  request: { id: string; locale: Locale; ip?: string }
}

// ADR-005: the org id comes from the session, an API key or an explicit
// argument, and is never trusted on its own. Membership is re-verified on
// every call.
export async function resolveTenant(
  session: Session,
  orgId: OrgId,
  deps: TenancyDeps,
): Promise<TenantContext | TenancyError> {
  const org = await deps.org(orgId)
  if (!org || org.id !== orgId) return new TenancyError('no-such-org', orgId)
  const membership = await deps.membership(session.userId, orgId)
  if (!membership) return new TenancyError('not-a-member', orgId)
  return createTenantContext({
    orgId,
    org,
    actor: { userId: session.userId, role: membership.role },
    request: { ...deps.request, source: deps.source },
    db: deps.db,
  })
}
