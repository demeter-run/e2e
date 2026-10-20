import type { Locator, Page, TestInfo } from '@playwright/test'
import { specEnv } from '../cli/journeys.ts'
import { type Environment, environment } from '../env.ts'
import { Failure, formatText, type Result, type Run, writeResult } from '../report.ts'
import { firstLine, maskedScreenshot } from './browser.ts'

/**
 * What a journey spec shares: the environment and results directory `pnpm
 * journey` starts it with, and the verdict.
 *
 * A spec's tests record their steps through `Run` and do not throw: their
 * result files are the verdict. Playwright replaces its worker, and the
 * signed-in browser in it, after any failed test, which would cost the later
 * tests the session the journey shares (and run `afterAll`'s clean-up early).
 * So a spec reports each result here and calls `verdict` last, in `afterAll`,
 * which fails the Playwright run once, naming the results that failed.
 */

export function journeyEnvironment(): Environment {
  const name = process.env[specEnv.env]
  if (!name) throw new Error(`${specEnv.env} is not set: run a journey with pnpm journey <name> --env <environment>`)
  return environment(name)
}

export const resultsDir = (): string => process.env[specEnv.results] || 'results'

/** Fails a step that could not run because an earlier one failed: it says why, and leaves no screenshot. */
export class NotRun extends Failure {
  constructor(why: string) {
    super(`not run: ${why}`)
  }
}

/**
 * A step runner for `run` that drives the browser `page()` returns. A step
 * fails with its `Failure` message whole, and with only the first line of any
 * other error: a Playwright error's call log quotes the elements it met. A
 * failed step leaves a screenshot of the page with `masks` painted over, named
 * in its detail: `<shots>-01.png` for the runner's first step, and on.
 */
export function browserSteps(run: Run, page: () => Page | undefined, masks: (page: Page) => Locator[], shots = run.name) {
  let n = 0
  return (name: string, fn: () => string | void | Promise<string | void>): Promise<boolean> => {
    const shot = `${shots}-${String((n += 1)).padStart(2, '0')}`
    return run.step(name, async () => {
      try {
        return await fn()
      } catch (error) {
        if (error instanceof NotRun) throw error
        const message = error instanceof Failure ? error.message : firstLine(error)
        const current = page()
        throw new Failure(current ? `${message}\nscreenshot: ${await maskedScreenshot(current, resultsDir(), shot, masks(current))}` : message)
      }
    })
  }
}

/**
 * Records on `run` how Playwright ended the test that ran it, when the test
 * did not pass: a test that timed out, or threw outside its steps, leaves a
 * failed step saying so. Call it from `afterEach`, which Playwright runs after
 * a timeout too, in the same worker.
 */
export async function ended(run: Run, testInfo: Pick<TestInfo, 'status' | 'expectedStatus' | 'timeout' | 'error'>): Promise<void> {
  if (testInfo.status === testInfo.expectedStatus) return
  const how =
    testInfo.status === 'timedOut'
      ? `timed out after ${Math.round(testInfo.timeout / 1000)} s`
      : `${testInfo.status ?? 'ended'}${testInfo.error ? `: ${firstLine(testInfo.error.message ?? '')}` : ''}`
  await run.step('the test ran to its end', () => {
    throw new Failure(`Playwright ended the test: it ${how}`)
  })
}

/** `fn`'s result, or a `Failure` naming `what` once `ms` pass first. `fn` is left running; the caller moves on. */
export async function within<T>(ms: number, what: string, fn: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Failure(`${what} did not finish within ${Math.round(ms / 1000)} s`)), ms)
  })
  try {
    return await Promise.race([fn(), late])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Calls `read` every `everyMs` until it returns a value or `timeoutMs` passes.
 * A read that fails is retried; the error of the last read, when it failed,
 * comes back beside the null value, so the caller's deadline message still
 * says what it waited for.
 */
export async function poll(
  timeoutMs: number,
  everyMs: number,
  read: () => Promise<string | null>,
): Promise<{ value: string | null; seconds: number; error?: string }> {
  const t0 = performance.now()
  const seconds = () => Math.round((performance.now() - t0) / 1000)
  let error: string | undefined
  while (performance.now() - t0 < timeoutMs) {
    try {
      const value = await read()
      if (value) return { value, seconds: seconds() }
      error = undefined
    } catch (thrown) {
      error = thrown instanceof Failure ? thrown.message : firstLine(thrown)
    }
    await new Promise((resolve) => setTimeout(resolve, everyMs))
  }
  return { value: null, seconds: seconds(), ...(error === undefined ? {} : { error }) }
}

const reported: Result[] = []

/** Finishes `run`, writes its result file and prints it, and keeps it for the verdict. */
export async function report(run: Run): Promise<Result> {
  const result = run.finish()
  await writeResult(result, resultsDir())
  reported.push(result)
  console.log(formatText([result]))
  return result
}

/** Fails the Playwright run if any reported result failed. */
export function verdict(): void {
  const failed = reported.filter((r) => !r.ok)
  if (failed.length === 0) return
  const named = failed.map((r) => `${r.name} (${r.steps.filter((s) => !s.ok).map((s) => s.name).join('; ')})`)
  throw new Error(`failed: ${named.join(', ')}`)
}
