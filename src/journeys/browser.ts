import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { safeUrl } from '../http.ts'
import { Failure } from '../report.ts'

/**
 * What the journeys share for driving a browser: waits that fail saying what
 * was missing and where, and the masked screenshot a failed step leaves.
 *
 * Playwright's traces stay off (`playwright.config.ts`). A trace records the
 * values typed into a form, the cookies sent with every request and every
 * response body, and none of that can be masked: the test user's password,
 * the Console's session (a signed Auth0 access token) and the port's key
 * (in the Console's loader data) would all land in an artifact of a public
 * repository. A failed step leaves a screenshot instead, with the secrets
 * masked, and its detail says where the browser was.
 */

/** An error as a step reports it: its first line, without terminal colours. Playwright's call log, which quotes element text, stays out. */
export function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split('\n')[0]!.replace(/\x1b\[[0-9;]*m/g, '').trim()
}

/** Where the browser is, for a message: the page's origin and path and its title. */
export async function where(page: Page): Promise<string> {
  const title = await page.title().catch(() => '')
  return `${safeUrl(page.url())}${title ? ` ("${title}")` : ''}`
}

/**
 * The first visible element `locator` matches, once there is one, failing with
 * `what` was missing, where, and after how long. Hidden matches (a link the
 * layout shows only at another width) are passed over.
 */
export async function visible(page: Page, locator: Locator, what: string, timeoutMs = 30_000): Promise<Locator> {
  const shown = locator.filter({ visible: true }).first()
  try {
    await shown.waitFor({ state: 'visible', timeout: timeoutMs })
  } catch {
    throw new Failure(`no ${what} on ${await where(page)} after ${timeoutMs / 1000} s`)
  }
  return shown
}

/** Waits for the page's URL to satisfy `test`, failing with `what` was expected and where the browser is instead. */
export async function arrives(page: Page, test: (url: URL) => boolean, what: string, timeoutMs = 60_000): Promise<URL> {
  try {
    await page.waitForURL(test, { timeout: timeoutMs, waitUntil: 'commit' })
  } catch {
    throw new Failure(`did not reach ${what} within ${timeoutMs / 1000} s; the browser is on ${await where(page)}`)
  }
  return new URL(page.url())
}

/**
 * A screenshot of `page` for a failed step, with every element in `masks`
 * painted over, saved as `<dir>/<name>.png`. Returns the path, or why there is
 * none: a screenshot that fails must not fail the step a second time.
 */
export async function maskedScreenshot(page: Page, dir: string, name: string, masks: Locator[]): Promise<string> {
  const path = join(dir, `${name}.png`)
  try {
    await mkdir(dir, { recursive: true })
    await page.screenshot({ path, mask: masks, maskColor: '#ff00ff', timeout: 15_000 })
    return path
  } catch (error) {
    return `no screenshot: ${firstLine(error)}`
  }
}
