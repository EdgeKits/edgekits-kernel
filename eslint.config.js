import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import tseslint from 'typescript-eslint'

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), 'src')

// The subpath directory a file under src/ belongs to, or null outside src/.
function subpathDir(file) {
  const rel = path.relative(src, file)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null
  const [name] = rel.split(path.sep)
  return name ? path.join(src, name) : null
}

// A relative import must stay inside the importing file's own subpath
// directory. Siblings are reached only through @edgekits/kernel/<name>.
const subpathBoundary = {
  meta: {
    type: 'problem',
    messages: {
      leavesSubpath:
        "Relative import '{{source}}' leaves src/{{name}}/. Import a sibling subpath as @edgekits/kernel/<name>.",
    },
    schema: [],
  },
  create(context) {
    const own = subpathDir(context.filename)
    if (!own) return {}
    const check = (node) => {
      const source = node.source?.value
      if (typeof source !== 'string' || !source.startsWith('.')) return
      const target = path.resolve(path.dirname(context.filename), source)
      const rel = path.relative(own, target)
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        context.report({
          node: node.source,
          messageId: 'leavesSubpath',
          data: { source, name: path.basename(own) },
        })
      }
    }
    return {
      ImportDeclaration: check,
      ExportAllDeclaration: check,
      ExportNamedDeclaration: check,
      ImportExpression: check,
    }
  },
}

// dist/ must load in plain Node, whose ESM resolver takes a relative
// specifier literally: every relative import or export in src/ names the
// emitted file, './x.js' (or './dir/index.js'). The fix appends the suffix
// that matches the source file next to the importer.
const relativeExtension = {
  meta: {
    type: 'problem',
    fixable: 'code',
    messages: {
      missingJs:
        "Relative specifier '{{source}}' must end in .js so that Node resolves the emitted file.",
    },
    schema: [],
  },
  create(context) {
    const check = (node) => {
      const source = node.source
      if (source?.type !== 'Literal' || typeof source.value !== 'string') return
      const value = source.value
      if (!value.startsWith('.') || value.endsWith('.js')) return
      const target = path.resolve(path.dirname(context.filename), value)
      const suffix = fs.existsSync(`${target}.ts`)
        ? '.js'
        : fs.existsSync(path.join(target, 'index.ts'))
          ? '/index.js'
          : null
      context.report({
        node: source,
        messageId: 'missingJs',
        data: { source: value },
        fix: suffix
          ? (fixer) => fixer.replaceText(source, `'${value}${suffix}'`)
          : null,
      })
    }
    return {
      ImportDeclaration: check,
      ExportAllDeclaration: check,
      ExportNamedDeclaration: check,
      ImportExpression: check,
    }
  },
}

const root = path.dirname(fileURLToPath(import.meta.url))

// ADR-004 layer 2. Convention: tenant tables are declared with tenantTable()
// and exported from files named *.tables.ts. Only repositories
// (src/**/repo.ts), the tenancy subpath, a subpath's public entry
// (src/<name>/index.ts, which re-exports them for a consumer's migrations),
// other *.tables.ts files (for references between tables and schema
// packages), drizzle.config.ts files and tests may import values from them;
// type-only imports are allowed anywhere.
// ADR-008: inside a tenantTable() call in a *.tables.ts file, a column may not
// use .references(). Drizzle keeps a column builder's references private, so
// tenantTable() cannot refuse them itself; references go through
// tenantReference() (or foreignKey() for a non-tenant target) in the extra
// config.
const tablesModule = /\.tables(\.[cm]?[jt]s)?$/

function mayImportTables(file) {
  const rel = path.relative(root, file).split(path.sep).join('/')
  return (
    /^src\/(.+\/)?repo\.ts$/.test(rel) ||
    rel.startsWith('src/tenancy/') ||
    /^src\/[^/]+\/index\.ts$/.test(rel) ||
    /\.tables\.ts$/.test(rel) ||
    /(^|\/)drizzle\.config\.ts$/.test(rel) ||
    /\.test\.ts$/.test(rel) ||
    rel.startsWith('test/')
  )
}

const tenantTableAccess = {
  meta: {
    type: 'problem',
    messages: {
      tenantTable:
        "'{{source}}' exports tenant tables. Query them through a module repository (src/**/repo.ts) and TenantDb.repo().",
      references:
        'A tenant table column may not use .references() (ADR-008). Use tenantReference() in the extra config, or foreignKey() for a non-tenant target.',
    },
    schema: [],
  },
  create(context) {
    const visitors = {}
    if (tablesModule.test(context.filename)) {
      visitors[
        'CallExpression[callee.name="tenantTable"] CallExpression[callee.property.name="references"]'
      ] = (node) => {
        context.report({ node: node.callee.property, messageId: 'references' })
      }
    }
    if (mayImportTables(context.filename)) return visitors
    const check = (node) => {
      const source = node.source?.value
      if (typeof source !== 'string' || !tablesModule.test(source)) return
      if (node.importKind === 'type' || node.exportKind === 'type') return
      if (
        node.specifiers?.length > 0 &&
        node.specifiers.every(
          (s) => s.importKind === 'type' || s.exportKind === 'type',
        )
      ) {
        return
      }
      context.report({
        node: node.source,
        messageId: 'tenantTable',
        data: { source },
      })
    }
    return {
      ...visitors,
      ImportDeclaration: check,
      ExportAllDeclaration: check,
      ExportNamedDeclaration: check,
      ImportExpression: check,
    }
  },
}

const kernel = {
  rules: {
    'subpath-boundary': subpathBoundary,
    'relative-extension': relativeExtension,
    'tenant-table-access': tenantTableAccess,
  },
}

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/'] },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    plugins: { kernel },
    rules: {
      'kernel/subpath-boundary': 'error',
      'kernel/relative-extension': 'error',
      // Public functions name their return type, so the emitted declarations
      // reference named types instead of inlining library internals.
      '@typescript-eslint/explicit-module-boundary-types': 'error',
    },
  },
  {
    files: ['**/*.ts'],
    plugins: { kernel },
    rules: {
      'kernel/tenant-table-access': 'error',
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@edgekits/kernel',
              message:
                'The package root exports nothing. Import a subpath: @edgekits/kernel/<name>.',
            },
          ],
        },
      ],
    },
  },
)
