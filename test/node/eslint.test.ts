import { getTableName, isTable, type Table } from 'drizzle-orm'
import { Linter } from 'eslint'
import tseslint from 'typescript-eslint'
import { describe, expect, it } from 'vitest'
import * as policy from '@edgekits/kernel/policy'
import * as tenancy from '@edgekits/kernel/tenancy'
import { tenantTableNames } from '../../src/tenancy/internal/table.js'
import {
  defaultRepositories,
  kernelTenantTables,
  pluginName,
  subpath,
  tenantTables,
  type TenantTablesOptions,
} from '@edgekits/kernel/eslint'

// Lints one file as a consumer's config would: the TypeScript parser, then
// the kernel's fragment. Paths are relative to the config's base directory.
function lint(
  filename: string,
  code: string,
  options: TenantTablesOptions = {},
): string[] {
  const linter = new Linter({ configType: 'flat', cwd: '/repo' })
  const messages = linter.verify(
    code,
    [
      {
        files: ['**/*.{ts,tsx}'],
        languageOptions: { parser: tseslint.parser as Linter.Parser },
      },
      ...tenantTables(options),
    ],
    { filename: `/repo/${filename}` },
  )
  return messages.map((m) => m.ruleId ?? `fatal: ${m.message}`)
}

const query = `import { projects } from '@acme/schema/projects.tables'
export const all = (db: { repo: (t: unknown) => unknown }) => db.repo(projects)
`
const access = `${pluginName}/tenant-table-access`
const references = `${pluginName}/tenant-table-references`

