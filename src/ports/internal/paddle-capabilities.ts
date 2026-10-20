import type { BillingCapabilities } from '../index'

// Paddle Billing capability manifest, taken from developer.paddle.com
// (2026-10-20). Where the documentation does not settle a value, the
// conservative option is set.
export const paddleCapabilities: BillingCapabilities = {
  // get-started/how-paddle-works: "the developer-first merchant of record".
  mor: true,
  // concepts/sell/supported-currencies: the 33 payment currencies.
  currencies: [
    'USD',
    'GBP',
    'EUR',
    'ARS',
    'AUD',
    'BRL',
    'CAD',
    'CHF',
    'CLP',
    'CNY',
    'COP',
    'CZK',
    'DKK',
    'HKD',
    'HUF',
    'ILS',
    'INR',
    'JPY',
    'KRW',
    'MXN',
    'NOK',
    'NZD',
    'PEN',
    'PLN',
    'RUB',
    'SEK',
    'SGD',
    'THB',
    'TRY',
    'TWD',
    'UAH',
    'VND',
    'ZAR',
  ],
  // flat: build/products/create-products-prices (recurring billing_cycle).
  // seats: build/subscriptions/add-remove-products-prices-addons (quantities
  // per user or seat). usage is excluded: usage-based billing is in early
  // access (beta) per get-started/how-paddle-works/ai-companies. credits is
  // excluded: prepaid credits are one-time products tracked by the app.
  models: ['flat', 'seats'],
  // build/subscriptions/update-trials; trial_period on recurring prices.
  trials: true,
  // concepts/subscriptions/proration: prorated_immediately -> immediate,
  // do_not_bill -> none, prorated_next_billing_period -> period-end.
  proration: ['immediate', 'none', 'period-end'],
  // build/subscriptions/add-remove-products-prices-addons: "Each subscription
  // holds an items list that can contain multiple products."
  multiItem: true,
  // migrate/learn/feature-comparison: Paddle-led license key generation is
  // deprecated in Paddle Billing.
  licenseKeys: false,
  // get-started/how-paddle-works/ai-companies: no native credit wallet.
  credits: false,
}
