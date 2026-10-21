// Hono middleware: session, active org, resolveTenant, PolicyError mapping.
export { errors, type ErrorsOptions } from './internal/errors'
export {
  noStore,
  sameOrigin,
  securityHeaders,
  type SecurityHeadersOptions,
} from './internal/headers'
export {
  tenant,
  type ExplicitOrg,
  type SessionInfo,
  type TenantDeps,
  type TenantOptions,
  type TenantVariables,
} from './internal/tenant'

export const subpath = 'hono' as const
