import type { Decision } from '../index.js'

// Thrown by helpers; mapped by /hono to 403 (forbidden, suspended) or 402
// (entitlement, paywall) with a structured body.
export class PolicyError extends Error {
  override name = 'PolicyError'
  decision: Exclude<Decision, { ok: true }>

  constructor(decision: Exclude<Decision, { ok: true }>) {
    super(`Policy denied: ${decision.reason}`)
    this.decision = decision
  }
}
