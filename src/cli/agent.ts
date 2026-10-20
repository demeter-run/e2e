import { parseArgs } from 'node:util'
import { type Registration, registerWithPort, Secrets } from '../agent/client.ts'
import { contractTests, runContract, type Tag } from '../agent/contract.spec.ts'
import { j0 } from '../agent/j0.ts'
import { type Environment, environment, environments } from '../env.ts'
import { mockCalls } from '../mock/control.ts'
import { alertFailures, formatText, type Result, Run, writeJobSummary, writeResult } from '../report.ts'
import { TEST_USER } from '../signin.ts'

const usage = `usage: pnpm j0 --env <name> [--contract all|prod-safe] [options]
       pnpm contract --env mock [--tag prod-safe|mock-only] [options]

pnpm j0 runs J0, the coding agent's main journey: register, create a port,
request it, claim it in the browser, request it again, and, on production,
delete the claimed project. With --contract it also runs the contract tests on
the same registration, so a production run registers once.

pnpm contract runs the contract tests alone, on the mock: on production they
run inside J0, which claims and deletes the registration they use.

contract tests:
${contractTests.map((t) => `  [${t.tag}] ${t.name}`).join('\n')}

options:
  --env <name>         the environment (${Object.keys(environments).join(', ')})
  --contract <which>   j0: also run the contract tests, all (mock only) or prod-safe
  --tag <tag>          contract: run only the tests of one tag
  --alert              post one IRM alert per failed result (needs IRM_E2E_WEBHOOK_URL)
  --force-fail         add a result that fails on purpose, to prove the alert path
  --results <dir>      where result files go (default: results)

On production, J0 signs in as ${TEST_USER} with E2E_USER_PASSWORD.`

/** A mistake in the command line: printed with the usage, exit 2. */
class UsageError extends Error {}

type Values = { env?: string; contract?: string; tag?: string; alert: boolean; 'force-fail': boolean; results: string; help: boolean }

/**
 * `pnpm j0` and `pnpm contract`. Writes `results/j0.json` and
 * `results/agent-contract.json`, prints the run, appends the job summary and,
 * with `--alert`, alerts on failures. Returns the exit code: 0 when every
 * result passed, 1 when one failed, 2 on a usage error.
 */
export async function main(
  suite: 'j0' | 'contract',
  argv: string[],
  { lookup = environment }: { lookup?: (name: string) => Environment } = {},
): Promise<number> {
  let values: Values
  let env: Environment
  let tag: Tag | undefined
  const password = process.env.E2E_USER_PASSWORD ?? ''
  try {
    const parsed = parseArgs({
      args: argv,
      options: {
        env: { type: 'string' },
        contract: { type: 'string' },
        tag: { type: 'string' },
        alert: { type: 'boolean', default: false },
        'force-fail': { type: 'boolean', default: false },
        results: { type: 'string', default: 'results' },
        help: { type: 'boolean', short: 'h', default: false },
      },
    })
    values = parsed.values
    if (values.help) {
      console.log(usage)
      return 0
    }
    if (!values.env) throw new UsageError('name the environment: --env mock')
    try {
      env = lookup(values.env)
    } catch (error) {
      throw new UsageError((error as Error).message)
    }
    const onMock = env.name === 'mock'

    if (suite === 'j0') {
      if (values.tag !== undefined) throw new UsageError('--tag is for pnpm contract; pnpm j0 takes --contract all|prod-safe')
      if (values.contract !== undefined && values.contract !== 'all' && values.contract !== 'prod-safe') {
        throw new UsageError(`--contract is all or prod-safe, not "${values.contract}"`)
      }
      if (values.contract === 'all' && !onMock) throw new UsageError("the mock-only tests need the mock's error states: --contract prod-safe off the mock")
      if (values.contract === 'prod-safe') tag = 'prod-safe'
      // A registration nobody can claim would stay behind for 7 days.
      if (!onMock && !password) throw new UsageError(`J0 claims as ${TEST_USER} off the mock: set E2E_USER_PASSWORD`)
    } else {
      if (values.contract !== undefined) throw new UsageError('--contract is for pnpm j0; pnpm contract takes --tag')
      if (values.tag !== undefined && values.tag !== 'prod-safe' && values.tag !== 'mock-only') {
        throw new UsageError(`--tag is prod-safe or mock-only, not "${values.tag}"`)
      }
      tag = values.tag as Tag | undefined
      if (!onMock) {
        throw new UsageError(
          `the contract runs against ${env.name} only inside J0, which claims and deletes the registration it uses: pnpm j0 --env ${env.name} --contract prod-safe`,
        )
      }
    }
  } catch (error) {
    console.error(`${(error as Error).message}\n\n${usage}`)
    return 2
  }

  const secrets = new Secrets()
  secrets.add('password', password)
  const journey = suite === 'j0' ? new Run('j0', env.name) : undefined
  const contract = suite === 'contract' || values.contract !== undefined ? new Run('agent-contract', env.name) : undefined

  const runContractOn = async (registration: () => Promise<Registration>) => {
    if (!contract) return
    try {
      await runContract(contract, { env, secrets, registration }, tag)
    } catch (error) {
      await contract.step('run', () => {
        throw error
      })
    }
  }

  if (journey) {
    try {
      await j0({
        env,
        run: journey,
        secrets,
        user: env.name === 'mock' ? 'e2e-j0@mock' : TEST_USER,
        password: password || 'mock',
        between: (registration) => runContractOn(async () => registration),
      })
    } catch (error) {
      await journey.step('run', () => {
        throw error
      })
    }
  } else {
    // pnpm contract on the mock: the run's own registration, made on first use.
    let made: Promise<Registration> | undefined
    await runContractOn(() => (made ??= registerWithPort(env, secrets, 'e2e-contract')))
  }

  // The plan's grep, done by the run itself: no credential this run held may
  // appear in a result (which is also what the log prints) or in the mock's
  // call log. Then every detail is scrubbed anyway, before it is written.
  const holder = journey ?? contract!
  await holder.step('no credential in a result or the call log', async () => {
    const texts: [string, string][] = [journey, contract].flatMap((r) => (r ? [[`the ${r.name} result`, JSON.stringify(r.finish())] as [string, string]] : []))
    if (env.name === 'mock') texts.push(["the mock's call log", JSON.stringify(await mockCalls(env))])
    const leaks = texts.flatMap(([where, text]) => secrets.find(text).map((kind) => `${where} carries the ${kind}`))
    if (leaks.length) throw new Error(leaks.join('\n'))
    return `${secrets.size} credentials, none in ${texts.map(([where]) => where).join(', ')}`
  })

  const results: Result[] = [contract, journey].flatMap((r) => (r ? [r.finish()] : [])).map((r) => ({
    ...r,
    steps: r.steps.map((s) => ({ ...s, name: secrets.scrub(s.name), detail: secrets.scrub(s.detail) })),
  }))

  if (values['force-fail']) {
    const run = new Run('force-fail', env.name)
    await run.step('fail on purpose', () => {
      throw new Error('force_fail was set: this run fails on purpose to prove the alert path')
    })
    results.push(run.finish())
  }

  for (const result of results) await writeResult(result, values.results)
  console.log(formatText(results))
  await writeJobSummary(results, `Agent ${suite === 'j0' ? 'J0' : 'contract'} against ${env.name}`)
  if (values.alert) await alertFailures(results)

  return results.every((r) => r.ok) ? 0 : 1
}
