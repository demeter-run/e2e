import { type BrowserContext, type Page, test } from '@playwright/test'
import { auth0Screens, signupText } from '../src/checks/intent.ts'
import { safeUrl } from '../src/http.ts'
import { signIn, type TestUser, testUser } from '../src/journeys/auth0.ts'
import {
  billingRow,
  type BillingRow,
  type ConsolePort,
  cookiesNamed,
  dailyRequests,
  deleteProjects,
  deployPort,
  detailSection,
  landOnPorts,
  openPort,
  pricingCells,
  sessionCookie,
  signOut,
} from '../src/journeys/console.ts'
import { arrives, visible } from '../src/journeys/browser.ts'
import { burst, describePortAnswer, describeTally, portGet, tally, untilSuccess } from '../src/journeys/port.ts'
import { browserSteps, journeyEnvironment, NotRun, report, verdict } from '../src/journeys/spec.ts'
import { Failure, Run } from '../src/report.ts'
import { keepSecret } from '../src/secrets.ts'
import { type Card, compare, formatUsd } from '../src/surfaces/card.ts'
import { consoleCards, readConsolePricing } from '../src/surfaces/console.ts'
import { fabricCards, fabricTiers, fetchMetadata } from '../src/surfaces/fabric.ts'
import { tierName } from '../src/surfaces/ports.ts'
import { readPricingTable } from '../src/surfaces/website2.ts'

/**
 * J2: a person's journey against production, from landing on demeter.run to a
 * first successful request, then its usage and cost in the Console
 * (developer-journey-e2e-tests umbrella, scope 2). The standing test user
 * signs in where a person would sign up (decision 0047), so the elapsed time
 * is a lower bound: it leaves out filling the signup form.
 *
 * One test of named steps, then three edge cases on the same signed-in
 * session. Every test records its steps in a result (`results/j2*.json`) and
 * does not throw; the clean-up and the verdict run last, in `afterAll`
 * (`src/journeys/spec.ts` says why).
 *
 * The port's key stays in memory: it is kept secret (`src/secrets.ts`), sent
 * only in a header, and painted over in every screenshot, with the password
 * field.
 */

const env = journeyEnvironment()
/** The test user, read when a step first signs in: listing the tests needs no password. */
let credentials: TestUser | undefined
const user = (): TestUser => (credentials ??= testUser(env))

/** The port J2 deploys: Blockfrost on preprod, Free, the cheapest a person can try. */
const portKind = 'Blockfrost'
const portType = 'cardano-preprod'
/** A request a developer's first call could be, as `GET <endpoint>/epochs/latest`. */
const firstCall = '/epochs/latest'

/** The browser the journey and the edge cases share, signed in once J2 has signed in. */
let context: BrowserContext | undefined
let page: Page | undefined
let namespace: string | undefined
let port: ConsolePort | undefined

const j2 = new Run('j2', env.name)
/** Whether J2 ran in this worker, which owns its result. */
let j2Ran = false

/** What a screenshot must not show: the password field, and the port's key wherever it is written. */
const masks = (p: Page) => [
  p.locator('input[type="password"]'),
  detailSection(p, 'Instance info'),
  ...(port ? [p.getByText(port.key)] : []),
]

const stepsOf = (run: Run) => browserSteps(run, () => page, masks)

test.afterAll(async ({ browser }, testInfo) => {
  testInfo.setTimeout(10 * 60_000)
  const step = stepsOf(j2)
  // Pass or fail: the clean-up deletes whatever the user owns, so the next run
  // starts from the same clean slate and nothing is left behind.
  const cleaned = await step('clean up: delete every project the user owns', async () => {
    if (!context || !page) {
      context = await browser.newContext()
      page = await context.newPage()
    }
    await page.goto(`${env.console}/`, { waitUntil: 'commit', timeout: 60_000 })
    await arrives(page, (u) => u.origin === env.auth0 || /^\/[^/]+\/ports$/.test(u.pathname), 'the Console or Auth0')
    if (new URL(page.url()).origin === env.auth0) await signIn(page, env, user())
    const deleted = await deleteProjects(context, env, await landOnPorts(page, env))
    return `deleted ${deleted.length} (${deleted.join(', ')}); the Console then names no project. ${await signOut(page, env)}`
  })
  await context?.close()
  if (j2Ran) await report(j2)
  else if (!cleaned) console.log('the clean-up failed in a worker that did not run J2')
  verdict()
})

