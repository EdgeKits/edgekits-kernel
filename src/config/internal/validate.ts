import type { z } from 'zod'
import type { BillingCapabilities } from '@edgekits/kernel/ports'
import type { billingSchema } from './schema.js'

export interface ValidationIssue {
  path: string
  message: string
}

export type ValidationResult =
  { ok: true } | { ok: false; issues: ValidationIssue[] }

// Checks the billing choices against the provider's capability manifest.
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
  // With billing.trial, requiresCard decides who runs the trial: the kernel
  // (no card, any provider) or the provider (card on file, needs the trials
  // capability). Without it, trialDays above 0 is a provider trial.
  const trialDays = billing.trialDays ?? 0
  if (billing.trial === undefined && trialDays > 0 && !capabilities.trials) {
    issues.push({
      path: 'billing.trialDays',
      message: `${provider} does not support trials (capability: trials), so trialDays must be 0, got ${trialDays}.`,
    })
  }
  if (billing.trial?.requiresCard && !capabilities.trials) {
    issues.push({
      path: 'billing.trial.requiresCard',
      message: `${provider} does not support trials (capability: trials), so a trial that requires a card is not possible; set requiresCard: false for a kernel trial.`,
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
