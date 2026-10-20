import type { Logger } from 'drizzle-orm'
import { tenantTableNames } from './table'

export class TenantGuardError extends Error {
  override name = 'TenantGuardError'
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Throws when a select, update or delete statement targets a registered
// tenant table and its WHERE clause has no org_id predicate. A textual check
// over the SQL Drizzle hands the logger before it runs the statement: it
// catches a missing predicate, not a wrong one. db.batch() does not go
// through the logger and is not checked.
function assertOrgPredicate(sql: string) {
  if (!/^\s*(select|update|delete)\b/i.test(sql)) return
  const where = /\bwhere\b([\s\S]*)$/i.exec(sql)?.[1] ?? ''
  for (const name of tenantTableNames()) {
    const table = `"${escape(name)}"`
    if (!new RegExp(`\\b(from|join|update)\\s+${table}`, 'i').test(sql)) {
      continue
    }
    if (!new RegExp(`(${table}\\.)?"org_id"\\s*(=|in\\b)`, 'i').test(where)) {
      throw new TenantGuardError(
        `Statement on tenant table ${name} has no org_id predicate: ${sql}`,
      )
    }
  }
}

// ADR-004 layer 3: a Drizzle logger for dev and test databases. 'strict'
// enforces the org_id predicate; production passes 'off'.
export function tenantGuardLogger({
  mode,
}: {
  mode: 'strict' | 'off'
}): Logger {
  return {
    logQuery(query) {
      if (mode === 'strict') assertOrgPredicate(query)
    },
  }
}
