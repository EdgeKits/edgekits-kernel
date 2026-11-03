import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import tseslint from 'typescript-eslint'
// Node loads the TypeScript source directly (type stripping): one copy of
// the tenant-table rules, the one @edgekits/kernel/eslint publishes.
import { tenantTables } from './src/eslint/index.ts'

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

const kernel = {
  rules: {
    'subpath-boundary': subpathBoundary,
    'relative-extension': relativeExtension,
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
  // ADR-004 layer 2 and ADR-008 (src/eslint/index.ts). Inside the kernel the
  // repositories are src/**/repo.ts; the tenancy subpath and each subpath's
  // public entry (which re-exports tables for a consumer's migrations) may
  // import tables too.
  ...tenantTables({
    files: ['**/*.ts'],
    repositories: ['src/**/repo.ts'],
    allow: ['src/tenancy/**', 'src/*/index.ts'],
  }),
  {
    files: ['**/*.ts'],
    rules: {
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
