// Uses the built declarations in dist/ the way a consumer does. tsconfig.json
// maps @edgekits/kernel/* to ../../dist/*/index.d.ts; check.mjs type-checks
// this file and every dist .d.ts with skipLibCheck off. Never executed.
import { text } from 'drizzle-orm/sqlite-core'
import { toLocals } from '@edgekits/kernel/astro'
import { accessIdentity } from '@edgekits/kernel/admin'
import { defineSaaS } from '@edgekits/kernel/config'
import { applySubscriptionEvents } from '@edgekits/kernel/events'
import { errors, tenant } from '@edgekits/kernel/hono'
import { PolicyError } from '@edgekits/kernel/policy'
import { paddleCapabilities } from '@edgekits/kernel/ports'
import { tenantTable, type TenantDb } from '@edgekits/kernel/tenancy'

export const projects = tenantTable('projects', {
  id: text().primaryKey(),
  name: text().notNull(),
})

export const projectsRepo = (db: TenantDb) => db.repo(projects)

type Row = NonNullable<
  Awaited<ReturnType<ReturnType<typeof projectsRepo>['findById']>>
>
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false

// Column inference survives the declaration boundary: the row is exactly
// the declared columns plus org_id, not any and not a widened shape.
export const rowShape: Equal<Row, { id: string; name: string; orgId: string }> =
  true

export const subpathExports = [
  toLocals,
  accessIdentity,
  defineSaaS,
  applySubscriptionEvents,
  errors,
  tenant,
  PolicyError,
  paddleCapabilities,
] as const
