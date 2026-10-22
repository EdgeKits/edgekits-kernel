// Provider interfaces: billing, auth, mail, flags, AI and storage.
import { z } from 'zod'
import type {
  BillingEvent,
  InboundEvent,
  ProviderId,
} from '@edgekits/kernel/events'
import type { OrgId, PlanId, TenantContext } from '@edgekits/kernel/tenancy'

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
    mode: 'immediate' | 'period-end',
  ): Promise<void>
  fetchSubscription(
    providerSubscriptionId: string,
  ): Promise<NormalizedSubscription>
  reportUsage?(
    ctx: TenantContext,
    meter: string,
    units: number,
    idempotencyKey: string,
  ): Promise<void>
}
