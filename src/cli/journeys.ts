import { spawn } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { type Environment, environment, environments } from '../env.ts'
import { alertFailures, formatText, type Result, Run, writeJobSummary, writeResult } from '../report.ts'

/**
 * A browser journey: one Playwright spec under `journeys/`, which writes one
 * result per test it runs. Those results are the verdict, not Playwright's
 * pass or fail: a journey's tests share one signed-in browser, and Playwright
 * replaces a worker, and the browser with it, after any failed test.
 */
export interface Journey {
  name: string
  summary: string
  spec: string
  /** The result files the spec writes, one per test, by name. */
  results: string[]
}

export const journeys: Journey[] = [
  {
    name: 'j2',
    summary: "a person's path from demeter.run to a first request, its usage, cost and Console price; then 401, 429 and a legacy cookie",
    spec: 'journeys/j2.spec.ts',
    results: ['j2', 'j2-401', 'j2-429', 'j2-legacy-cookie'],
  },
  {
    name: 'sign-in',
    summary: 'the standing test user signs in to the Console from /login, then leaves no project behind',
    spec: 'journeys/sign-in.spec.ts',
    results: ['sign-in'],
  },
]

/** What a spec reads from the environment the CLI starts it with. */
export const specEnv = { env: 'E2E_ENV', results: 'E2E_RESULTS' } as const

/** Runs one spec with Playwright and resolves to its exit code. */
export type Playwright = (spec: string, env: NodeJS.ProcessEnv) => Promise<number>

const runPlaywright: Playwright = (spec, env) =>
  new Promise((resolve, reject) => {
    const child = spawn('playwright', ['test', spec], { stdio: 'inherit', env })
    child.on('error', reject)
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)))
  })

const usage = (all: Journey[]) => `usage: pnpm journey <name> --env <name> [options]
       pnpm j2 --env <name> [options]

A journey drives a browser through a deployed environment, signed in as its
standing test user, whose password is E2E_USER_PASSWORD.

journeys:
${all.map((j) => `  ${j.name.padEnd(10)} ${j.summary}`).join('\n')}

options:
  --env <name>       the environment to walk (${Object.keys(environments).join(', ')})
  --alert            post one IRM alert per failed result (needs IRM_E2E_WEBHOOK_URL)
  --force-fail       add a result that fails on purpose, to prove the alert path
  --results <dir>    where result files go (default: results)`

class UsageError extends Error {}

/** A result for one the spec did not write: Playwright stopped before that test reported. */
function missing(name: string, env: string, code: number): Result {
  const now = new Date().toISOString()
  const detail = `the journey wrote no result for ${name}: Playwright exited ${code} before it reported`
  return { name, env, started_at: now, finished_at: now, ok: false, steps: [{ name: 'report', ok: false, ms: 0, detail }] }
}

/**
 * `pnpm journey`: runs one journey's spec, reads its results, prints them,
 * appends the job summary and, with `--alert`, alerts on failures. Returns the
 * exit code: 0 when every result passed, 1 when one failed or is missing, 2 on
 * a usage error.
 */
export async function main(
  argv: string[],
  { all = journeys, playwright = runPlaywright }: { all?: Journey[]; playwright?: Playwright } = {},
): Promise<number> {
  let values: { env?: string; alert: boolean; 'force-fail': boolean; results: string; help: boolean }
  let journey: Journey
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
      console.log(usage(all))
      return 0
    }
    if (parsed.positionals.length !== 1) throw new UsageError('name one journey')
    const found = all.find((j) => j.name === parsed.positionals[0])
    if (!found) throw new UsageError(`unknown journey "${parsed.positionals[0]}"`)
    journey = found
    if (!values.env) throw new UsageError('name the environment to walk: --env production')
    try {
      env = environment(values.env)
    } catch (error) {
      throw new UsageError((error as Error).message)
    }
    if (!env.testUser) throw new UsageError(`the ${env.name} environment has no test user to sign in as`)
    if (!process.env.E2E_USER_PASSWORD) throw new UsageError(`set E2E_USER_PASSWORD to ${env.testUser}'s password`)
  } catch (error) {
    console.error(`${(error as Error).message}\n\n${usage(all)}`)
    return 2
  }

  // A result left by an earlier run must not stand in for one this run did not write.
  for (const name of journey.results) await rm(join(values.results, `${name}.json`), { force: true })
  const code = await playwright(journey.spec, { ...process.env, [specEnv.env]: env.name, [specEnv.results]: values.results })

  const results: Result[] = []
  for (const name of journey.results) {
    try {
      results.push(JSON.parse(await readFile(join(values.results, `${name}.json`), 'utf8')) as Result)
    } catch {
      results.push(missing(name, env.name, code))
    }
  }

  if (values['force-fail']) {
    const run = new Run('force-fail', env.name)
    await run.step('fail on purpose', () => {
      throw new Error('force_fail was set: this run fails on purpose to prove the alert path')
    })
    const result = run.finish()
    await writeResult(result, values.results)
    results.push(result)
  }

  console.log(formatText(results))
  await writeJobSummary(results, `Journey ${journey.name} against ${env.name}`)
  if (values.alert) await alertFailures(results)

  return results.every((r) => r.ok) ? 0 : 1
}
