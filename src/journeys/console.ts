import type { BrowserContext, ConsoleMessage, Locator, Page, Request, Response } from '@playwright/test'
import type { Environment } from '../env.ts'
import { safeUrl } from '../http.ts'
import { Failure } from '../report.ts'
import { arrives, firstLine, visible, where } from './browser.ts'

/**
 * The Console as a signed-in person meets it, read from webui's routes on
 * 2026-10-19. It carries no `data-testid`, so the journeys find things by their
 * visible text and roles.
 *
 * - Signing in ends on `/`, whose loader sends a user to their first project's
 *   ports page, creating "My First Project" for a user with none
 *   (`routes/_index.tsx`).
 * - The session is the cookie `_session-v2` on the `demeter.run` zone
 *   (`src/app/session.ts`).
 */

/** The Console's session cookie (`src/app/session.ts`); the legacy app names its own the same. */
export const sessionCookie = '_session-v2'

/** The project namespace a Console URL is on, or null. */
export function projectOf(url: URL): string | null {
  const match = /^\/([^/]+)\/(?:ports|settings|billing|resources)(?:\/|$)/.exec(url.pathname)
  return match ? match[1]! : null
}

/**
 * Waits for the browser to land on a project's ports page with the Console's
 * app started on it (`started`), and returns that project's namespace.
 */
export async function landOnPorts(page: Page, env: Environment, timeoutMs = 60_000): Promise<string> {
  const url = await arrives(
    page,
    (u) => u.origin === env.console && /^\/[^/]+\/ports$/.test(u.pathname),
    `a project's ports page on ${env.console}`,
    timeoutMs,
  )
  await started(page, timeoutMs)
  return projectOf(url)!
}

/**
 * Waits for the Console's app to start on the page: React has hydrated the
 * server-rendered page and Remix's router runs it. Until then a button does
 * nothing and a link is a plain anchor, whose click loads its target as a
 * page instead of navigating within the app.
 *
 * Remix creates its router as hydration begins, before React commits it.
 * Sign-in proof run 39412617330 clicked sign-out about 0.3 s after the router
 * appeared, and the page showed the Console's error page on the same URL
 * without navigating; so this also waits for the commit. The
 * `<ScrollRestoration>` in the Console's root layout sets
 * `history.scrollRestoration` to "manual" in an effect, which runs only once
 * React has committed the hydrated page.
 */
export async function started(page: Page, timeoutMs = 30_000): Promise<void> {
  try {
    await page.waitForFunction(
      () =>
        (window as { __remixRouter?: { state: { initialized: boolean } } }).__remixRouter?.state.initialized === true &&
        history.scrollRestoration === 'manual',
      undefined,
      { timeout: timeoutMs },
    )
  } catch {
    throw new Failure(`the Console's app did not start on ${await where(page)} within ${timeoutMs / 1000} s`)
  }
}

/**
 * Deletes every project the signed-in user owns, starting with `first`, and
 * returns their namespaces in the order deleted.
 *
 * It posts the form behind the "DELETE" button of the Console's project
 * settings (`routes/$projectNamespace.settings.tsx`, intent `DELETE_PROJECT`),
 * as the browser does, and reads the redirect the Console answers with rather
 * than following it: to the next project's ports page while one remains, and
 * to `/` after the last. Following that last redirect would run `/`'s loader,
 * which creates "My First Project" for a user with none, and leave a project
 * behind.
 */
