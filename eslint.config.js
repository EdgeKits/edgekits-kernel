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

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/'] },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    plugins: { kernel: { rules: { 'subpath-boundary': subpathBoundary } } },
    rules: {
      'kernel/subpath-boundary': 'error',
    },
  },
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
