// The ADR-004 lint layer as a flat-config fragment (audit F4): tenant tables
// are queried only from module repositories and the kernel, and a tenant
// table names its references through tenantReference() or foreignKey()
// (ADR-008). The kernel's own eslint.config.js consumes this file, so the
// rules exist once.
//
// Convention: tenant tables are declared with tenantTable() in files named
// *.tables.ts. A module that imports a value from such a file outside the
// allowed files is reported; type-only imports are allowed anywhere. A table
// module that holds no tenant table (Better Auth's tables, for example) is
// named in `shared` and is not checked.
//
// The kernel's own tables are exported from its subpaths, not from a
// *.tables module, so the rule also knows them by name (audit F41): a value
// import of one of kernelTenantTables' names from its subpath is reported
// like a table module, and so is a namespace import or `export *` of such a
// subpath.
//
// This file has no relative imports and only erasable TypeScript syntax, so
// Node loads it from the sources as well as from dist/ (the kernel's own
// config imports src/eslint/index.ts).
import type { ESLint, Linter, Rule } from 'eslint'

export const subpath = 'eslint' as const

// The plugin's name in a config; rule ids are `${pluginName}/<rule>`.
export const pluginName = 'edgekits'

// Module repositories (ADR-004), relative to the config's base directory.
export const defaultRepositories: readonly string[] = [
  'src/modules/*/repository.ts',
  'src/modules/*/repo.ts',
]

// Files that may always import tenant tables: other table modules
// (references between tables, schema packages), drizzle-kit configs and
// tests.
export const defaultAllowed: readonly string[] = [
  '**/*.tables.ts',
  '**/drizzle.config.ts',
  '**/*.test.ts',
  '**/*.test.tsx',
  'test/**',
  '**/test/**',
]

export const defaultFiles: readonly string[] = [
  '**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}',
]

const tablesModule = /\.tables(\.[cm]?[jt]s)?$/

// The kernel's tables that only repositories query, by the subpath that
// exports them: every tenantTable() the kernel registers (subscriptions,
// entitlement_overrides, org_suspensions; test/node/eslint.test.ts checks
// the list against tenantTableNames()), and org_claims, which is no tenant
// table (an operator's claim has no org until it is accepted) but is read
// and written only through the kernel's claim functions and repositories.
export const kernelTenantTables: Readonly<Record<string, readonly string[]>> = {
  '@edgekits/kernel/policy': [
    'subscriptions',
    'entitlementOverrides',
    'orgSuspensions',
  ],
  '@edgekits/kernel/tenancy': ['orgClaims'],
}

// The last segment of an import source without its extension:
// '@acme/schema/auth.tables' and './auth.tables.js' are both 'auth.tables'.
const moduleName = (source: string): string =>
  (source.split('/').pop() ?? source).replace(/\.[cm]?[jt]sx?$/, '')

interface SpecifierLike {
  type?: string
  importKind?: string
  exportKind?: string
  imported?: { name?: string; value?: unknown }
  local?: { name?: string; value?: unknown }
}

interface ImportLike {
  type?: string
  source?: { type?: string; value?: unknown } | null
  importKind?: string
  exportKind?: string
  specifiers?: ReadonlyArray<SpecifierLike>
}

// The name a specifier takes from its source: `imported` for an import,
// `local` for a re-export (`export { a as b } from`).
const sourceName = (s: SpecifierLike): string | undefined => {
  const id = s.type === 'ExportSpecifier' ? s.local : (s.imported ?? s.local)
  const name = id?.name ?? id?.value
  return typeof name === 'string' ? name : undefined
}

const typeOnly = (node: ImportLike): boolean =>
  node.importKind === 'type' ||
  node.exportKind === 'type' ||
  (node.specifiers !== undefined &&
    node.specifiers.length > 0 &&
    node.specifiers.every(
      (s) => s.importKind === 'type' || s.exportKind === 'type',
    ))