export async function deleteProjects(context: Pick<BrowserContext, 'request'>, env: Pick<Environment, 'console'>, first: string): Promise<string[]> {
  const deleted: string[] = []
  let next: string | null = first
  while (next !== null) {
    const namespace: string = next
    // A Console that keeps naming a deleted project would loop forever.
    if (deleted.includes(namespace)) throw new Failure(`the Console still names ${namespace} after deleting it (deleted so far: ${deleted.join(', ')})`)
    const response = await context.request.post(`${env.console}/${namespace}/settings`, {
      form: { intent: 'DELETE_PROJECT' },
      maxRedirects: 0,
      timeout: 60_000,
    })
    const status = response.status()
    const location = response.headers().location
    if (status < 300 || status > 399 || !location) {
      throw new Failure(`deleting ${namespace}: the Console answered ${status}${location ? ` → ${safeUrl(new URL(location, env.console).toString())}` : ''}, wanted a redirect`)
    }
    deleted.push(namespace)
    const target = new URL(location, env.console)
    if (target.pathname === '/') next = null
    else if (target.pathname.endsWith('/ports') && projectOf(target)) next = projectOf(target)
    else if (target.pathname.startsWith('/login')) throw new Failure(`deleting ${namespace}: the Console sent the browser to sign in, so the session was lost`)
    else throw new Failure(`deleting ${namespace}: the Console redirected to ${safeUrl(target.toString())}, which names no next project`)
  }
  return deleted
}

/** The browser's cookies named `name`, as `name@domain`, without their values. */
export async function cookiesNamed(context: BrowserContext, name: string): Promise<string[]> {
  return (await context.cookies()).filter((c) => c.name === name).map((c) => `${c.name}@${c.domain}${c.path === '/' ? '' : c.path}`)
}

/**
 * Signs out as a person does, with the sidebar's sign-out link on the Console
 * page the browser is on (`<Link to="/logout">`, `components/Sidebar.tsx`),
 * and checks that Auth0 ended its session and sent the browser back, and that
 * the Console's cookie is gone.
 *
 * The link is the only way through. `/logout` clears the Console's session and
 * redirects to `/logout/auth0`, which redirects to Auth0's `/v2/logout`
 * (`routes/logout.tsx`, `routes/logout.auth0.tsx`). But the second route
 * nests under the first, so loading `/logout/auth0` as a page runs both
 * loaders and the server answers the parent's redirect, to `/logout/auth0`
 * again, until the browser gives up with ERR_TOO_MANY_REDIRECTS (seen
 * 2026-10-20). The link navigates within the page instead, where Remix's
 * router follows the deepest route's redirect, to Auth0, but only once the
 * app has started: clicked before, it loads `/logout` as a page too.
 *
 * A click that goes nowhere, as two of eleven did on 2026-10-20 (runs
 * 39412617330 and 39414035093, the second with the app started and nothing
 * logged), is clicked once more, as a person would. The step's detail says
 * so, with what the first click left behind.
 */
export async function signOut(page: Page, env: Environment, timeoutMs = 30_000): Promise<string> {
  const missed: string[] = []
  let request: Request | null = null
  for (let click = 1; click <= 2 && !request; click += 1) {
    const link = await visible(page, page.locator('a[href="/logout"]'), 'sign-out link in the sidebar', timeoutMs)
    await started(page, timeoutMs)
    const attempt = await clickToSignOut(page, env, link, timeoutMs / 2)
    if ('request' in attempt) request = attempt.request
    else {
      missed.push(`click ${click}: ${attempt.missed}`)
      // A page load that failed, as the loop does, leaves no link to click.
      if (attempt.pageLoadFailed) break
    }
  }
  if (!request) throw new Failure(`the sign-out link sent the browser to no ${env.auth0}/v2/logout; ${missed.join('; ')}`)
  // A request whose answer never comes resolves to no response, not never.
  const answer = await Promise.race([request.response(), new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs))])
  const location = answer?.headers().location
  if (!answer || answer.status() < 300 || answer.status() > 399 || !location) {
    throw new Failure(`Auth0's /v2/logout answered ${answer?.status() ?? 'nothing'}, wanted a redirect out of the tenant`)
  }
  // The page it signed out from can share the origin Auth0 sends it back to,
  // so the wait is for the path too.
  const back = new URL(location, env.auth0)
  await arrives(page, (u) => u.origin === back.origin && u.pathname === back.pathname, `${safeUrl(back.toString())}, where Auth0 sends a signed-out browser`, timeoutMs)
  const left = (await page.context().cookies(env.console)).filter((c) => c.name === sessionCookie)
  if (left.length) throw new Failure(`the browser still sends ${sessionCookie} to ${env.console} after signing out (now on ${await where(page)})`)
  const again = missed.length ? ` on the second click (${missed.join('; ')})` : ''
  return `signed out through Auth0's /v2/logout${again}, now on ${safeUrl(page.url())}`
}

