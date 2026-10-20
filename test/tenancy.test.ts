import { and, eq, inArray } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { integer, sqliteTable } from 'drizzle-orm/sqlite-core'
import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import {
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
} from '@edgekits/kernel/tenancy'
import { createProjectsSql, projects } from './projects.tables'
import { seeded } from './random'

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
    const aIds: number[] = []
    const bIds: number[] = []
    for (let i = 0; i < 5; i++) {
      aIds.push((await a.insert({ name: `a${i}` })).id)
      bIds.push((await b.insert({ name: `b${i}` })).id)
    }

    // B's real ids, A's ids, and 100 seeded ids around and past the range.
    const random = seeded(0x5eed)
    const generated = Array.from(
      { length: 100 },
      () => Math.floor(random() * 400) - 50,
    )
    const ids = [...bIds, ...aIds, ...generated]
    let checked = 0
    for (const id of ids) {
      const row = await a.findById(id)
      if (row) expect(row.orgId).toBe('A')
      if (bIds.includes(id)) expect(row).toBeNull()
      for (const found of await a.findMany(eq(projects.id, id))) {
        expect(found.orgId).toBe('A')
      }
      checked++
    }
    expect(checked).toBe(110)

    expect(await a.findMany(inArray(projects.id, bIds))).toEqual([])
    expect(await a.findMany(eq(projects.orgId, 'B'))).toEqual([])
    expect((await a.findMany()).map((r) => r.id).sort()).toEqual(
      [...aIds].sort(),
    )

    for (const id of bIds) {
      expect(await a.update(id, { name: 'taken' })).toBe(0)
      expect(await a.delete(id)).toBe(0)
    }
    expect((await b.findMany()).map((r) => r.name).sort()).toEqual([
      'b0',
      'b1',
      'b2',
      'b3',
      'b4',
    ])
    expect(await a.update(aIds[0] as number, { name: 'renamed' })).toBe(1)
  })

  it('insert stores the context org, not an org_id in the values', async () => {
    const a = contextFor('A').db.repo(projects)
    const values = { name: 'smuggled', orgId: 'B', org_id: 'B' }
    const row = await a.insert(values as { name: string })
    expect(row.orgId).toBe('A')
    const stored = await env.DB.prepare(
      'SELECT org_id FROM projects WHERE id = ?',
    )
      .bind(row.id)
      .first<{ org_id: string }>()
    expect(stored?.org_id).toBe('A')
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
        db.select().from(projects).where(eq(projects.id, 1)).all(),
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
        db.update(projects).set({ name: 'x' }).where(eq(projects.id, 1)).run(),
      ).rejects.toThrow(TenantGuardError)
      await expect(db.delete(projects).run()).rejects.toThrow(TenantGuardError)
      await expect(
        db
          .delete(projects)
          .where(and(eq(projects.orgId, 'none'), eq(projects.id, 1)))
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
