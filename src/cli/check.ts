import { parseArgs } from 'node:util'
import type { Check } from '../checks/check.ts'
import { checks } from '../checks/index.ts'
import { type Environment, environment } from '../env.ts'
import { alertFailures, formatText, type Result, Run, writeJobSummary, writeResult } from '../report.ts'
import { Sources } from '../sources.ts'

const usage = `usage: pnpm check <name>[,<name>…] | all [options]

checks:
${checks.map((c) => `  ${c.name.padEnd(16)} ${c.summary}${c.mode === 'live' ? ' (live only)' : c.mode === 'mixed' ? ' (live steps with --env)' : ''}`).join('\n')}

options:
  --env <name>       run live steps against this environment (production)
  --alert            post one IRM alert per failed check (needs IRM_E2E_WEBHOOK_URL)
  --force-fail       add a check that fails on purpose, to prove the alert path
  --fabric <dir>     read fabric from <dir> instead of a fresh clone of main
  --webui <dir>      read the Console from <dir> instead of a fresh clone of main
  --website2 <dir>   read website2 from <dir> instead of a fresh clone of main
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
        fabric: { type: 'string' },
        webui: { type: 'string' },
        website2: { type: 'string' },
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

let env: Environment | null = null
if (values.env) {
  try {
    env = environment(values.env)
  } catch (error) {
    fail((error as Error).message)
  }
}

const all = positionals[0] === 'all'
const selected: Check[] = all
  ? checks
  : positionals[0]!.split(',').map((name) => checks.find((c) => c.name === name.trim()) ?? fail(`unknown check "${name}"`))
const liveOnly = selected.filter((c) => c.mode === 'live' && !env)
if (!all && liveOnly.length) fail(`${liveOnly.map((c) => c.name).join(', ')} only runs live: pass --env production`)

let sources: Sources
try {
  sources = new Sources({ fabric: values.fabric, webui: values.webui, website2: values.website2 })
} catch (error) {
  fail((error as Error).message)
}

const results: Result[] = []
try {
  for (const check of selected) {
    if (liveOnly.includes(check)) {
      console.log(`skip  ${check.name}: live only, and no --env was given`)
      continue
    }
    const run = new Run(check.name, env?.name ?? null)
    try {
      await check.run({ env, sources, run })
    } catch (error) {
      await run.step('run', () => {
        throw error
      })
    }
    results.push(run.finish())
  }

  if (values['force-fail']) {
    const run = new Run('force-fail', env?.name ?? null)
    await run.step('fail on purpose', () => {
      throw new Error('force_fail was set: this run fails on purpose to prove the alert path')
    })
    results.push(run.finish())
  }
} finally {
  await sources.cleanup()
}

for (const result of results) await writeResult(result, values.results)
console.log(formatText(results))
await writeJobSummary(results, `Contract checks${env ? ` against ${env.name}` : ' (static)'}`)
if (values.alert) await alertFailures(results)

process.exit(results.every((r) => r.ok) ? 0 : 1)
