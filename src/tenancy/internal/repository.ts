import {
  and,
  eq,
  getTableName,
  type InferInsertModel,
  type InferSelectModel,
  type SQL,
} from 'drizzle-orm'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type {
  AnySQLiteColumn,
  SQLiteInsertValue,
  SQLiteTable,
  SQLiteUpdateSetSource,
} from 'drizzle-orm/sqlite-core'
import type { OrgId } from '../index'
import { isTenantTable, type TenantBrand } from './table'

// A tenant table with an id column, as tenantTable() returns it.
export type RepositoryTable = SQLiteTable &
  TenantBrand & { id: AnySQLiteColumn; orgId: AnySQLiteColumn }

type Row<T extends RepositoryTable> = InferSelectModel<T>
type Id<T extends RepositoryTable> = T['id']['_']['data']

export interface TenantRepository<T extends RepositoryTable> {
  findMany(where?: SQL): Promise<Row<T>[]>
  findById(id: Id<T>): Promise<Row<T> | null>
  insert(values: Omit<InferInsertModel<T>, 'orgId'>): Promise<Row<T>>
  // Update and delete resolve to the number of rows changed.
  update(
    id: Id<T>,
    values: Partial<Omit<InferInsertModel<T>, 'orgId' | 'id'>>,
  ): Promise<number>
  delete(id: Id<T>): Promise<number>
}

export interface TenantDb {
  repo<T extends RepositoryTable>(table: T): TenantRepository<T>
}

export type TenantDatabase = DrizzleD1Database<Record<string, unknown>>

// Any org id in caller-supplied values is dropped; the context sets it.
function withoutOrgId(values: object): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...values }
  delete rest.orgId
  delete rest.org_id
  return rest
}

// Repositories bound to one org: every read, update and delete carries
// org_id = orgId, and insert writes orgId.
export function createTenantDb(db: TenantDatabase, orgId: OrgId): TenantDb {
  return {
    repo<T extends RepositoryTable>(table: T): TenantRepository<T> {
      if (!isTenantTable(table)) {
        throw new Error(
          `${getTableName(table)} is not a tenant table; declare it with tenantTable().`,
        )
      }
      const scope = (predicate?: SQL) => and(eq(table.orgId, orgId), predicate)
      return {
        async findMany(where) {
          const rows = await db.select().from(table).where(scope(where)).all()
          return rows as Row<T>[]
        },
        async findById(id) {
          const row = await db
            .select()
            .from(table)
            .where(scope(eq(table.id, id)))
            .get()
          return (row as Row<T> | undefined) ?? null
        },
        async insert(values) {
          const row = await db
            .insert(table)
            .values({ ...withoutOrgId(values), orgId } as SQLiteInsertValue<T>)
            .returning()
            .get()
          return row as Row<T>
        },
        async update(id, values) {
          const result = await db
            .update(table)
            .set(withoutOrgId(values) as SQLiteUpdateSetSource<T>)
            .where(scope(eq(table.id, id)))
            .run()
          return result.meta.changes
        },
        async delete(id) {
          const result = await db
            .delete(table)
            .where(scope(eq(table.id, id)))
            .run()
          return result.meta.changes
        },
      }
    },
  }
}
