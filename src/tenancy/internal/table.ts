import {
  getTableColumns,
  is,
  type BuildColumns,
  type NotNull,
  type Table,
} from 'drizzle-orm'
import {
  foreignKey,
  index,
  PrimaryKeyBuilder,
  primaryKey,
  sqliteTable,
  text,
  type AnySQLiteColumn,
  type ForeignKeyBuilder,
  type SQLiteColumn,
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

// The id column is part of the composite primary key (ADR-008), so the
// kernel makes it NOT NULL: SQLite accepts NULL in a non-INTEGER key column.
type WithKeyedId<TColumns extends Record<string, SQLiteColumnBuilderBase>> = {
  [K in keyof TColumns]: K extends 'id' ? NotNull<TColumns[K]> : TColumns[K]
}

// The table tenantTable() returns. Spelled out so the emitted declaration
// names it instead of inlining Drizzle's internal type parameters.
export type TenantTable<
  TName extends string,
  TColumns extends Record<string, SQLiteColumnBuilderBase>,
> = SQLiteTableWithColumns<{
  name: TName
  schema: undefined
  columns: BuildColumns<TName, WithKeyedId<TColumns> & OrgIdColumn, 'sqlite'>
  dialect: 'sqlite'
}> &
  TenantBrand

type Columns = Record<string, SQLiteColumn>

// Declares a tenant-scoped table: adds the org_id column and its index and
// registers the table. The caller never declares org_id itself. With an id
// column the primary key is (org_id, id) (ADR-008); a column marked
// .primaryKey() is refused here. A table without id may declare its own
// composite primary key in `extra`, and it must include org_id; that check
// runs when Drizzle evaluates `extra` (drizzle-kit, getTableConfig), because
// `extra` may name tables declared after this one.
export function tenantTable<
  TName extends string,
  TColumns extends Record<string, SQLiteColumnBuilderBase>,
>(
  name: TName,
  columns: TColumns & { orgId?: never },
  extra?: (
    self: BuildColumns<TName, WithKeyedId<TColumns> & OrgIdColumn, 'sqlite'>,
  ) => SQLiteTableExtraConfigValue[],
): TenantTable<TName, TColumns> {
  if ('orgId' in columns) {
    throw new Error(
      `tenantTable('${name}') adds org_id itself; remove the orgId column.`,
    )
  }
  const hasId = 'id' in columns
  if (hasId) (columns.id as unknown as { notNull(): unknown }).notNull()
  const all = { ...columns, ...orgIdColumn() }
  const table = sqliteTable(name, all, (self) => {
    const own = extra?.(self as never) ?? []
    for (const value of own) {
      if (!is(value, PrimaryKeyBuilder)) continue
      if (hasId) {
        throw new Error(
          `tenantTable('${name}') declares id, so its primary key is (org_id, id) (ADR-008); remove the primary key from extra.`,
        )
      }
      // The builder's columns field is untyped in Drizzle's declarations
      // (marked internal) but is a plain field that drizzle-kit reads too.
      const keyColumns = (value as unknown as { columns: SQLiteColumn[] })
        .columns
      if (!keyColumns.includes(self.orgId)) {
        throw new Error(
          `tenantTable('${name}'): a primary key must include org_id (ADR-008).`,
        )
      }
    }
    const cols = self as unknown as Columns
    return [
      index(`${name}_org_id_idx`).on(self.orgId),
      ...(hasId
        ? [primaryKey({ columns: [self.orgId, cols.id as SQLiteColumn] })]
        : []),
      ...own,
    ]
  })
  for (const [key, column] of Object.entries(getTableColumns(table))) {
    if (column.primary) {
      throw new Error(
        `tenantTable('${name}'): column ${key} is marked .primaryKey(); tenant tables are keyed by (org_id, id) (ADR-008), remove .primaryKey().`,
      )
    }
  }
  registry.add(table)
  names.add(name)
  return table as unknown as TenantTable<TName, TColumns>
}

// A composite foreign key for a tenant table's extra config:
// (org_id, column) -> (target.org_id, target.id), so a row can only reference
// a row of its own org (ADR-008). `target` is another tenant table, or the
// table's own columns for a self-reference.
export function tenantReference(
  column: AnySQLiteColumn,
  target: { orgId: AnySQLiteColumn; id: AnySQLiteColumn },
): ForeignKeyBuilder {
  const orgId = (getTableColumns(column.table) as Columns).orgId
  if (orgId?.name !== 'org_id' || target.orgId.name !== 'org_id') {
    throw new Error(
      `tenantReference(${column.name}): both sides must be tenant tables.`,
    )
  }
  return foreignKey({
    columns: [orgId, column] as [SQLiteColumn, SQLiteColumn],
    foreignColumns: [target.orgId, target.id] as [SQLiteColumn, SQLiteColumn],
  })
}

export function isTenantTable(table: Table): boolean {
  return registry.has(table)
}

export function tenantTableNames(): string[] {
  return [...names]
}