// Reports a value import (or re-export, or dynamic import) of a tenant table
// module. Where it applies is the config's business: tenantTables() turns it
// on everywhere except the repositories and the allowed files.
export const tenantTableAccess: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Tenant tables are queried only through module repositories (ADR-004).',
    },
    messages: {
      tenantTable:
        "'{{source}}' exports tenant tables. Query them through a module repository and TenantDb.repo().",
      kernelTable:
        "'{{name}}' from '{{source}}' is a table only repositories query. Query it through a module repository.",
    },
    schema: [
      {
        type: 'object',
        properties: {
          shared: { type: 'array', items: { type: 'string' } },
          packages: {
            type: 'object',
            additionalProperties: { type: 'array', items: { type: 'string' } },
          },
        },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const options = (context.options[0] ?? {}) as {
      shared?: string[]
      packages?: Record<string, string[]>
    }
    const shared = new Set((options.shared ?? []).map(moduleName))
    const packages = options.packages ?? kernelTenantTables
    const checkPackage = (
      node: ImportLike & Rule.Node,
      source: string,
      names: readonly string[],
    ) => {
      if (typeOnly(node)) return
      const whole =
        node.type === 'ExportAllDeclaration' ||
        node.type === 'ImportExpression' ||
        (node.specifiers ?? []).some(
          (s) => s.type === 'ImportNamespaceSpecifier',
        )
      const hits = whole
        ? ['*']
        : (node.specifiers ?? [])
            .filter((s) => s.importKind !== 'type' && s.exportKind !== 'type')
            .map(sourceName)
            .filter((name): name is string => !!name && names.includes(name))
      for (const name of hits) {
        context.report({
          node: node.source as unknown as Rule.Node,
          messageId: 'kernelTable',
          data: { name, source },
        })
      }
    }
    const check = (node: ImportLike & Rule.Node) => {
      const value = node.source?.value
      if (typeof value !== 'string') return
      const names = Object.hasOwn(packages, value) ? packages[value] : undefined
      if (names) return checkPackage(node, value, names)
      if (!tablesModule.test(value)) return
      if (shared.has(moduleName(value)) || typeOnly(node)) return
      context.report({
        node: node.source as unknown as Rule.Node,
        messageId: 'tenantTable',
        data: { source: value },
      })
    }
    return {
      ImportDeclaration: check,
      ExportAllDeclaration: check,
      ExportNamedDeclaration: check,
      ImportExpression: check,
    } as Rule.RuleListener
  },
}

// ADR-008: inside a tenantTable() call, a column may not use .references().
// Drizzle keeps a column builder's references private, so tenantTable()
// cannot refuse them itself; references go through tenantReference() (or
// foreignKey() for a non-tenant target) in the extra config.
export const tenantTableReferences: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'A tenant table column names no .references() (ADR-008); use tenantReference() or foreignKey().',
    },
    messages: {
      references:
        'A tenant table column may not use .references() (ADR-008). Use tenantReference() in the extra config, or foreignKey() for a non-tenant target.',
    },
    schema: [],
  },
  create(context) {
    return {
      'CallExpression[callee.name="tenantTable"] CallExpression[callee.property.name="references"]'(
        node: Rule.Node,
      ) {
        const callee = (node as unknown as { callee: { property: Rule.Node } })
          .callee
        context.report({ node: callee.property, messageId: 'references' })
      },
    }
  },
}

export const plugin: ESLint.Plugin = {
  meta: { name: '@edgekits/kernel/eslint' },
  rules: {
    'tenant-table-access': tenantTableAccess,
    'tenant-table-references': tenantTableReferences,
  },
}

export interface TenantTablesOptions {
  // The module repositories, as globs relative to the config's base
  // directory. Default: defaultRepositories. A monorepo names its apps, for
  // example 'apps/*/src/modules/*/repository.ts'.
  repositories?: readonly string[]
  // More files that may import tenant tables, added to defaultAllowed.
  allow?: readonly string[]
  // The files the rules look at. Default: defaultFiles.
  files?: readonly string[]
  // Table modules that hold no tenant table, by name ('auth.tables'): imports
  // of them are not checked.
  shared?: readonly string[]
  // Tables exported from packages, by import source: a value import of one
  // of the names is reported. Default: kernelTenantTables.
  packages?: Readonly<Record<string, readonly string[]>>
}

// Two config objects: tenant-table-access on every file but the repositories
// and the allowed files, tenant-table-references on the *.tables files.
export function tenantTables(
  options: TenantTablesOptions = {},
): Linter.Config[] {
  const files = [...(options.files ?? defaultFiles)]
  const ignores = [
    ...(options.repositories ?? defaultRepositories),
    ...defaultAllowed,
    ...(options.allow ?? []),
  ]
  return [
    {
      name: 'edgekits/tenant-table-access',
      files,
      ignores,
      plugins: { [pluginName]: plugin },
      rules: {
        [`${pluginName}/tenant-table-access`]: [
          'error',
          {
            shared: [...(options.shared ?? [])],
            packages: Object.fromEntries(
              Object.entries(options.packages ?? kernelTenantTables).map(
                ([source, names]) => [source, [...names]],
              ),
            ),
          },
        ],
      },
    },
    {
      name: 'edgekits/tenant-table-references',
      files: ['**/*.tables.{ts,tsx,mts,cts,js,mjs,cjs}'],
      plugins: { [pluginName]: plugin },
      rules: { [`${pluginName}/tenant-table-references`]: 'error' },
    },
  ]
}
