// npm run ci: the kernel's full gate, in order, stopping at the first
// failure. It is what .github/workflows/ci.yml runs and what "CI green
// locally" means. No secrets and no Cloudflare account: the tests run
// workerd locally through @cloudflare/vitest-plugin.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const EM_DASH = String.fromCharCode(0x2014)
// Generated files the agent does not author (CLAUDE.md, code style).
const GENERATED = [/(^|\/)package-lock\.json$/]

function tracked() {
  const out = spawnSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  if (out.status !== 0) throw new Error('git ls-files failed')
  return out.stdout.split('\0').filter(Boolean)
}

function noEmDashes() {
  const hits = tracked()
    .filter((file) => !GENERATED.some((pattern) => pattern.test(file)))
    .filter((file) => {
      const bytes = readFileSync(file)
      return !bytes.includes(0) && bytes.toString('utf8').includes(EM_DASH)
    })
  if (hits.length > 0) {
    throw new Error(`em-dash (U+2014) in:\n  ${hits.join('\n  ')}`)
  }
  console.log('no em-dash in any tracked file')
}

// `git ls-files | grep -i dev.vars` must print nothing.
function noTrackedDevVars() {
  const hits = tracked().filter((file) => /dev.vars/i.test(file))
  if (hits.length > 0) {
    throw new Error(`tracked files matching dev.vars:\n  ${hits.join('\n  ')}`)
  }
  console.log('no tracked file matches dev.vars')
}

// `npm run` hands the user's npm config to its children as npm_config_*
// variables; npm 11 refuses an allow-scripts that arrives that way in a
// project install ("not allowed in project-scoped installs"). The project's
// own package.json allowScripts stays in force.
const childEnv = { ...process.env }
delete childEnv.npm_config_allow_scripts

const steps = [
  { name: 'install', run: 'npm ci' },
  { name: 'format', run: 'npm run format:check' },
  { name: 'lint', run: 'npm run lint' },
  // tsc on src and test, then the build and the dist consumer checks.
  { name: 'typecheck and dist check', run: 'npm run typecheck' },
  // Both Vitest projects: workers (workerd) and node.
  { name: 'test', run: 'npm test' },
  { name: 'em-dash check', run: noEmDashes },
  { name: 'no tracked .dev.vars', run: noTrackedDevVars },
]

const started = Date.now()
for (const [index, step] of steps.entries()) {
  const label = `[${index + 1}/${steps.length}] ${step.name}`
  console.log(`\nci: ${label}`)
  const t0 = Date.now()
  if (typeof step.run === 'function') {
    try {
      step.run()
    } catch (error) {
      console.error(error instanceof Error ? error.message : error)
      console.error(`ci: FAILED at ${label}`)
      process.exit(1)
    }
  } else {
    const result = spawnSync(step.run, {
      shell: true,
      stdio: 'inherit',
      env: childEnv,
    })
    if (result.status !== 0) {
      console.error(`ci: FAILED at ${label} (exit ${result.status})`)
      process.exit(1)
    }
  }
  console.log(`ci: ${label} ok (${((Date.now() - t0) / 1000).toFixed(1)} s)`)
}
console.log(
  `\nci: all ${steps.length} steps ok in ${((Date.now() - started) / 1000).toFixed(0)} s`,
)
