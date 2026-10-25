import { defaultRoles } from '@edgekits/kernel/config'
import type { RoleId, TenantContext } from '@edgekits/kernel/tenancy'
import type { Decision, EntitlementKey, Permission } from '../index.js'
import { PolicyError } from './errors.js'
import type { EntitlementVocabulary, PlanSource } from './plans/repo.js'
import { loadPolicyRows } from './repo.js'
import { resolveEntitlements, type ResolvedEntitlements } from './resolver.js'

// The live count behind a numeric entitlement, such as the org's projects.
export type EntitlementCounter = (ctx: TenantContext) => Promise<number>

export interface PolicyEngineOptions {
  // The blueprint's entitlement vocabulary: the keys entitled() accepts.
  entitlements: EntitlementVocabulary
  // Role -> permission globs. The kernel's default roles are merged under
  // these, as defineSaaS() does.
  roles?: Readonly<Record<RoleId, readonly string[]>>
  // The plan catalog (planSource() over the plans table, ADR-010).
  plans: PlanSource
  counters?: Partial<Record<EntitlementKey, EntitlementCounter>>
}

// Boolean entitlements as feature flags; the shape an OpenFeature provider
// module wraps later.
export interface EntitlementFlags {
  getBooleanValue(key: EntitlementKey, fallback: boolean): boolean
}

export interface PolicyEngine {
  can(ctx: TenantContext, permission: Permission): Decision
  entitled(
    ctx: TenantContext,
    key: EntitlementKey,
    delta?: number,
  ): Promise<Decision>
  // Throw PolicyError when the decision is a denial.
  requirePermission(ctx: TenantContext, permission: Permission): void
  requireEntitlement(
    ctx: TenantContext,
    key: EntitlementKey,
    delta?: number,
  ): Promise<void>
  entitlementFlags(ctx: TenantContext): Promise<EntitlementFlags>
}

// A glob grants '*' (everything), '<resource>.*' (every action on the
// resource) or one exact permission.
function grants(glob: string, permission: Permission): boolean {
  if (glob === '*' || glob === permission) return true
  return glob.endsWith('.*') && permission.startsWith(glob.slice(0, -1))
}

// entitled() and requireEntitlement() throw a RangeError for a key the
// vocabulary does not declare: a misspelled key is a bug, not a denial.
export function createPolicyEngine(options: PolicyEngineOptions): PolicyEngine {
  const { entitlements: vocabulary, plans } = options
  const roles: Record<RoleId, readonly string[]> = {
    ...defaultRoles,
    ...options.roles,
  }
  const counters = options.counters ?? {}

  const resolve = async (ctx: TenantContext): Promise<ResolvedEntitlements> => {
    const [catalog, rows] = await Promise.all([plans(), loadPolicyRows(ctx)])
    return resolveEntitlements({ ...catalog, ...rows, now: Date.now() })
  }
  const count = async (ctx: TenantContext, key: EntitlementKey) =>
    (await counters[key]?.(ctx)) ?? 0

  const engine: PolicyEngine = {
    can(ctx, permission) {
      const globs = Object.hasOwn(roles, ctx.actor.role)
        ? (roles[ctx.actor.role] ?? [])
        : []
      return globs.some((glob) => grants(glob, permission))
        ? { ok: true }
        : { ok: false, reason: 'forbidden', permission }
    },

    async entitled(ctx, key, delta = 1) {
      if (!Object.hasOwn(vocabulary, key)) {
        throw new RangeError(
          `entitled: ${key} is not in the blueprint's entitlements`,
        )
      }
      const { values } = await resolve(ctx)
      const value = Object.hasOwn(values, key) ? values[key] : undefined
      if (typeof value === 'boolean') {
        return value
          ? { ok: true }
          : { ok: false, reason: 'entitlement', key, limit: 0, current: 0 }
      }
      if (value === -1) return { ok: true }
      const current = await count(ctx, key)
      if (value === undefined) {
        return { ok: false, reason: 'entitlement', key, limit: 0, current }
      }
      return current + delta <= value
        ? { ok: true }
        : { ok: false, reason: 'entitlement', key, limit: value, current }
    },

    requirePermission(ctx, permission) {
      const decision = engine.can(ctx, permission)
      if (!decision.ok) throw new PolicyError(decision)
    },

    async requireEntitlement(ctx, key, delta) {
      const decision = await engine.entitled(ctx, key, delta)
      if (!decision.ok) throw new PolicyError(decision)
    },

    async entitlementFlags(ctx) {
      const { values } = await resolve(ctx)
      return {
        getBooleanValue(key, fallback) {
          const value = Object.hasOwn(values, key) ? values[key] : undefined
          return typeof value === 'boolean' ? value : fallback
        },
      }
    },
  }
  return engine
}
