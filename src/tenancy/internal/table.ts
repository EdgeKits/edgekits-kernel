import type { BuildColumns, Table } from 'drizzle-orm'
import {
  index,
  sqliteTable,
  text,
  type SQLiteColumnBuilderBase,
  type SQLiteTableExtraConfigValue,
} from 'drizzle-orm/sqlite-core'

declare const tenantBrand: unique symbol

// Marks a table declared through tenantTable(). Only branded tables are
// accepted by TenantDb.repo().
export interface TenantBrand {
  readonly [tenantBrand]: true
}

const registry = new WeakSet<Table>()
const names = new Set<string>()

const orgIdColumn = () => ({ orgId: text('org_id').notNull() })
type OrgIdColumn = ReturnType<typeof orgIdColumn>

// Declares a tenant-scoped table: adds the org_id column and its index and
// registers the table. The caller never declares org_id itself.
export function tenantTable<
  TName extends string,
  TColumns extends Record<string, SQLiteColumnBuilderBase>,
>(
  name: TName,
  columns: TColumns & { orgId?: never },
  extra?: (
    self: BuildColumns<TName, TColumns & OrgIdColumn, 'sqlite'>,
  ) => SQLiteTableExtraConfigValue[],
) {
  if ('orgId' in columns) {
    throw new Error(
      `tenantTable('${name}') adds org_id itself; remove the orgId column.`,
    )
  }
  const all: TColumns & OrgIdColumn = { ...columns, ...orgIdColumn() }
  const table = sqliteTable(name, all, (self) => [
    index(`${name}_org_id_idx`).on(self.orgId),
    ...(extra?.(self) ?? []),
  ])
  registry.add(table)
  names.add(name)
  return table as typeof table & TenantBrand
}

export function isTenantTable(table: Table): boolean {
  return registry.has(table)
}

export function tenantTableNames(): string[] {
  return [...names]
}