/**
 * Clicks the sign-out link and waits up to `waitMs` for the browser to request
 * Auth0's `/v2/logout`. When it does not, says what happened instead: a page
 * load that failed (Chromium's error page has a URL that says nothing), or
 * where the browser stayed, the router's state, the requests the click made
 * to the Console and Auth0, and the errors the page logged.
 */
async function clickToSignOut(
  page: Page,
  env: Environment,
  link: Locator,
  waitMs: number,
): Promise<{ request: Request } | { missed: string; pageLoadFailed: boolean }> {
  let failed = ''
  const logged = new Set<string>()
  const requests = new Map<Request, string>()
  const ours = (r: Request) => r.url().startsWith(env.console) || r.url().startsWith(env.auth0)
  const label = (r: Request) => `${r.method()} ${safeUrl(r.url(), ['_data'])}`
  const onRequest = (r: Request) => {
    if (ours(r)) requests.set(r, `${label(r)} (no answer)`)
  }
  const onResponse = (response: Response) => {
    if (requests.has(response.request())) requests.set(response.request(), `${label(response.request())} ${response.status()}`)
  }
  const onFailed = (r: Request) => {
    if (r.isNavigationRequest()) failed = `loading ${safeUrl(r.url())} failed with ${r.failure()?.errorText ?? 'an error'}`
    if (requests.has(r)) requests.set(r, `${label(r)} ${r.failure()?.errorText ?? 'failed'}`)
  }
  const onConsole = (m: ConsoleMessage) => {
    if (m.type() === 'error') logged.add(firstLine(m.text()).slice(0, 200))
  }
  const onPageError = (e: Error) => logged.add(`uncaught ${firstLine(e)}`.slice(0, 200))
  page.on('request', onRequest)
  page.on('response', onResponse)
  page.on('requestfailed', onFailed)
  page.on('console', onConsole)
  page.on('pageerror', onPageError)
  let request: Request | null
  try {
    // Caught here so that a click that fails leaves no rejection unhandled.
    const sent = page.waitForRequest((r) => r.isNavigationRequest() && r.url().startsWith(`${env.auth0}/v2/logout`), { timeout: waitMs }).catch(() => null)
    // A click waits for a navigation that starts as it returns to commit,
    // which an Auth0 that never answers never does: `sent` waits instead,
    // within its limit.
    await link.click({ noWaitAfter: true })
    request = await sent
  } finally {
    page.off('request', onRequest)
    page.off('response', onResponse)
    page.off('requestfailed', onFailed)
    page.off('console', onConsole)
    page.off('pageerror', onPageError)
  }
  if (request) return { request }
  if (failed) return { missed: failed, pageLoadFailed: true }
  const router = await page
    .evaluate(() => {
      const state = (window as { __remixRouter?: { state: { navigation: { state: string; location?: { pathname: string } } } } }).__remixRouter?.state
      return state ? `${state.navigation.state}${state.navigation.location ? ` to ${state.navigation.location.pathname}` : ''}` : 'gone'
    })
    .catch(() => 'unreadable')
  const made = [...requests.values()]
  const errors = [...logged].slice(0, 3)
  return {
    missed: [
      `nothing within ${waitMs / 1000} s, still on ${await where(page)}`,
      `the router ${router}`,
      made.length ? `the click requested ${made.join(', ')}` : 'the click requested nothing from the Console or Auth0',
      errors.length ? `the page logged ${errors.map((e) => `"${e}"`).join(', ')}` : 'the page logged no error',
    ].join(', '),
    pageLoadFailed: false,
  }
}

