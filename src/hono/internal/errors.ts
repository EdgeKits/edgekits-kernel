import type { ErrorHandler } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { PolicyError } from '@edgekits/kernel/policy'
import { ConflictError, TenancyError } from '@edgekits/kernel/tenancy'

export interface ErrorsOptions {
  // Receives every error that becomes a 500. Defaults to console.error.
  log?: (error: unknown) => void
}

// For app.onError(): PolicyError to 402 (entitlement) or 403 (forbidden)
// with the decision, TenancyError to 404, ConflictError to 409, a Hono
// HTTPException to its own response, anything else (TenantGuardError
// included) to 500 with no detail in the body.
export function errors(options: ErrorsOptions = {}): ErrorHandler {
  const log = options.log ?? console.error
  return (error, c) => {
    if (error instanceof PolicyError) {
      const { decision } = error
      return c.json(
        { error: decision.reason, decision },
        decision.reason === 'entitlement' ? 402 : 403,
      )
    }
    if (error instanceof TenancyError) {
      return c.json({ error: 'not-found' }, 404)
    }
    if (error instanceof ConflictError) {
      return c.json({ error: 'conflict' }, 409)
    }
    if (error instanceof HTTPException) return error.getResponse()
    log(error)
    return c.json({ error: 'internal' }, 500)
  }
}
