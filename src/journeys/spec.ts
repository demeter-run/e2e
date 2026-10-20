import type { Locator, Page } from '@playwright/test'
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

/**
 * A step runner for `run` that drives `page`. A step fails with its `Failure`
 * message whole, and with only the first line of any other error: a
 * Playwright error's call log quotes the elements it met. A failed step leaves
 * a screenshot of the page with `masks` painted over, named in its detail.
 */
export function browserSteps(run: Run, page: Page, masks: (page: Page) => Locator[]) {
  let n = 0
  return (name: string, fn: () => string | void | Promise<string | void>): Promise<boolean> => {
    const shot = `${run.name}-${String((n += 1)).padStart(2, '0')}`
    return run.step(name, async () => {
      try {
        return await fn()
      } catch (error) {
        const message = error instanceof Failure ? error.message : firstLine(error)
        throw new Failure(`${message}\nscreenshot: ${await maskedScreenshot(page, resultsDir(), shot, masks(page))}`)
      }
    })
  }
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