/** A port as the Console shows it on its detail page. The key is the caller's to keep secret. */
export interface ConsolePort {
  /** The resource id in the Console's URLs. */
  id: string
  /** The resource's name, which the billing page lists it by. */
  name: string
  network: string
  /** The "Endpoint URL" row: the key travels in the `dmtr-api-key` header. */
  endpoint: string
  /** The "Auth Token" row. */
  key: string
}

/** The section of a resource's detail page under `heading` ("About", "Instance info"). */
export const detailSection = (page: Page, heading: string) => page.getByRole('heading', { name: heading, exact: true }).locator('xpath=..')

/**
 * A port's key as fabric writes it: bech32m with the port kind's prefix
 * (`blockfrost1…` for a `BlockfrostPort`; `encode_key` in fabric's
 * `src/domain/resource/command.rs`), and the legacy `dmtr_` keys.
 */
export const keyShape = /[a-z_]+1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{19,}/

/**
 * The rows of a port's detail page that write its key: the "Auth Token", and
 * the "Authenticated Endpoint URL" built on it (fabric's
 * `bootstrap/rpc/crds/blockfrostport.hbs`).
 */
export const keyRows = ['Auth Token', 'Authenticated Endpoint URL']

/**
 * What a screenshot of a Console page paints over so that no port's key
 * shows. The detail page writes the key in each of `keyRows`, both under
 * "Instance info". Each mask is found on its own, so that the key stays
 * covered while any two of the section's heading, the rows' labels and the
 * key's shape drift: any text of the key's shape, each key row's value
 * wherever it is, the "Instance info" section, and the `key` itself once it
 * is known.
 */
export function keyMasks(page: Page, key?: string): Locator[] {
  return [
    page.getByText(keyShape),
    ...keyRows.map((label) => page.getByText(label, { exact: true }).locator('xpath=../following-sibling::*[1]')),
    detailSection(page, 'Instance info'),
    ...(key ? [page.getByText(key)] : []),
  ]
}

/**
 * One row's value on a resource's detail page (`ServiceInformation.tsx`): each
 * label sits in a cell of its own, and its value in the next cell.
 */
async function detailValue(page: Page, section: string, label: string): Promise<string> {
  const cell = detailSection(page, section).getByText(label, { exact: true }).locator('xpath=../following-sibling::*[1]')
  await visible(page, cell, `"${label}" row under "${section}"`)
  return (await cell.first().innerText()).trim()
}

/**
 * Deploys a port from the ports page: "ADD PRODUCTS", then the form's two
 * selects ("Select port", "Select type", Headless UI listboxes in that order)
 * and "DEPLOY", then the success toast (`components/ports/CreatePort.tsx`).
 */
export async function deployPort(page: Page, port: string, type: string): Promise<void> {
  await (await visible(page, page.getByRole('button', { name: 'ADD PRODUCTS', exact: true }), '"ADD PRODUCTS" button')).click()
  const form = page.locator('form').filter({ has: page.getByRole('button', { name: 'DEPLOY', exact: true }) })
  await visible(page, form, 'port form with a "DEPLOY" button')
  const selects = form.locator('button[aria-haspopup="listbox"]')
  for (const [n, label, option] of [[0, 'Select port', port], [1, 'Select type', type]] as const) {
    await (await visible(page, selects.nth(n), `"${label}" select`)).click()
    await (await visible(page, page.getByRole('option', { name: option, exact: true }), `"${option}" option under "${label}"`)).click()
  }
  await form.getByRole('button', { name: 'DEPLOY', exact: true }).click()
  await visible(page, page.getByText(`${port} port deployed successfully`), `"${port} port deployed successfully" toast`, 60_000)
}

