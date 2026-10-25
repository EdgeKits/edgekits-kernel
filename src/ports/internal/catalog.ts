import type {
  BillingCapabilities,
  BillingModel,
  CatalogPriceInput,
} from '../index.js'

// A catalog request the provider's capability manifest does not allow,
// refused before any provider call. Carries the reasons only.
export class CapabilityError extends Error {
  override name = 'CapabilityError'

  constructor(
    readonly provider: string,
    readonly issues: readonly string[],
  ) {
    super(`${provider} cannot sell this price: ${issues.join('; ')}`)
  }
}

// What the manifest and the price's own shape rule out for one catalog
// price: the currency, the deployment's billing model, a trial without the
// trials capability or on a one-time price, and amounts or trial lengths
// that are not whole numbers. Empty when the price can be created.
export function priceCapabilityIssues(
  capabilities: BillingCapabilities,
  input: Omit<CatalogPriceInput, 'providerProductId'> & { model: BillingModel },
): string[] {
  const issues: string[] = []
  if (!capabilities.currencies.includes(input.currency)) {
    issues.push(`currency ${input.currency} (capability: currencies)`)
  }
  if (!capabilities.models.includes(input.model)) {
    issues.push(`billing model ${input.model} (capability: models)`)
  }
  if (!Number.isSafeInteger(input.amount) || input.amount < 0) {
    issues.push(`amount must be a non-negative integer, got ${input.amount}`)
  }
  const trialDays = input.trialDays ?? 0
  if (!Number.isSafeInteger(trialDays) || trialDays < 0) {
    issues.push(`trialDays must be a non-negative integer, got ${trialDays}`)
  } else if (trialDays > 0) {
    if (!capabilities.trials) issues.push('a trial (capability: trials)')
    if (input.period === 'once') issues.push('a trial on a one-time price')
  }
  return issues
}

// Throws CapabilityError when priceCapabilityIssues() finds any.
export function assertPriceSupported(
  provider: string,
  capabilities: BillingCapabilities,
  input: Omit<CatalogPriceInput, 'providerProductId'> & { model: BillingModel },
): void {
  const issues = priceCapabilityIssues(capabilities, input)
  if (issues.length > 0) throw new CapabilityError(provider, issues)
}
