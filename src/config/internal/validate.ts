import type { z } from 'zod'
import type { BillingCapabilities } from '@edgekits/kernel/ports'
import type { billingSchema } from './schema.js'

export interface ValidationIssue {
  path: string
  message: string
}

export type ValidationResult =
  { ok: true } | { ok: false; issues: ValidationIssue[] }

// Checks the billing choices against the provider's capability manifest:
// currency, model and proration. Trials belong to a plan's prices (ADR-010)
// and are checked when a price is created (assertPriceSupported in /ports).
export function validateAgainstProviders(
  blueprint: { billing: z.output<typeof billingSchema> },
  capabilities: BillingCapabilities,
): ValidationResult {
  const { billing } = blueprint
  const provider = billing.kind
  const issues: ValidationIssue[] = []

  if (!capabilities.currencies.includes(billing.currency)) {
    issues.push({
      path: 'billing.currency',
      message: `${provider} does not support currency ${billing.currency} (capability: currencies). Supported: ${capabilities.currencies.join(', ')}.`,
    })
  }
  if (!capabilities.models.includes(billing.model)) {
    issues.push({
      path: 'billing.model',
      message: `${provider} does not support the ${billing.model} billing model (capability: models). Supported: ${capabilities.models.join(', ')}.`,
    })
  }
  if (
    billing.proration !== undefined &&
    !capabilities.proration.includes(billing.proration)
  ) {
    issues.push({
      path: 'billing.proration',
      message: `${provider} does not support ${billing.proration} proration (capability: proration). Supported: ${capabilities.proration.join(', ')}.`,
    })
  }

  return issues.length === 0 ? { ok: true } : { ok: false, issues }
}
