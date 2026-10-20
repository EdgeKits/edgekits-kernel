// Astro middleware: session, active org, resolveTenant, PolicyError mapping.
import type { AdminContext } from '@edgekits/kernel/admin'
import type { TenantContext } from '@edgekits/kernel/tenancy'

export const subpath = 'astro' as const

// The kernel's part of App.Locals. The app augments Astro with
//   declare namespace App { interface Locals extends KernelLocals {} }
export interface KernelLocals {
  tenant?: TenantContext
  admin?: AdminContext
}

// Copies the kernel variables set by the /hono and /admin middleware from a
// Hono context into the shape of Astro locals.
export function toLocals(c: {
  var: { tenant?: TenantContext; admin?: AdminContext }
}): KernelLocals {
  return { tenant: c.var.tenant, admin: c.var.admin }
}
