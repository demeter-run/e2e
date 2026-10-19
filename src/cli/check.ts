import { parseArgs } from 'node:util'
import type { Check } from '../checks/check.ts'
import { checks } from '../checks/index.ts'
import { type Environment, environment, environments } from '../env.ts'
import { alertFailures, formatText, type Result, Run, writeJobSummary, writeResult } from '../report.ts'

const usage = `usage: pnpm check <name>[,<name>…] | all --env <name> [options]

Every check reads the deployed surfaces of one environment, and no product
repository.

checks:
${checks.map((c) => `  ${c.name.padEnd(10)} ${c.summary}`).join('\n')}

options:
  --env <name>       the environment to check (${Object.keys(environments).join(', ')})
  --alert            post one IRM alert per failed check (needs IRM_E2E_WEBHOOK_URL)
  --force-fail       add a check that fails on purpose, to prove the alert path
  --results <dir>    where result files go (default: results)`

function fail(message: string): never {
  console.error(`${message}\n\n${usage}`)
  process.exit(2)
}

const { values, positionals } = (() => {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        env: { type: 'string' },
        alert: { type: 'boolean', default: false },
        'force-fail': { type: 'boolean', default: false },
        results: { type: 'string', default: 'results' },
        help: { type: 'boolean', short: 'h', default: false },
      },
    })
  } catch (error) {
    return fail((error as Error).message)
  }
})()

if (values.help) {
  console.log(usage)
  process.exit(0)
}
if (positionals.length !== 1) fail('name one check, a comma-separated list, or all')
if (!values.env) fail('name the environment to check: --env production')

let env: Environment
try {
  env = environment(values.env)
} catch (error) {
  fail((error as Error).message)
}

const selected: Check[] =
  positionals[0] === 'all'
    ? checks
    : positionals[0]!.split(',').map((name) => checks.find((c) => c.name === name.trim()) ?? fail(`unknown check "${name}"`))

const results: Result[] = []
for (const check of selected) {
  const run = new Run(check.name, env.name)
  try {
    await check.run({ env, run })
  } catch (error) {
    await run.step('run', () => {
      throw error
    })
  }
  results.push(run.finish())
}

if (values['force-fail']) {
  const run = new Run('force-fail', env.name)
  await run.step('fail on purpose', () => {
    throw new Error('force_fail was set: this run fails on purpose to prove the alert path')
  })
  results.push(run.finish())
}

for (const result of results) await writeResult(result, values.results)
console.log(formatText(results))
await writeJobSummary(results, `Contract checks against ${env.name}`)
if (values.alert) await alertFailures(results)

process.exit(results.every((r) => r.ok) ? 0 : 1)
