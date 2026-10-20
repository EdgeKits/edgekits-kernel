// Type-checks dist/ from a consumer's side with skipLibCheck off, and fails
// only on diagnostics in our own files: every .d.ts under dist/ (imported by
// consumer.ts or not) and consumer.ts itself. drizzle-orm's published
// declarations do not type-check without skipLibCheck (missing optional peers,
// unimplemented abstract members), so diagnostics under node_modules/ are
// counted and reported but do not fail the check.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const here = path.dirname(fileURLToPath(import.meta.url))
const dist = path.resolve(here, '../../dist')

const configFile = ts.readConfigFile(
  path.join(here, 'tsconfig.json'),
  ts.sys.readFile,
)
if (configFile.error) fail([configFile.error])
const config = ts.parseJsonConfigFileContent(configFile.config, ts.sys, here)
if (config.errors.length > 0) fail(config.errors)

const declarations = fs
  .readdirSync(dist, { recursive: true })
  .filter((file) => String(file).endsWith('.d.ts'))
  .map((file) => path.join(dist, String(file)))
const program = ts.createProgram(
  [...config.fileNames, ...declarations],
  config.options,
)

const ours = (fileName) => {
  const file = path.normalize(fileName)
  return file.startsWith(dist + path.sep) || file.startsWith(here + path.sep)
}
const diagnostics = ts.getPreEmitDiagnostics(program)
const relevant = diagnostics.filter((d) => !d.file || ours(d.file.fileName))
if (relevant.length > 0) fail(relevant)

const checked = program.getSourceFiles().filter((f) => ours(f.fileName))
console.log(
  `check:dist clean: ${checked.length} files of ours checked, ` +
    `${diagnostics.length} diagnostics in third-party declarations ignored`,
)

function fail(list) {
  const host = {
    getCanonicalFileName: (f) => f,
    getCurrentDirectory: () => process.cwd(),
    getNewLine: () => '\n',
  }
  console.error(ts.formatDiagnostics(list, host))
  console.error(`check:dist failed: ${list.length} diagnostics in our files`)
  process.exit(1)
}
