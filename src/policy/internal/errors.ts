import type { Decision } from '../index.js'

// Thrown by helpers; mapped by /hono and /astro to 403 or 402 with a structured body.
export class PolicyError extends Error {
  override name = 'PolicyError'
  decision: Exclude<Decision, { ok: true }>

  constructor(decision: Exclude<Decision, { ok: true }>) {
    super(`Policy denied: ${decision.reason}`)
    this.decision = decision
  }
}