test('j2', async ({ browser }) => {
  test.setTimeout(100 * 60_000)
  j2Ran = true
  const step = stepsOf(j2)
  let landed: number | undefined
  let signedIn = false

  // 1. Before the stopwatch: the user owns nothing, so the Console's
  // first-project path runs, and Auth0 holds no session for the person's browser.
  await step('clean slate: sign in, delete every project the user owns, sign out', async () => {
    const slate = await browser.newContext()
    page = await slate.newPage()
    try {
      await page.goto(`${env.console}/login`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      await signIn(page, env, user())
      const deleted = await deleteProjects(slate, env, await landOnPorts(page, env))
      await signOut(page, env)
      return `deleted ${deleted.length} (${deleted.join(', ')}) and signed out`
    } finally {
      page = undefined
      await slate.close()
    }
  })

  context = await browser.newContext()
  page = await context.newPage()
  const p = page

  // 2. A person lands on the site. The stopwatch starts.
  await step(`land on ${env.website}/, then open /pricing`, async () => {
    landed = performance.now()
    const response = await p.goto(`${env.website}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    if (response?.status() !== 200) throw new Failure(`${env.website}/ answered ${response?.status() ?? 'nothing'}, wanted 200`)
    await (await visible(p, p.getByRole('link', { name: 'Pricing', exact: true }), '"Pricing" link')).click()
    await arrives(p, (u) => u.origin === env.website && u.pathname === '/pricing', `${env.website}/pricing`)
    return `${env.website}/ → /pricing`
  })

  // 3. The price a person reads. Agreement between surfaces is `pnpm check
  // pricing`'s job; this asserts only that the number renders.
  await step('read the Blockfrost Flexible price', async () => {
    if (new URL(p.url()).pathname !== '/pricing') throw new NotRun('/pricing was not reached')
    const table = readPricingTable(await p.content())
    const blockfrost = table.ports.find((t) => /^Blockfrost\b/.test(t.name))
    const row = blockfrost?.rows.find((r) => r.label === 'PER 100K REQUESTS')
    const column = table.columns.indexOf('Flexible')
    const value = row?.values[column]
    if (!blockfrost || !row || column < 0 || value === undefined) {
      throw new Failure(`/pricing has no Blockfrost "PER 100K REQUESTS" price under Flexible (ports: ${table.ports.map((t) => t.name).join(', ')}; columns: ${table.columns.join(', ')})`)
    }
    if (!/^\$\s?\d/.test(value)) throw new Failure(`Blockfrost Flexible "PER 100K REQUESTS" reads "${value}", not a price`)
    return `Blockfrost Flexible: ${value} per 100k requests`
  })

  // 4. The sign-up CTA reaches Auth0's signup screen; the test user then signs
  // in from there instead of creating an account (decision 0047).
  await step('sign up: the CTA reaches Auth0\'s signup screen, then sign in from it', async () => {
    const cta = await visible(p, p.locator(`a[href^="${env.console}/login"]`).filter({ hasText: signupText }), 'sign-up CTA')
    const label = (await cta.innerText()).trim()
    // Caught here so that a click that fails leaves no rejection unhandled.
    const sent = p.waitForRequest((r) => r.isNavigationRequest() && r.url().startsWith(`${env.console}/login`), { timeout: 30_000 }).catch(() => null)
    await cta.click()
    const request = await sent
    if (!request) throw new Failure(`"${label}" requested nothing on ${env.console}/login within 30 s; the browser is on ${safeUrl(p.url())}`)
    const login = new URL(request.url())
    if (`${login.origin}${login.pathname}${login.search}` !== `${env.console}/login?intent=signup`) {
      throw new Failure(`"${label}" sent the browser to ${safeUrl(login.toString(), ['intent'])}, wanted ${env.console}/login?intent=signup`)
    }
    const want = auth0Screens.signup
    await arrives(p, (u) => u.origin === env.auth0 && u.pathname === want.path, `Auth0's signup screen ${want.path}`)
    const heading = (await (await visible(p, p.locator('h1'), 'heading on the signup screen')).innerText()).trim()
    if (heading !== want.heading || (await p.title()) !== want.title) {
      throw new Failure(`the signup screen reads title "${await p.title()}", heading "${heading}"; wanted "${want.title}", "${want.heading}"`)
    }
    await (await visible(p, p.getByRole('link', { name: 'Log in', exact: true }), '"Log in" link on the signup screen')).click()
    await arrives(p, (u) => u.origin === env.auth0 && u.pathname === auth0Screens.login.path, `Auth0's ${auth0Screens.login.path}`)
    const how = await signIn(p, env, user())
    signedIn = true
    return `"${label}" → ${env.console}/login?intent=signup → ${env.auth0}${want.path} ("${heading}") → signed in through the ${how}`
  })

  // 5. The Console creates a first project for a user with none.
  await step('first project: the Console lands on "My First Project"', async () => {
    if (!signedIn) throw new NotRun('not signed in')
    namespace = await landOnPorts(p, env)
    await visible(p, p.getByText('My First Project', { exact: true }), 'project named "My First Project"')
    return `${env.console}/${namespace}/ports of "My First Project"`
  })

  // 6. A Free Blockfrost port on preprod, and its endpoint and key.
  await step(`port: deploy ${portKind} on ${portType}, read its endpoint and key`, async () => {
    if (!namespace) throw new NotRun('no project')
    await deployPort(p, portKind, portType)
    const opened = await openPort(p, env)
    keepSecret(opened.key)
    port = opened
    if (opened.network !== portType) throw new Failure(`the port's network reads "${opened.network}", wanted ${portType}`)
    if (!/^https:\/\//.test(opened.endpoint)) throw new Failure(`the "Endpoint URL" row reads "${opened.endpoint}", not a URL`)
    return `${opened.name} on ${opened.network}, endpoint ${safeUrl(opened.endpoint)}; the key is held in memory only`
  })

  // 7. The first successful request stops the stopwatch.
  await step(`first request: GET ${firstCall} answers 2xx`, async () => {
    if (!port || landed === undefined) throw new NotRun('no port')
    const { answer, tries, at } = await untilSuccess(`${port.endpoint}${firstCall}`, port.key, { timeoutMs: 180_000 })
    j2.elapsedSeconds = Math.round((at - landed) / 100) / 10
    const epoch = (answer.body as { epoch?: unknown } | undefined)?.epoch
    return `${answer.status}${epoch === undefined ? '' : ` (epoch ${epoch})`} on try ${tries}; ${j2.elapsedSeconds} s from landing to first request`
  })

  // 8. After the stopwatch: usage within minutes (Prometheus), cost within the
  // hour (fabric's daemon reads Prometheus every 3600 s). Fabric lists the port
  // before its daemon has counted the request (0 units 4 minutes after it, run
  // 39411503584), so the cost waits for the count.
  await step('usage, then cost: the Console shows the request', async () => {
    if (!port || !namespace || j2.elapsedSeconds === undefined) throw new NotRun('no successful request')
    const [n, at] = [namespace, port]
    const usage = await poll(5 * 60_000, 15_000, async () => {
      const count = await dailyRequests(p, env, n, at)
      return count >= 1 ? `${count} daily requests` : null
    })
    if (!usage.value) throw new Failure(`the usage view showed no request within 5 minutes`)
    let last = null as BillingRow | null
    const cost = await poll(75 * 60_000, 60_000, async () => {
      last = await billingRow(p, env, n, at)
      return last && last.units >= 1 ? last.cells.join(' · ') : null
    })
    if (!cost.value) {
      const seen = last ? `listed ${at.name} at ${last.units} units (${last.cells.join(' · ')})` : `did not list ${at.name}`
      throw new Failure(`usage: ${usage.value} after ${usage.seconds} s; cost: "Project Usage" ${seen} after 75 minutes, wanted the request counted`)
    }
    return `usage: ${usage.value} after ${usage.seconds} s; cost: "Project Usage" lists ${cost.value} after ${Math.round(cost.seconds / 60)} min`
  })

  // 9. The Console's leg of the live pricing check: its prices render only
  // signed in, so `pnpm check pricing` cannot read them (rescope of 2026-10-19).
  await step(`Console price: the ${portKind} card agrees with fabric`, async () => {
    if (!port || !namespace) throw new NotRun('no port')
    const quoted = consoleCards(readConsolePricing(await pricingCells(p, env, namespace, port)), 'blockfrost')
    const read = quoted.map(describeCard).join('; ')
    let billed: Card[] | null = null
    let unread = ''
    try {
      billed = fabricCards(fabricTiers(await fetchMetadata(env.rpc)))
    } catch (error) {
      unread = (error as Error).message
    }
    const divergences = compare(billed, { console: quoted }, { owes: { console: ['blockfrost'] } })
    const lines = [
      ...(unread ? [`fabric could not be read: ${unread}`] : []),
      ...(divergences.length ? [`${divergences.length} divergence${divergences.length === 1 ? '' : 's'}:`, ...divergences] : []),
    ]
    if (lines.length) throw new Failure([...lines, `the Console quotes ${read}`].join('\n'))
    return `the Console quotes ${read}, as fabric bills`
  })
})

// The proxies' meters drop 401, 429 and 503 from billing
// (solution/proxies/blockfrost/operator/src/metrics.rs:105,
// ogmios/operator/src/metrics.rs:106, utxorpc/operator/src/metrics.rs:168): a
// wrong key must answer 401, which is never billed.
test('j2-401', async () => {
  test.setTimeout(2 * 60_000)
  const run = new Run('j2-401', env.name)
  await stepsOf(run)(`a key with its last character changed: GET ${firstCall} answers 401`, async () => {
    if (!port) throw new NotRun('J2 deployed no port')
    const key = port.key
    const wrong = keepSecret(`${key.slice(0, -1)}${key.endsWith('a') ? 'b' : 'a'}`)
    const answer = await portGet(`${port.endpoint}${firstCall}`, wrong)
    if (answer.status !== 401) throw new Failure(`answered ${describePortAnswer(answer)}, wanted 401`)
    return '401'
  })
  await report(run)
})

// The Free tier limits a key to 60 requests a minute across the Blockfrost
// proxy's replicas, each enforcing its share (the Console quotes 5 requests a
// second), and the meters drop 429 from billing. One burst of 30 can land
// under every replica's share, so bursts repeat until one answers 429. None
// may answer 5xx.
test('j2-429', async () => {
  test.setTimeout(3 * 60_000)
  const run = new Run('j2-429', env.name)
  await stepsOf(run)(`bursts of 30 concurrent GET ${firstCall} answer 429, and no 5xx`, async () => {
    if (!port) throw new NotRun('J2 deployed no port')
    const answers = []
    for (let bursts = 1; bursts <= 5; bursts += 1) {
      answers.push(...(await burst(`${port.endpoint}${firstCall}`, port.key, 30)))
      if (answers.some((a) => a.status === 429)) break
    }
    const counts = tally(answers)
    const said = `${answers.length} requests in ${answers.length / 30} burst${answers.length === 30 ? '' : 's'}: ${describeTally(counts)}`
    const failed = answers.filter((a) => a.status === null || a.status >= 500)
    if (failed.length) throw new Failure(`${said}; ${failed.length} answered 5xx or nothing`)
    if (!counts.has('429')) throw new Failure(`${said}; none answered 429`)
    return said
  })
  await report(run)
})

// Two Auth0 clients on one cookie domain after the 2026-07-31 cutover: the
// legacy app still serves /auth and /callbacks/auth0 on the apex, and names its
// session cookie as the Console does (`_session-v2`, on the demeter.run zone,
// `account/app/services/session.server.ts` in solution/marketing/website). A
// browser holding the legacy app's cookie must still reach the Console.
test('j2-legacy-cookie', async () => {
  test.setTimeout(8 * 60_000)
  const run = new Run('j2-legacy-cookie', env.name)
  const step = stepsOf(run)
  let legacy = false
  await step(`sign in through the legacy app at ${env.website}/auth`, async () => {
    if (!page || !namespace) throw new NotRun('J2 left no signed-in session')
    // The legacy app reads the Console's cookie as its own session: holding
    // it, /auth sends the browser straight to / as signed in and writes
    // nothing (run 39410716098). Without it, the legacy app signs the browser
    // in through Auth0's session, which J2 left, and writes its own.
    await page.context().clearCookies({ name: sessionCookie })
    // Caught here so that a navigation that fails leaves no rejection unhandled.
    const callback = page.waitForResponse((r) => r.url().startsWith(`${env.website}/callbacks/auth0`), { timeout: 60_000 }).catch(() => null)
    await page.goto(`${env.website}/auth`, { waitUntil: 'commit', timeout: 30_000 })
    await arrives(page, (u) => (u.origin === env.auth0 ? u.pathname === auth0Screens.login.path : u.pathname !== '/auth'), "Auth0's login form or the legacy callback")
    if (new URL(page.url()).origin === env.auth0) await signIn(page, env, user())
    const answered = await callback
    if (!answered) throw new Failure(`the legacy app's ${env.website}/callbacks/auth0 never answered; the browser is on ${safeUrl(page.url())}`)
    const set = (await answered.headerValues('set-cookie')).map((c) => c.split('=')[0]!.trim())
    if (!set.includes(sessionCookie)) throw new Failure(`${env.website}/callbacks/auth0 answered ${answered.status()} and set ${set.join(', ') || 'no cookie'}, not ${sessionCookie}`)
    legacy = true
    return `the legacy callback answered ${answered.status()} and set ${sessionCookie}; the browser holds ${(await cookiesNamed(page.context(), sessionCookie)).join(', ')}`
  })
  await step(`open ${env.console}/ and sign in: the Console lands on the ports page`, async () => {
    if (!page || !legacy) throw new NotRun('no legacy session')
    // A Console that cannot read the cookie it is sent signs the browser in
    // again, through Auth0's session when there is one: its callback says so.
    let called = false
    const callbacks = (r: { url(): string }) => {
      if (r.url().startsWith(`${env.console}/callbacks/auth0`)) called = true
    }
    page.on('request', callbacks)
    try {
      await page.goto(`${env.console}/`, { waitUntil: 'commit', timeout: 60_000 })
      await arrives(page, (u) => u.origin === env.auth0 || /^\/[^/]+\/ports$/.test(u.pathname), 'the Console or Auth0')
      if (new URL(page.url()).origin === env.auth0) await signIn(page, env, user())
    } finally {
      page.off('request', callbacks)
    }
    const how = called ? 'the Console signed the browser in again' : 'the Console read its session'
    const landedOn = await landOnPorts(page, env)
    return `${how}, landed on /${landedOn}/ports; the browser holds ${(await cookiesNamed(page.context(), sessionCookie)).join(', ')}`
  })
  await report(run)
})

/** Calls `read` every `everyMs` until it returns a value or `timeoutMs` passes; a failed read is retried. */
async function poll(timeoutMs: number, everyMs: number, read: () => Promise<string | null>): Promise<{ value: string | null; seconds: number }> {
  const t0 = performance.now()
  let last: unknown
  while (performance.now() - t0 < timeoutMs) {
    try {
      const value = await read()
      if (value) return { value, seconds: Math.round((performance.now() - t0) / 1000) }
    } catch (error) {
      last = error
    }
    await new Promise((resolve) => setTimeout(resolve, everyMs))
  }
  if (last) throw last
  return { value: null, seconds: Math.round((performance.now() - t0) / 1000) }
}

const describeCard = (c: Card) => `${tierName(c.tier)} ${formatUsd(c.minimum_usd)} minimum and ${formatUsd(c.per_100k_usd)} per 100k`
