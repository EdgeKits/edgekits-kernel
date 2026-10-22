// Imports every subpath in package.json "exports" through its bare specifier
// with plain Node, no bundler: the package resolves itself by name, so this
// file must live inside it. Fails when an import throws or a module has no
// exports. Run after the build (check:dist).
import fs from 'node:fs'

const pkg = JSON.parse(
  fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
)

let failed = 0
for (const entry of Object.keys(pkg.exports)) {
  const specifier = `${pkg.name}/${entry.replace(/^\.\//, '')}`
  try {
    const names = Object.keys(await import(specifier))
    if (names.length === 0) throw new Error('the module has no exports')
    console.log(`ok    ${specifier} (${names.length} exports)`)
  } catch (error) {
    failed++
    console.log(
      `FAIL  ${specifier}: ${error.code ?? error.name}: ${error.message}`,
    )
  }
}

if (failed > 0) {
  console.error(
    `import check failed: ${failed} of ${Object.keys(pkg.exports).length} subpaths`,
  )
  process.exit(1)
}
console.log(`import check clean: ${Object.keys(pkg.exports).length} subpaths`)
