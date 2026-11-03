import { fileURLToPath } from 'node:url'
import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

// Sibling subpaths are imported as @edgekits/kernel/<name>. The package
// exports point at dist/, so tests resolve them to the sources instead.
const src = fileURLToPath(new URL('./src/', import.meta.url))
const alias = [
  {
    find: /^@edgekits\/kernel\/([a-z]+)$/,
    replacement: `${src}$1/index.ts`,
  },
]

// Two projects. workers: every subpath's tests, in workerd through
// @cloudflare/vitest-plugin. node: test/node/, for code that runs in Node
// only (the /eslint fragment runs inside ESLint).
export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        plugins: [
          cloudflareTest({
            miniflare: {
              compatibilityDate: '2026-10-01',
              d1Databases: { DB: 'edgekits-kernel-test' },
            },
          }),
        ],
        test: {
          name: 'workers',
          include: ['src/**/*.test.ts', 'test/*.test.ts'],
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'node',
          environment: 'node',
          include: ['test/node/**/*.test.ts'],
        },
      },
    ],
  },
})
