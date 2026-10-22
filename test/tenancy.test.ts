import { and, eq, inArray } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import {
  getTableConfig,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core'
import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  ConflictError,
  createTenantContext,
  isTenantTable,
  resolveTenant,
  subpath,
  TenancyError,
  TenantGuardError,
  tenantGuardLogger,
  type OrgRecord,
  type TenancyDeps,
  type TenantContext,
  tenantReference,
  tenantTable,
} from '@edgekits/kernel/tenancy'
import { createProjectsSql, projects, tasks } from './projects.tables.js'
import { seeded } from './random.js'

const db = drizzle(env.DB, { logger: tenantGuardLogger({ mode: 'strict' }) })

const orgs: Record<string, OrgRecord> = {
  A: { id: 'A', kind: 'team', plan: 'pro', slug: 'org-a' },
  B: { id: 'B', kind: 'team', plan: 'free', slug: 'org-b' },
}

const contextFor = (orgId: 'A' | 'B'): TenantContext =>
  createTenantContext({
    orgId,
    org: orgs[orgId] as OrgRecord,
    actor: { userId: `owner-${orgId}`, role: 'owner' },
    request: { id: `req-${orgId}`, locale: 'en', source: 'explicit' },
    db,
  })

beforeAll(async () => {
  for (const sql of createProjectsSql) await env.DB.prepare(sql).run()
})

