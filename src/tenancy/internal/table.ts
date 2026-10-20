import type { BuildColumns, Table } from 'drizzle-orm'
import {
  index,
  sqliteTable,
  text,
  type SQLiteColumnBuilderBase,
  type SQLiteTableExtraConfigValue,
  type SQLiteTableWithColumns,
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

// The table tenantTable() returns. Spelled out so the emitted declaration
// names it instead of inlining Drizzle's internal type parameters.
export type TenantTable<
  TName extends string,
  TColumns extends Record<string, SQLiteColumnBuilderBase>,
> = SQLiteTableWithColumns<{
  name: TName
  schema: undefined
  columns: BuildColumns<TName, TColumns & OrgIdColumn, 'sqlite'>
  dialect: 'sqlite'
}> &
  TenantBrand

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
): TenantTable<TName, TColumns> {
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
  return table as TenantTable<TName, TColumns>
}

export function isTenantTable(table: Table): boolean {
  return registry.has(table)
}

export function tenantTableNames(): string[] {
  return [...names]
}
