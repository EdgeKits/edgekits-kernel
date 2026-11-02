import type { Context, ErrorHandler } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { PlanError, PolicyError } from '@edgekits/kernel/policy'
import { CapabilityError } from '@edgekits/kernel/ports'
import {
  BlockedError,
  ConflictError,
  TenancyError,
  type TenantContext,
} from '@edgekits/kernel/tenancy'

// One refused request (audit F6), as errors() and accessIdentity() in
// /admin report it: the status, the refusal's reason word, the request line,
// the request id and who asked: the tenant's user id, `admin:<adminId>` for
// an operator, or 'anonymous'. Never a body, a header value or a token.
export interface DenialEntry {
  status: 401 | 403 | 404
  reason: string
  path: string
  method: string
  requestId: string | null
  actor: string
}

// The default denial log: one JSON line on console.warn.
export const logDenial = (entry: DenialEntry): void => {
  console.warn(JSON.stringify(entry))
}

export interface ErrorsOptions {
  // Receives every error that becomes a 500. Defaults to console.error.
  log?: (error: unknown) => void
  // Receives every 401, 403 and 404 errors() answers. Defaults to
  // logDenial (console.warn, one JSON line).
  denied?: (entry: DenialEntry) => void
}

// The variables the kernel's middleware may have set by the time an error
// reaches errors(): the tenant (tenant() in /hono) or the operator
// (accessIdentity() in /admin).
interface KernelVariables {
  tenant?: TenantContext
  admin?: { admin: { id: string }; request: { id: string } }
}

function denial(
  c: Context,
  status: DenialEntry['status'],
  reason: string,
): DenialEntry {
  const vars = c.var as KernelVariables
  const actor = vars.tenant
    ? vars.tenant.actor.userId
    : vars.admin
      ? `admin:${vars.admin.admin.id}`
      : 'anonymous'
  return {
    status,
    reason,
    path: c.req.path,
    method: c.req.method,
    requestId:
      vars.tenant?.request.id ??
      vars.admin?.request.id ??
      c.req.header('cf-ray') ??
      null,
    actor,
  }
}

const isDenial = (status: number): status is DenialEntry['status'] =>
  status === 401 || status === 403 || status === 404

// For app.onError(): PolicyError to 402 (entitlement, paywall) or 403
// (forbidden, suspended) with the decision, BlockedError to 403 'blocked'
// (a blocked user's session, P1-10d), TenancyError to 404,
// ConflictError to 409, PlanError to 400 with its issues ('invalid') or 404
// ('not-found'), CapabilityError to 400 with its issues, a Hono
// HTTPException to its own response, anything else (TenantGuardError
// included) to 500 with no detail in the body. Every 401, 403 and 404 it
// answers goes to denied; a throwing denied hook does not change the answer.
export function errors(options: ErrorsOptions = {}): ErrorHandler {
  const log = options.log ?? console.error
  const denied = options.denied ?? logDenial
  const report = (c: Context, status: number, reason: string) => {
    if (!isDenial(status)) return
    try {
      denied(denial(c, status, reason))
    } catch {
      // The log is not the answer.
    }
  }
  return (error, c) => {
    if (error instanceof PolicyError) {
      const { decision } = error
      const status =
        decision.reason === 'forbidden' || decision.reason === 'suspended'
          ? 403
          : 402
      report(c, status, decision.reason)
      return c.json({ error: decision.reason, decision }, status)
    }
    if (error instanceof BlockedError) {
      report(c, 403, 'blocked')
      return c.json({ error: 'blocked' }, 403)
    }
    if (error instanceof TenancyError) {
      report(c, 404, error.reason)
      return c.json({ error: 'not-found' }, 404)
    }
    if (error instanceof ConflictError) {
      return c.json({ error: 'conflict' }, 409)
    }
    if (error instanceof PlanError) {
      if (error.reason === 'invalid') {
        return c.json({ error: 'invalid-plan', issues: error.issues }, 400)
      }
      report(c, 404, 'plan-not-found')
      return c.json({ error: 'not-found' }, 404)
    }
    if (error instanceof CapabilityError) {
      return c.json({ error: 'unsupported', issues: error.issues }, 400)
    }
    if (error instanceof HTTPException) {
      const response = error.getResponse()
      report(c, response.status, 'http-exception')
      return response
    }
    log(error)
    return c.json({ error: 'internal' }, 500)
  }
}