describe('@edgekits/kernel/eslint', () => {
  it('exposes the public entry', () => {
    expect(subpath).toBe('eslint')
    expect(defaultRepositories).toEqual([
      'src/modules/*/repository.ts',
      'src/modules/*/repo.ts',
    ])
  })

  it('flags a tenant-table query outside a repository', () => {
    expect(lint('src/routes/index.ts', query)).toEqual([access])
    expect(lint('src/modules/projects/service.ts', query)).toEqual([access])
    expect(lint('src/worker.ts', query)).toEqual([access])
  })

  it('passes the same query inside a repository', () => {
    expect(lint('src/modules/projects/repository.ts', query)).toEqual([])
    expect(lint('src/modules/projects/repo.ts', query)).toEqual([])
  })

  it('flags re-exports and dynamic imports, and relative table modules', () => {
    expect(
      lint('src/lib/a.ts', `export { projects } from './projects.tables.js'\n`),
    ).toEqual([access])
    expect(
      lint(
        'src/lib/b.ts',
        `export const load = () => import('../schema/projects.tables')\n`,
      ),
    ).toEqual([access])
  })

  it('allows type-only imports anywhere', () => {
    expect(
      lint(
        'src/routes/index.ts',
        `import type { projects } from '@acme/schema/projects.tables'
export type P = typeof projects
`,
      ),
    ).toEqual([])
    expect(
      lint(
        'src/routes/index.ts',
        `import { type projects } from '@acme/schema/projects.tables'
export type P = typeof projects
`,
      ),
    ).toEqual([])
  })

  it('allows table modules, drizzle configs and tests by default', () => {
    expect(lint('packages/schema/src/tasks.tables.ts', query)).toEqual([])
    expect(lint('packages/schema/drizzle.config.ts', query)).toEqual([])
    expect(lint('src/modules/projects/repo.test.ts', query)).toEqual([])
    expect(lint('apps/app/test/workers/projects.test.ts', query)).toEqual([])
  })

  it('takes the repository globs and more allowed files from the consumer', () => {
    const monorepo = {
      repositories: ['apps/*/src/modules/*/repository.ts'],
      allow: ['apps/app/src/seed.ts'],
    }
    expect(
      lint('apps/app/src/modules/projects/repository.ts', query, monorepo),
    ).toEqual([])
    expect(lint('apps/app/src/seed.ts', query, monorepo)).toEqual([])
    expect(lint('apps/app/src/routes/index.ts', query, monorepo)).toEqual([
      access,
    ])
    // The default globs are replaced, not extended.
    expect(lint('src/modules/projects/repo.ts', query, monorepo)).toEqual([
      access,
    ])
  })

  it('does not check a shared table module named by the consumer', () => {
    const auth = `import { user } from '@acme/schema/auth.tables'
export const u = user
`
    expect(lint('src/routes/index.ts', auth)).toEqual([access])
    expect(
      lint('src/routes/index.ts', auth, { shared: ['auth.tables'] }),
    ).toEqual([])
    expect(
      lint('src/routes/index.ts', query, { shared: ['auth.tables'] }),
    ).toEqual([access])
  })

  it('flags .references() inside tenantTable() in a *.tables.ts file (ADR-008)', () => {
    const table = (
      column: string,
    ) => `import { text } from 'drizzle-orm/sqlite-core'
import { tenantTable } from '@edgekits/kernel/tenancy'
export const tasks = tenantTable('tasks', {
  id: text(),
  ${column},
})
`
    expect(
      lint(
        'packages/schema/src/tasks.tables.ts',
        table(`projectId: text().references(() => other.id)`),
      ),
    ).toEqual([references])
    expect(
      lint('packages/schema/src/tasks.tables.ts', table(`projectId: text()`)),
    ).toEqual([])
    // Outside tenantTable() (a plain sqliteTable) references are fine.
    expect(
      lint(
        'packages/schema/src/auth.tables.ts',
        `import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
export const session = sqliteTable('session', {
  userId: text().references(() => user.id),
})
`,
      ),
    ).toEqual([])
  })

  it("flags the kernel's own tables imported as values outside a repository (F41)", () => {
    const monorepo = { repositories: ['apps/*/src/modules/*/repository.ts'] }
    const named = `import { subscriptions, can } from '@edgekits/kernel/policy'
export const t = [subscriptions, can]
`
    expect(lint('apps/app/src/modules/admin/rpc.ts', named, monorepo)).toEqual([
      access,
    ])
    expect(
      lint(
        'apps/app/src/modules/claims/sweep.ts',
        `import { orgClaims as claims } from '@edgekits/kernel/tenancy'
export const c = claims
`,
        monorepo,
      ),
    ).toEqual([access])
    expect(
      lint(
        'apps/app/src/lib/all.ts',
        `import * as policy from '@edgekits/kernel/policy'
export const p = policy
`,
        monorepo,
      ),
    ).toEqual([access])
    expect(
      lint(
        'packages/schema/src/index.ts',
        `export { orgSuspensions } from '@edgekits/kernel/policy'
`,
        monorepo,
      ),
    ).toEqual([access])
  })

  it("allows the kernel's other exports, type-only imports and repositories", () => {
    const monorepo = { repositories: ['apps/*/src/modules/*/repository.ts'] }
    expect(
      lint(
        'apps/app/src/worker.ts',
        `import { can, requirePlan } from '@edgekits/kernel/policy'
export const x = [can, requirePlan]
`,
        monorepo,
      ),
    ).toEqual([])
    expect(
      lint(
        'apps/app/src/worker.ts',
        `import { type subscriptions } from '@edgekits/kernel/policy'
export type S = typeof subscriptions
`,
        monorepo,
      ),
    ).toEqual([])
    expect(
      lint(
        'apps/app/src/modules/admin/repository.ts',
        `import { subscriptions } from '@edgekits/kernel/policy'
export const s = subscriptions
`,
        monorepo,
      ),
    ).toEqual([])
  })

  it('names every tenant table the kernel registers, by the subpath that exports it', () => {
    const exported = (module: Record<string, unknown>) =>
      Object.entries(module).filter(([, value]) => isTable(value)) as Array<
        [string, Table]
      >
    const modules: Record<string, Record<string, unknown>> = {
      '@edgekits/kernel/policy': policy,
      '@edgekits/kernel/tenancy': tenancy,
    }
    const registered = new Set(tenantTableNames())
    const listed = new Set<string>()
    for (const [source, names] of Object.entries(kernelTenantTables)) {
      const tables = new Map(exported(modules[source] ?? {}))
      for (const name of names) {
        const table = tables.get(name)
        expect(table, `${source} exports ${name}`).toBeDefined()
        listed.add(getTableName(table as Table))
      }
      // Every registered tenant table a subpath exports is listed.
      for (const [name, table] of tables) {
        if (registered.has(getTableName(table))) {
          expect(names, `${source} lists ${name}`).toContain(name)
        }
      }
    }
    for (const name of registered) expect(listed).toContain(name)
    // org_claims is listed although it is no tenant table.
    expect(registered.has('org_claims')).toBe(false)
    expect(listed.has('org_claims')).toBe(true)
  })
})
