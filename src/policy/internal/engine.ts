import { defaultRoles } from '@edgekits/kernel/config'
import type { RoleId, TenantContext } from '@edgekits/kernel/tenancy'
import type { Decision, EntitlementKey, Permission } from '../index'
import { PolicyError } from './errors'
import { loadPolicyRows } from './repo'
import {
  resolveEntitlements,
  type Plans,
  type ResolvedEntitlements,
} from './resolver'

// The live count behind a numeric entitlement, such as the org's projects.
export type EntitlementCounter = (ctx: TenantContext) => Promise<number>

export interface PolicyBlueprint {
  plans: Plans
  // Role -> permission globs. The kernel's default roles are merged under
  // these, as defineSaaS() does.
  roles?: Readonly<Record<RoleId, readonly string[]>>
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

export function createPolicyEngine(options: {
  blueprint: PolicyBlueprint
  counters?: Partial<Record<EntitlementKey, EntitlementCounter>>
}): PolicyEngine {
  const { plans } = options.blueprint
  const roles: Record<RoleId, readonly string[]> = {
    ...defaultRoles,
    ...options.blueprint.roles,
  }
  const counters = options.counters ?? {}

  const resolve = async (ctx: TenantContext): Promise<ResolvedEntitlements> => {
    const rows = await loadPolicyRows(ctx)
    return resolveEntitlements({ plans, ...rows, now: Date.now() })
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
