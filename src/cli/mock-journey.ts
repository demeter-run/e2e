import { parseArgs } from 'node:util'
import { Secrets } from '../agent/client.ts'
import { j3 } from '../agent/j3.ts'
import { j9 } from '../agent/j9.ts'
import { type Environment, environment, environments } from '../env.ts'
import { mockCalls } from '../mock/control.ts'
import { formatText, Run, writeJobSummary, writeResult } from '../report.ts'

/** The journeys that run on the mock alone, and what each covers. */
const journeys = {
  j3: { run: j3, title: 'J3, expiry', about: 'a project expires unclaimed after 7 days on the mock clock, takes its ports with it, and the agent starts over' },
  j9: { run: j9, title: 'J9, abuse', about: 'the per-IP, per-project and global caps, and the kill switch, which stops registration only' },
}

export type MockJourney = keyof typeof journeys

const usage = (name: MockJourney) => `usage: pnpm ${name} --env mock [options]

pnpm ${name} runs ${journeys[name].title}, on the agent-route mock only: ${journeys[name].about}.
It resets the mock first, and moves the mock's clock and switches as it goes.

options:
  --env <name>         the environment: mock (known: ${Object.keys(environments).join(', ')})
  --results <dir>      where result files go (default: results)`

/**
 * `pnpm j3` and `pnpm j9`. Writes `results/<name>.json`, prints the run and
 * appends the job summary. Returns the exit code: 0 when the run passed, 1
 * when a step failed, 2 on a usage error.
 */
export async function main(name: MockJourney, argv: string[], { lookup = environment }: { lookup?: (name: string) => Environment } = {}): Promise<number> {
  let values: { env?: string; results: string; help: boolean }
  let env: Environment
  try {
    values = parseArgs({
      args: argv,
      options: {
        env: { type: 'string' },
        results: { type: 'string', default: 'results' },
        help: { type: 'boolean', short: 'h', default: false },
      },
    }).values
    if (values.help) {
      console.log(usage(name))
      return 0
    }
    if (!values.env) throw new Error('name the environment: --env mock')
    env = lookup(values.env)
    // Production's expiry takes 7 days, and its caps and kill switch are shared state.
    if (env.name !== 'mock') throw new Error(`${journeys[name].title} runs on the mock only, which it resets and whose clock and caps it moves: --env mock`)
  } catch (error) {
    console.error(`${(error as Error).message}\n\n${usage(name)}`)
    return 2
  }

  const secrets = new Secrets()
  const run = new Run(name, env.name)
  try {
    await journeys[name].run({ env, run, secrets })
  } catch (error) {
    await run.step('run', () => {
      throw error
    })
  }

  // The plan's grep, done by the run itself, as J0's is: no credential this
  // run held may appear in its result or in the mock's call log.
  await run.step('no credential in the result or the call log', async () => {
    const texts: [string, string][] = [
      ['the result', JSON.stringify(run.finish())],
      ["the mock's call log", JSON.stringify(await mockCalls(env))],
    ]
    const leaks = texts.flatMap(([where, text]) => secrets.find(text).map((kind) => `${where} carries the ${kind}`))
    if (leaks.length) throw new Error(leaks.join('\n'))
    return `${secrets.size} credentials, none in ${texts.map(([where]) => where).join(' or ')}`
  })

  const finished = run.finish()
  const result = { ...finished, steps: finished.steps.map((s) => ({ ...s, name: secrets.scrub(s.name), detail: secrets.scrub(s.detail) })) }
  await writeResult(result, values.results)
  console.log(formatText([result]))
  await writeJobSummary([result], `Agent ${journeys[name].title} against ${env.name}`)
  return result.ok ? 0 : 1
}
