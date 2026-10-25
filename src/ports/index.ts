// Provider interfaces: billing, auth, mail, flags, AI and storage.
import { z } from 'zod'
import type {
  BillingEvent,
  InboundEvent,
  ProviderId,
} from '@edgekits/kernel/events'
import type { OrgId, PlanId, TenantContext } from '@edgekits/kernel/tenancy'

export {
  assertPriceSupported,
  CapabilityError,
  priceCapabilityIssues,
} from './internal/catalog.js'
export { paddleCapabilities } from './internal/paddle-capabilities.js'

export const subpath = 'ports' as const

export const billingModelSchema = z.enum(['flat', 'seats', 'usage', 'credits'])
export type BillingModel = z.infer<typeof billingModelSchema>

export const prorationModeSchema = z.enum(['immediate', 'none', 'period-end'])
export type ProrationMode = z.infer<typeof prorationModeSchema>

export const currencySchema = z
  .string()
  .regex(/^[A-Z]{3}$/, 'Expected an ISO 4217 code: three uppercase letters')

export const billingCapabilitiesSchema = z.strictObject({
  mor: z.boolean(),
  currencies: z.array(currencySchema),
  models: z.array(billingModelSchema),
  trials: z.boolean(),
  proration: z.array(prorationModeSchema),
  multiItem: z.boolean(),
  licenseKeys: z.boolean(),
  credits: z.boolean(),
})
export type BillingCapabilities = z.infer<typeof billingCapabilitiesSchema>

export interface CheckoutOptions {
  seats?: number
  successUrl?: string
}

// Timestamps are epoch milliseconds.
export interface NormalizedSubscription {
  providerSubscriptionId: string
  orgId: OrgId
  plan: PlanId
  status: 'trialing' | 'active' | 'paused' | 'past_due' | 'canceled'
  seats: number
  periodEnd: number
}

// How often a catalog price bills: monthly, yearly, or once (a lifetime
// purchase).
export const pricePeriods = ['month', 'year', 'once'] as const
export type PricePeriod = (typeof pricePeriods)[number]

// A plan's product at the provider; id is the kernel's plan id.
export interface CatalogProductInput {
  id: PlanId
  name: string
}

// One price of a plan's product. amount is in minor units of currency;
// trialDays above 0 is a trial the provider runs (needs the trials
// capability and a recurring period).
export interface CatalogPriceInput {
  providerProductId: string
  amount: number
  currency: string
  period: PricePeriod
  trialDays?: number
}

export interface BillingProvider {
  readonly id: ProviderId
  readonly capabilities: BillingCapabilities
  verify(req: Request, rawBody: ArrayBuffer, secret: string): Promise<boolean>
  parse(rawBody: ArrayBuffer): InboundEvent
  // May call the provider API (api_callback path).
  normalize(evt: InboundEvent): Promise<BillingEvent[]>
  checkoutUrl(
    ctx: TenantContext,
    plan: PlanId,
    opts?: CheckoutOptions,
  ): Promise<URL>
  portalUrl(ctx: TenantContext): Promise<URL>
  changePlan(
    ctx: TenantContext,
    plan: PlanId,
    mode: ProrationMode,
  ): Promise<void>
  // 'period-end' schedules the cancellation for the end of the billing
  // period; 'now' cancels at once.
  cancel(ctx: TenantContext, when: 'period-end' | 'now'): Promise<void>
  // Removes a scheduled cancellation, so the subscription renews.
  keep(ctx: TenantContext): Promise<void>
  fetchSubscription(
    providerSubscriptionId: string,
  ): Promise<NormalizedSubscription>
  // The catalog (ADR-010): called by the catalog code only (AdminRpc and the
  // seed), never by a page. Each checks the input against the capability
  // manifest before any provider call. Archiving is the only removal.
  createProduct(
    input: CatalogProductInput,
  ): Promise<{ providerProductId: string }>
  createPrice(input: CatalogPriceInput): Promise<{ providerPriceId: string }>
  archivePrice(providerPriceId: string): Promise<void>
  archiveProduct(providerProductId: string): Promise<void>
  reportUsage?(
    ctx: TenantContext,
    meter: string,
    units: number,
    idempotencyKey: string,
  ): Promise<void>
}

// One outgoing message: magic links, invitations, billing notices.
export interface MailMessage {
  to: string
  subject: string
  text: string
  html?: string
}

// A mail adapter (Cloudflare Email Service, Resend, a dev mailbox). send()
// resolves to the provider's message id.
export interface MailProvider {
  readonly id: string
  send(message: MailMessage): Promise<{ id: string }>
}