describe('@edgekits/kernel/tenancy', () => {
  it('exposes the public entry', () => {
    expect(subpath).toBe('tenancy')
  })

  it('registers tables declared with tenantTable()', () => {
    expect(isTenantTable(projects)).toBe(true)
  })

  it('section 5 test 1: org A cannot read or change rows of org B', async () => {
    const a = contextFor('A').db.repo(projects)
    const b = contextFor('B').db.repo(projects)
    // a* only in A, b* only in B, s* in both orgs under the same id (ADR-008).
    const aIds: string[] = []
    const bIds: string[] = []
    const shared: string[] = []
    for (let i = 0; i < 5; i++) {
      aIds.push((await a.insert({ id: `a${i}`, name: `a${i}` })).id)
      bIds.push((await b.insert({ id: `b${i}`, name: `b${i}` })).id)
      shared.push((await a.insert({ id: `s${i}`, name: `A-s${i}` })).id)
      await b.insert({ id: `s${i}`, name: `B-s${i}` })
    }

    // The real ids, and 100 seeded ids around and past them.
    const random = seeded(0x5eed)
    const generated = Array.from(
      { length: 100 },
      () =>
        `${'abs'[Math.floor(random() * 3)]}${Math.floor(random() * 20) - 5}`,
    )
    const ids = [...bIds, ...aIds, ...shared, ...generated]
    let checked = 0
    for (const id of ids) {
      const row = await a.findById(id)
      if (row) expect(row.orgId).toBe('A')
      if (bIds.includes(id)) expect(row).toBeNull()
      if (shared.includes(id)) expect(row?.name).toBe(`A-${id}`)
      for (const found of await a.findMany(eq(projects.id, id))) {
        expect(found.orgId).toBe('A')
      }
      checked++
    }
    expect(checked).toBe(115)

    expect(await a.findMany(inArray(projects.id, bIds))).toEqual([])
    expect(await a.findMany(eq(projects.orgId, 'B'))).toEqual([])
    expect((await a.findMany()).map((r) => r.id).sort()).toEqual(
      [...aIds, ...shared].sort(),
    )

    for (const id of [...bIds, ...shared]) {
      const expected = shared.includes(id) ? 1 : 0
      expect(await a.update(id, { name: 'taken' })).toBe(expected)
    }
    for (const id of bIds) expect(await a.delete(id)).toBe(0)
    expect((await b.findMany()).map((r) => r.name).sort()).toEqual([
      'B-s0',
      'B-s1',
      'B-s2',
      'B-s3',
      'B-s4',
      'b0',
      'b1',
      'b2',
      'b3',
      'b4',
    ])
    expect(await a.update(aIds[0] as string, { name: 'renamed' })).toBe(1)
  })

  it('insert stores the context org, not an org_id in the values', async () => {
    const a = contextFor('A').db.repo(projects)
    const values = { id: 'smuggled', name: 'smuggled', orgId: 'B', org_id: 'B' }
    const row = await a.insert(values as { id: string; name: string })
    expect(row.orgId).toBe('A')
    const stored = await env.DB.prepare(
      'SELECT org_id FROM projects WHERE id = ?',
    )
      .bind(row.id)
      .first<{ org_id: string }>()
    expect(stored?.org_id).toBe('A')
  })

  describe('ADR-008: tenant tables are keyed per tenant', () => {
    it('emits the composite primary key (org_id, id) and makes id NOT NULL', () => {
      const config = getTableConfig(projects)
      expect(
        config.primaryKeys.map((key) => key.columns.map((c) => c.name)),
      ).toEqual([['org_id', 'id']])
      expect(config.columns.filter((c) => c.primary)).toEqual([])
      expect(projects.id.notNull).toBe(true)
      expect(config.indexes.map((i) => i.config.name)).toEqual([
        'projects_org_id_idx',
      ])
    })

    it('refuses a caller column marked .primaryKey()', () => {
      expect(() =>
        tenantTable('keyed', { id: text('id').primaryKey(), name: text() }),
      ).toThrow(/column id is marked \.primaryKey\(\).*ADR-008/)
      expect(() =>
        tenantTable('keyed_int', {
          id: integer('id').primaryKey({ autoIncrement: true }),
        }),
      ).toThrow(/column id is marked \.primaryKey\(\)/)
    })

    it('checks a primary key declared in extra', () => {
      const withId = tenantTable('extra_with_id', { id: text('id') }, (t) => [
        primaryKey({ columns: [t.orgId, t.id] }),
      ])
      expect(() => getTableConfig(withId)).toThrow(/declares id.*ADR-008/)
      const withoutOrg = tenantTable(
        'extra_without_org',
        { slug: text('slug').notNull() },
        (t) => [primaryKey({ columns: [t.slug] })],
      )
      expect(() => getTableConfig(withoutOrg)).toThrow(/must include org_id/)
      const withOrg = tenantTable(
        'extra_with_org',
        { slug: text('slug').notNull() },
        (t) => [primaryKey({ columns: [t.orgId, t.slug] })],
      )
      expect(
        getTableConfig(withOrg).primaryKeys[0]?.columns.map((c) => c.name),
      ).toEqual(['org_id', 'slug'])
    })

    it('tenantReference() produces the composite foreign key', () => {
      const [fk, ...rest] = getTableConfig(tasks).foreignKeys
      expect(rest).toEqual([])
      const reference = fk?.reference()
      expect(reference?.columns.map((c) => c.name)).toEqual([
        'org_id',
        'project_id',
      ])
      expect(reference?.foreignTable).toBe(projects)
      expect(reference?.foreignColumns.map((c) => c.name)).toEqual([
        'org_id',
        'id',
      ])
    })

    it('tenantReference() refuses a column outside a tenant table', () => {
      const plain = sqliteTable('plain_ref', { projectId: text('project_id') })
      expect(() => tenantReference(plain.projectId, projects)).toThrow(
        /both sides must be tenant tables/,
      )
    })

    it('accepts the same id in two orgs', async () => {
      const a = contextFor('A').db.repo(projects)
      const b = contextFor('B').db.repo(projects)
      await a.insert({ id: 'same', name: 'in A' })
      await b.insert({ id: 'same', name: 'in B' })
      expect((await a.findById('same'))?.name).toBe('in A')
      expect((await b.findById('same'))?.name).toBe('in B')
    })

    it('throws ConflictError without SQL on a duplicate id in one org', async () => {
      const a = contextFor('A').db.repo(projects)
      await a.insert({ id: 'twice', name: 'first' })
      const error = await a
        .insert({ id: 'twice', name: 'second' })
        .catch((e: unknown) => e)
      expect(error).toBeInstanceOf(ConflictError)
      expect((error as ConflictError).table).toBe('projects')
      expect((error as Error).message).not.toMatch(/insert|values|twice/i)
      expect((await a.findById('twice'))?.name).toBe('first')
    })

    it('leaves other constraint failures alone', async () => {
      const a = contextFor('A').db.repo(projects)
      const error = await a
        .insert({ id: 'nameless', name: null as unknown as string })
        .catch((e: unknown) => e)
      expect(error).toBeInstanceOf(Error)
      expect(error).not.toBeInstanceOf(ConflictError)
    })
  })

  it('repo() refuses a table not declared with tenantTable()', () => {
    const plain = sqliteTable('plain', { id: integer('id') })
    // @ts-expect-error A plain table is not a tenant table.
    expect(() => contextFor('A').db.repo(plain)).toThrow(/not a tenant table/)
  })

  describe('section 5 test 2: resolveTenant', () => {
    const members = new Map([['A:alice', 'admin']])
    const deps: TenancyDeps = {
      membership: async (userId, orgId) => {
        const role = members.get(`${orgId}:${userId}`)
        return role ? { role } : null
      },
      org: async (orgId) => orgs[orgId] ?? null,
      db,
      source: 'session',
      request: { id: 'req-1', locale: 'de' },
    }

    it('refuses a user who is not a member', async () => {
      const result = await resolveTenant({ userId: 'mallory' }, 'A', deps)
      expect(result).toBeInstanceOf(TenancyError)
      expect((result as TenancyError).reason).toBe('not-a-member')
    })

    it('refuses an org that does not exist', async () => {
      const result = await resolveTenant({ userId: 'alice' }, 'Z', deps)
      expect(result).toBeInstanceOf(TenancyError)
      expect((result as TenancyError).reason).toBe('no-such-org')
    })

    it('gives a member a context for the org with the membership role', async () => {
      const result = await resolveTenant({ userId: 'alice' }, 'A', deps)
      if (result instanceof TenancyError) throw result
      expect(result.orgId).toBe('A')
      expect(result.actor).toEqual({ userId: 'alice', role: 'admin' })
      expect(result.request).toEqual({
        id: 'req-1',
        locale: 'de',
        source: 'session',
      })
      const other = await resolveTenant({ userId: 'alice' }, 'B', deps)
      expect((other as TenancyError).reason).toBe('not-a-member')
    })
  })

  describe('dev guard', () => {
    it('throws on a select of a tenant table without an org_id predicate', async () => {
      await expect(db.select().from(projects).all()).rejects.toThrow(
        TenantGuardError,
      )
      await expect(
        db.select().from(projects).where(eq(projects.id, 'x')).all(),
      ).rejects.toThrow(TenantGuardError)
    })

    it('passes the same select with the predicate', async () => {
      const rows = await db
        .select()
        .from(projects)
        .where(eq(projects.orgId, 'A'))
        .all()
      expect(rows.length).toBeGreaterThan(0)
      expect(rows.every((row) => row.orgId === 'A')).toBe(true)
    })

    it('throws on update and delete without the predicate', async () => {
      await expect(
        db
          .update(projects)
          .set({ name: 'x' })
          .where(eq(projects.id, 'x'))
          .run(),
      ).rejects.toThrow(TenantGuardError)
      await expect(db.delete(projects).run()).rejects.toThrow(TenantGuardError)
      await expect(
        db
          .delete(projects)
          .where(and(eq(projects.orgId, 'none'), eq(projects.id, 'x')))
          .run(),
      ).resolves.toBeDefined()
    })

    it('lets every statement through in mode off', async () => {
      const open = drizzle(env.DB, {
        logger: tenantGuardLogger({ mode: 'off' }),
      })
      await expect(open.select().from(projects).all()).resolves.toBeDefined()
    })
  })
})
