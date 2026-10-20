import { rmSync } from 'node:fs'
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { constants, tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Browser, type BrowserContext, chromium } from '@playwright/test'
import type { Environment } from '../env.ts'
import { mockCalls, resetMock } from '../mock/control.ts'
import { Failure, type Run } from '../report.ts'
import { signIn } from '../signin.ts'
import {
  addPortSecrets,
  addRegistrationSecrets,
  type AgentAnswer,
  call,
  createPort,
  describe,
  dotenvVars,
  J0_PORT,
  NAMESPACE,
  type Registration,
  register,
  type Secrets,
} from './client.ts'
import { addCookieSecrets, type ConsoleWaits, consoleWaits, deleteClaimed, firstLine, pageAnswer, pageLoads, said } from './console.ts'

/**
 * J0, the coding agent's main journey (`solution/devex/contracts/
 * journey-matrix.md`), as scripted calls with no model: from no account to a
 * first request, then a claim by a person. Against the mock on every merge,
 * and daily against production as a probe that claims its project and deletes
 * it (umbrella ruling 3).
 *
 * The agent keeps what it is given where an agent would: in a `.env.demeter`
 * of its own, in a fresh temporary directory, readable by this user only,
 * never printed, and removed at the end, or on SIGINT or SIGTERM.
 */

/** How long J0 waits, and how often it tries again; the tests shorten them. */
export interface J0Waits extends ConsoleWaits {
  /** For the port to answer its first request, while it comes up. */
  firstRequestMs: number
  /** Between requests to the port. */
  requestEveryMs: number
  /** For each page, form and button of the claim in the browser. */
  browserMs: number
}

export const j0Waits: J0Waits = { ...consoleWaits, firstRequestMs: 180_000, requestEveryMs: 5_000, browserMs: 30_000 }

export interface J0Options {
  env: Environment
  run: Run
  secrets: Secrets
  /** Who claims: the standing test user on production; any name on the mock. */
  user: string
  password: string
  /**
   * Runs once the port exists and before its first request, on this run's
   * registration: the contract tests, so a production run registers once.
   */
  between?: (registration: Registration) => Promise<void>
  waits?: Partial<J0Waits>
}

const AGENT = { name: 'e2e-j0', url: 'https://github.com/demeter-run/e2e' }
/** The Blockfrost call the outside probes make (`clusters` repo, `grafana-cloud/synthetics/blockfrost.js`). */
const REQUEST_PATH = '/blocks/latest'
const PREFIX = 'DEMETER_BLOCKFROST_PREPROD'

const fail = (message: string): never => {
  throw new Failure(message)
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`

/**
 * Requests `url` with the port's key until it answers 2xx or `withinMs` runs
 * out, `everyMs` apart. `retry` says which answers are worth another try:
 * while a new port comes up any refusal is, but once it has answered only a
 * missing or 5xx answer is.
 */
async function request(url: string, key: string, withinMs: number, everyMs: number, retry: (answer: AgentAnswer) => boolean) {
  const t0 = performance.now()
  const statuses: (number | null)[] = []
  for (;;) {
    // A `_URL` may end in a slash (the mock's does), and the path is appended to it.
    const answer = await call('GET', `${url.replace(/\/+$/, '')}${REQUEST_PATH}`, { headers: { 'dmtr-api-key': key }, timeoutMs: 15_000 })
    statuses.push(answer.status)
    const elapsed = performance.now() - t0
    if (answer.status !== null && answer.status >= 200 && answer.status < 300) return { answer, statuses, elapsed }
    if (!retry(answer) || elapsed + everyMs > withinMs) {
      fail(`${describe(answer)} after ${seconds(elapsed)} and ${statuses.length} attempts, wanted 2xx`)
    }
    await new Promise((resolve) => setTimeout(resolve, everyMs))
  }
}

/** Origin and path of a URL a step may print; a key in the host or path is scrubbed by the caller. */
const where = (url: string) => {
  const u = new URL(url)
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`
}

/** Where the browser is, as a step may print it: origin and path, with a claim link's token left out. */
const browserAt = (url: string) => {
  const u = new URL(url)
  return u.protocol === 'http:' || u.protocol === 'https:' ? `${u.origin}${u.pathname.replace(/^\/claim\/.*/, '/claim/<token>')}` : u.protocol
}

