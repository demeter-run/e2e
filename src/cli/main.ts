import { parseArgs } from 'node:util'
import type { Check } from '../checks/check.ts'
import { checks as allChecks } from '../checks/index.ts'
import { type Environment, environment, environments } from '../env.ts'
import { alertFailures, formatText, type Result, Run, writeJobSummary, writeResult } from '../report.ts'

const usage = (checks: Check[]) => `usage: pnpm check <name>[,<name>…] | all --env <name> [options]

Every check reads the deployed surfaces of one environment, and no product
repository.

checks:
${checks.map((c) => `  ${c.name.padEnd(10)} ${c.summary}`).join('\n')}

options:
  --env <name>       the environment to check (${Object.keys(environments).join(', ')})
  --alert            post one IRM alert per failed check (needs IRM_E2E_WEBHOOK_URL)
  --force-fail       add a check that fails on purpose, to prove the alert path
  --results <dir>    where result files go (default: results)`

/** A mistake in the command line: printed with the usage, exit 2. */
class UsageError extends Error {}

/**
 * `pnpm check`: runs the named checks, writes their results, prints the run,
 * appends the job summary and, with `--alert`, alerts on failures. Returns the
 * exit code: 0 when every result passed, 1 when one failed, 2 on a usage error.
 */
export async function main(argv: string[], { checks = allChecks }: { checks?: Check[] } = {}): Promise<number> {
  let values: { env?: string; alert: boolean; 'force-fail': boolean; results: string; help: boolean }
  let selected: Check[]
  let env: Environment
  try {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        env: { type: 'string' },
        alert: { type: 'boolean', default: false },
        'force-fail': { type: 'boolean', default: false },
        results: { type: 'string', default: 'results' },
        help: { type: 'boolean', short: 'h', default: false },
      },
    })
    values = parsed.values
    if (values.help) {
      console.log(usage(checks))
      return 0
    }
    if (parsed.positionals.length !== 1) throw new UsageError('name one check, a comma-separated list, or all')
    if (!values.env) throw new UsageError('name the environment to check: --env production')
    try {
      env = environment(values.env)
    } catch (error) {
      throw new UsageError((error as Error).message)
    }
    if (env.name === 'mock') {
      throw new UsageError('the mock serves only the agent routes, which the checks do not read: pnpm j0 --env mock or pnpm contract --env mock')
    }
    const names = parsed.positionals[0]!
    selected =
      names === 'all'
        ? checks
        : names.split(',').map((name) => checks.find((c) => c.name === name.trim()) ?? raise(new UsageError(`unknown check "${name}"`)))
  } catch (error) {
    console.error(`${(error as Error).message}\n\n${usage(checks)}`)
    return 2
  }

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

  return results.every((r) => r.ok) ? 0 : 1
}

function raise(error: Error): never {
  throw error
}
