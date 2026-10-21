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

// Thrown by insert and update when a uniqueness constraint (the (org_id, id)
// key or a unique index) refuses the row. Carries the table name only, never
// the SQL or the values; /hono maps it to 409.
export class ConflictError extends Error {
  override name = 'ConflictError'

  constructor(readonly table: string) {
    super(`Conflict on ${table}: a row with the same key already exists.`)
  }
}

// D1 reports a uniqueness violation as, for example,
//   D1_ERROR: UNIQUE constraint failed: projects.org_id, projects.id:
//   SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_PRIMARYKEY)
// and Drizzle wraps it as the cause of a DrizzleQueryError. Other constraint
// failures (NOT NULL, FOREIGN KEY) do not match and stay 500.
const UNIQUE_VIOLATION = /UNIQUE constraint failed/

function isUniqueViolation(error: unknown): boolean {
  for (let e = error; e instanceof Error; e = e.cause) {
    if (UNIQUE_VIOLATION.test(e.message)) return true
  }
  return false
}

async function orConflict<R>(table: string, run: () => Promise<R>): Promise<R> {
  try {
    return await run()
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError(table)
    throw error
  }
}

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
      const name = getTableName(table)
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
          const row = await orConflict(name, () =>
            db
              .insert(table)
              .values({
                ...withoutOrgId(values),
                orgId,
              } as SQLiteInsertValue<T>)
              .returning()
              .get(),
          )
          return row as Row<T>
        },
        async update(id, values) {
          const result = await orConflict(name, () =>
            db
              .update(table)
              .set(withoutOrgId(values) as SQLiteUpdateSetSource<T>)
              .where(scope(eq(table.id, id)))
              .run(),
          )
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