export async function j0({ env, run, secrets, user, password, between, waits: shorter = {} }: J0Options): Promise<void> {
  const waits = { ...j0Waits, ...shorter }
  const onMock = env.name === 'mock'
  const dir = await mkdtemp(join(tmpdir(), 'e2e-j0-'))
  const envFile = join(dir, '.env.demeter')
  const vars = async () => dotenvVars(await readFile(envFile, 'utf8').catch(() => ''))
  const registration: Registration = { register: { status: null, headers: {}, body: '', error: 'not called' }, port: null }
  const firstStatuses: (number | null)[] = []
  const laterStatuses: (number | null)[] = []
  let namespace = ''
  let expiresAt = ''
  let portId = ''
  /** What the claim form's project name held when "Claim project" was pressed. */
  let offeredName: string | undefined
  /** Set when the project's page already answered the user before the claim: register named a project the user had. */
  let ownedBefore = false
  /** Set when the claim button was pressed, whether or not the landing followed. */
  let claimSent = false
  let claimed = false
  let browser: Browser | undefined
  let context: BrowserContext | undefined
  /** Positions in the mock's call log around `between`, whose calls are not J0's. */
  let skip: [number, number] | undefined

  // A cancelled run skips `finally`: the .env.demeter goes, then the process.
  // It exits rather than raising the signal again, which the listeners
  // Playwright adds once Chromium runs (and tsx's) would absorb, so the run
  // would go on with its browser closed.
  const onSignal = (signal: NodeJS.Signals) => {
    rmSync(dir, { recursive: true, force: true })
    process.exit(128 + (constants.signals[signal] ?? 0))
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  try {
    if (onMock) await run.step('start from an empty mock', () => resetMock(env).then(() => 'POST /__mock/reset'))

    await run.step(`register as agent ${AGENT.name} into .env.demeter`, async () => {
      const t0 = performance.now()
      registration.register = await register(env, AGENT)
      const answer = registration.register
      // A 200 whose body did not finish registered a project this run cannot use.
      if (answer.status !== 200 || answer.error) fail(`register answered ${describe(answer)}, wanted 200`)
      const got = dotenvVars(answer.body)
      addRegistrationSecrets(secrets, answer.body)
      await writeFile(envFile, answer.body, { mode: 0o600 })
      namespace = got.get('DEMETER_PROJECT_NAMESPACE') ?? ''
      expiresAt = got.get('DEMETER_EXPIRES_AT') ?? ''
      if (!namespace || !got.get('DEMETER_CLAIM_URL')) fail('register answered 200 without DEMETER_PROJECT_NAMESPACE and DEMETER_CLAIM_URL')
      // The namespace goes into the Console's paths, the delete's among them:
      // anything but a DNS label could name another page, or another project.
      if (!NAMESPACE.test(namespace)) {
        namespace = ''
        fail('register answered 200 with a DEMETER_PROJECT_NAMESPACE that is not a DNS label')
      }
      return `200 in ${seconds(performance.now() - t0)}: namespace ${namespace}, expires ${expiresAt}`
    })

    await run.step(`create a Blockfrost port (${J0_PORT.kind}) on ${J0_PORT.network}`, async () => {
      const got = await vars()
      const apiKey = got.get('DEMETER_API_KEY') ?? fail('.env.demeter has no DEMETER_API_KEY: register failed')
      const projectId = got.get('DEMETER_PROJECT_ID') ?? fail('.env.demeter has no DEMETER_PROJECT_ID: register failed')
      const t0 = performance.now()
      registration.port = await createPort(env, { apiKey, projectId }, { ...J0_PORT })
      const answer = registration.port
      if (answer.status !== 200 || answer.error) fail(`ports answered ${describe(answer)}, wanted 200`)
      addPortSecrets(secrets, answer.body)
      await appendFile(envFile, answer.body)
      portId = (await vars()).get(`${PREFIX}_PORT_ID`) ?? ''
      return `200 in ${seconds(performance.now() - t0)}: port ${portId || '(no id)'}`
    })

    if (between) {
      const before = onMock ? (await mockCalls(env)).length : 0
      await between(registration)
      if (onMock) skip = [before, (await mockCalls(env)).length]
    }

    const port = async () => {
      const got = await vars()
      return {
        url: got.get(`${PREFIX}_URL`) ?? fail(`.env.demeter has no ${PREFIX}_URL: the port step failed`),
        key: got.get(`${PREFIX}_KEY`) ?? fail(`.env.demeter has no ${PREFIX}_KEY: the port step failed`),
      }
    }

    await run.step(`request ${PREFIX}_URL with ${PREFIX}_KEY until it answers 2xx`, async () => {
      const { url, key } = await port()
      const { answer, statuses, elapsed } = await request(url, key, waits.firstRequestMs, waits.requestEveryMs, () => true)
      firstStatuses.push(...statuses)
      return `${where(url)}${REQUEST_PATH}: ${answer.status} after ${seconds(elapsed)} and ${statuses.length} attempt${statuses.length === 1 ? '' : 's'}`
    })

    await run.step(`claim in the browser as ${onMock ? 'a mock user' : user}`, async () => {
      const claimUrl = (await vars()).get('DEMETER_CLAIM_URL') ?? fail('.env.demeter has no DEMETER_CLAIM_URL: register failed')
      // A project claimed under no known namespace could not be deleted after.
      if (!namespace) fail('not run: register named no usable namespace, so a claimed project could not be found to delete')
      // The browser goes only to the Console: the claim page leads to the
      // sign-in, where the test user's password is typed.
      const claimOrigin = URL.canParse(claimUrl) ? new URL(claimUrl).origin : '(not a URL)'
      if (claimOrigin !== new URL(env.console).origin) fail(`DEMETER_CLAIM_URL is on ${claimOrigin}, not the Console (${env.console}), so the browser does not open it`)
      const t0 = performance.now()
      browser = await chromium.launch()
      context = await browser.newContext()
      const session = context
      const page = await context.newPage()
      page.setDefaultTimeout(waits.browserMs)
      // How the last page the browser loaded answered, and the claim's post,
      // for an error: a page that answers 500 shows no button, and the wait
      // for one says only that. Once the page has hydrated, the Console's
      // claim form posts by fetch, whose answer is no page load: a claim
      // fabric refuses answers 500 and leaves the browser on the claim page.
      // Before, the form posts as a page load, which is both.
      const claimPath = new URL(claimUrl).pathname
      let loaded: number | undefined
      let posted: number | undefined
      page.on('response', (response) => {
        try {
          if (response.request().method() === 'POST' && new URL(response.url()).pathname === claimPath) posted = response.status()
          if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) loaded = response.status()
        } catch {
          // A service worker's response has no frame.
        }
      })
      try {
        const opened = await page.goto(claimUrl, { waitUntil: 'domcontentloaded' })
        if (opened?.status() !== 200) fail(`the claim page answered ${opened?.status() ?? 'nothing'}, wanted 200`)
        await page.getByRole('link', { name: 'Log in' }).click()
        await signIn(page, user, password, { origin: env.auth0, timeoutMs: waits.browserMs })
        await addCookieSecrets(context, secrets)
        const claim = page.getByRole('button', { name: 'Claim project' })
        await claim.waitFor()
        // The name is read once the page has hydrated, which may change it, and
        // left as it is: the next step judges it, so a wrong default does not
        // stop the claim (the Console names a project left empty after its
        // namespace).
        await page.waitForLoadState('load')
        offeredName = await page.locator('input[name="name"]').inputValue()
        // Nothing else ties the namespace register named to the project this
        // claim makes: before the claim, it must not be the user's already, or
        // the delete after it could remove a project the user had.
        const before = await pageAnswer(session.request, `${env.console}/${namespace}/ports`, secrets)
        if (before.status === 200) {
          ownedBefore = true
          fail(`/${namespace}/ports answered ${user} 200 before the claim: register named a project ${user} already owns, so nothing is claimed`)
        }
        if (before.status === null) fail(`/${namespace}/ports gave ${said(before)} before the claim, so whether it is already ${user}'s is unknown, and nothing is claimed`)
        claimSent = true
        await claim.click()
        await page.waitForURL((url) => url.pathname === `/${namespace}/ports`)
        // Reaching the page is not owning the project: a claim that failed
        // can land there on an error page. Its loader must answer the user,
        // within the time fabric's projection may take to show the claim.
        const landing = await pageLoads(session.request, `${env.console}/${namespace}/ports`, secrets, waits.landingMs, waits.pageEveryMs)
        if (landing.status !== 200) {
          fail(`landed on /${namespace}/ports, but it answered ${said(landing)} to ${user}'s session for the next ${seconds(waits.landingMs)}, wanted 200: the claim is unconfirmed`)
        }
        claimed = true
      } catch (error) {
        if (error instanceof Failure) throw error
        // A Playwright error carries a call log and URLs with their queries
        // (Auth0's state); the first line and where the browser was are enough.
        await addCookieSecrets(session, secrets).catch(() => {})
        const last = loaded === undefined ? '' : `, where the last page it loaded answered ${loaded}`
        const post = posted === undefined ? '' : `, and the claim's post answered ${posted}`
        fail(`${firstLine(secrets, error)} (the browser was at ${secrets.scrub(browserAt(page.url()))}${last}${post})`)
      }
      return `claimed ${namespace} and landed on /${namespace}/ports, which answers ${user} 200, in ${seconds(performance.now() - t0)}`
    })

    await run.step('the claim page offered the namespace as the project name', async () => {
      if (offeredName === undefined) fail('not run: the claim form never showed')
      if (offeredName !== namespace) fail(`the project name defaulted to "${offeredName}", wanted the namespace ${namespace}`)
      return `"${offeredName}"`
    })

    // Whether or not the claim is confirmed, the key must work once it was sent.
    await run.step('after the claim, the same request with the same key still answers 2xx', async () => {
      if (!claimSent) fail('not run: no claim was sent, so no request comes after it')
      const { url, key } = await port()
      // The port is up: only a missing or 5xx answer is worth another try.
      const { answer, statuses, elapsed } = await request(url, key, 30_000, waits.requestEveryMs, (a) => a.status === null || a.status >= 500)
      laterStatuses.push(...statuses)
      const unconfirmed = claimed ? '' : ' (the claim is unconfirmed)'
      return `${answer.status} after ${seconds(elapsed)} and ${statuses.length} attempt${statuses.length === 1 ? '' : 's'}${unconfirmed}`
    })
  } finally {
    if (onMock) {
      await run.step("the mock's call log holds exactly the calls the steps made", async () => {
        const calls = await mockCalls(env)
        const own = skip ? [...calls.slice(0, skip[0]), ...calls.slice(skip[1])] : calls
        const got = own.map((c) => `${c.method} ${c.path} ${c.status}`)
        const data = (statuses: (number | null)[]) => statuses.map((s) => `GET /data/${portId}${REQUEST_PATH} ${s}`)
        const want = [
          'POST /api/agent/register 200',
          'POST /api/agent/ports 200',
          ...data(firstStatuses),
          'GET /claim/[redacted] 200', // signed out: "Log in"
          'GET /login 200',
          'POST /login 302',
          'GET /claim/[redacted] 200', // signed in: the claim form
          `GET /${namespace}/ports 404`, // before the claim, outside the browser: not the user's yet
          'POST /claim/[redacted] 302',
          `GET /${namespace}/ports 200`, // the landing
          `GET /${namespace}/ports 200`, // its check, outside the browser
          ...data(laterStatuses),
        ]
        if (got.join('\n') !== want.join('\n')) fail(`the mock logged:\n${got.join('\n')}\nwanted:\n${want.join('\n')}`)
        return `${got.length} calls`
      })
    } else {
      await run.step('delete the claimed project through the Console', async () => {
        const registered = registration.register
        if (registered.status !== 200 || registered.error) {
          // A refusal registered nothing; a timeout, a 5xx or a 200 cut short
          // may have, without handing its credentials over.
          return registered.status !== null && registered.status !== 200 && registered.status < 500
            ? `register answered ${describe(registered)}: nothing was registered, so nothing is left behind`
            : `register answered ${describe(registered)}: a project may have been registered without this run learning it, and if so it expires unclaimed within 7 days`
        }
        // The claim step claims nothing without a namespace.
        if (!claimSent || !context) {
          return fail(
            !namespace
              ? 'register answered 200 but named no usable namespace: its project cannot be found, and expires unclaimed within 7 days'
              : ownedBefore
                ? `register named ${namespace}, which was already ${user}'s, so nothing was claimed or deleted: this run's project expires unclaimed at ${expiresAt}`
                : `${namespace} was never claimed: it expires unclaimed at ${expiresAt}`,
          )
        }
        return deleteClaimed({ console: env.console, namespace, expiresAt, user, session: context.request, secrets, landed: claimed }, waits)
      })
    }
    await browser?.close()
    await rm(dir, { recursive: true, force: true })
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
  }
}
