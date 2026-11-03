import { Linter } from 'eslint'
import tseslint from 'typescript-eslint'
import { describe, expect, it } from 'vitest'
import {
  defaultRepositories,
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
})
