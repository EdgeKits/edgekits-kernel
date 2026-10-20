import type { ErrorHandler } from 'hono'
import { PolicyError } from '@edgekits/kernel/policy'
import { TenancyError } from '@edgekits/kernel/tenancy'

export interface ErrorsOptions {
  // Receives every error that becomes a 500. Defaults to console.error.
  log?: (error: unknown) => void
}

// For app.onError(): PolicyError to 402 (entitlement) or 403 (forbidden)
// with the decision, TenancyError to 404, anything else (TenantGuardError
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
    log(error)
    return c.json({ error: 'internal' }, 500)
  }
}
