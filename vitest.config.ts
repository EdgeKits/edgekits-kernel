import { fileURLToPath } from 'node:url'
import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

// Sibling subpaths are imported as @edgekits/kernel/<name>. The package
// exports point at dist/, so tests resolve them to the sources instead.
const src = fileURLToPath(new URL('./src/', import.meta.url))

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@edgekits\/kernel\/([a-z]+)$/,
        replacement: `${src}$1/index.ts`,
      },
    ],
  },
  plugins: [
    cloudflareTest({
      miniflare: { compatibilityDate: '2026-10-01' },
    }),
  ],
})