/**
 * Opens the port's detail page from the ports page ("View details") and reads
 * it. The port's card wraps its header, the link included, in an `aria-hidden`
 * element (`components/ports/ResourceCard.tsx`), so the link is found among
 * hidden roles too.
 */
export async function openPort(page: Page, env: Environment): Promise<ConsolePort> {
  await (await visible(page, page.getByRole('link', { name: 'View details', exact: true, includeHidden: true }), '"View details" link on the port')).click()
  const url = await arrives(page, (u) => u.origin === env.console && /^\/[^/]+\/resources\/[^/]+\/detail$/.test(u.pathname), "the port's detail page")
  return {
    id: url.pathname.split('/')[3]!,
    name: await detailValue(page, 'About', 'Name'),
    network: await detailValue(page, 'About', 'Network'),
    endpoint: await detailValue(page, 'Instance info', 'Endpoint URL'),
    key: await detailValue(page, 'Instance info', 'Auth Token'),
  }
}

/**
 * The count on the port's usage view (`$projectNamespace.resources.$resourceId.usage.tsx`):
 * the "Daily requests" card, today's requests from Prometheus.
 */
export async function dailyRequests(page: Page, env: Environment, namespace: string, port: ConsolePort): Promise<number> {
  await page.goto(`${env.console}/${namespace}/resources/${port.id}/usage`, { waitUntil: 'load', timeout: 60_000 })
  const count = page.getByText(/^daily requests$/i).locator('xpath=following-sibling::p[1]/span[1]')
  const text = (await (await visible(page, count, '"Daily requests" count on the usage view')).innerText()).trim()
  const value = Number(text.replaceAll(',', ''))
  if (!Number.isInteger(value)) throw new Failure(`the "Daily requests" count reads "${text}", not a number`)
  return value
}

/** A port's row in the billing page's "Project Usage" card, from fabric's usage report. */
export interface BillingRow {
  /** Product, id, tier, usage and cost, as the card shows them. */
  cells: string[]
  /** The "Usage" cell: the units fabric has counted for the port this billing period. */
  units: number
}

/**
 * The port's row in the billing page's "Project Usage" card
 * (`components/billing/ProjectUsage/ProjectUsage.tsx`), or null while fabric
 * has not reported it.
 */
export async function billingRow(page: Page, env: Environment, namespace: string, port: ConsolePort): Promise<BillingRow | null> {
  await page.goto(`${env.console}/${namespace}/billing`, { waitUntil: 'load', timeout: 60_000 })
  await visible(page, page.getByText('Project Usage', { exact: true }), '"Project Usage" card on the billing page')
  // The card's rows are six-column grids: product, id, tiers, usage and cost.
  const row = page.locator('div.grid-cols-6').filter({ has: page.getByText(port.name, { exact: true }) })
  if ((await row.count()) === 0) return null
  const cells = (await row.first().innerText()).split('\n').map((c) => c.trim()).filter(Boolean)
  const units = Number(cells[3]?.replaceAll(',', ''))
  if (cells.length !== 5 || !Number.isFinite(units)) {
    throw new Failure(`the "Project Usage" row for ${port.name} reads "${cells.join(' · ')}", not product, id, tier, usage and cost`)
  }
  return { cells, units }
}

/** The visible text of each cell of the port's pricing grid, in order. */
export async function pricingCells(page: Page, env: Environment, namespace: string, port: ConsolePort): Promise<string[]> {
  await page.goto(`${env.console}/${namespace}/resources/${port.id}/pricing`, { waitUntil: 'load', timeout: 60_000 })
  const heading = await visible(page, page.getByRole('heading', { name: 'Pricing Tiers', exact: true }), '"Pricing Tiers" grid')
  // The heading's cell is the grid's first child.
  return heading.locator('xpath=../..').locator(':scope > *').allInnerTexts()
}
