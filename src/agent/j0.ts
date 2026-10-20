import { rmSync } from 'node:fs'
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
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
  type Registration,
  register,
  type Secrets,
} from './client.ts'

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
  /** How long the port may take to answer its first request. */
  firstRequestMs?: number
}

const AGENT = { name: 'e2e-j0', url: 'https://github.com/demeter-run/e2e' }
/** The Blockfrost call the outside probes make (`clusters` repo, `grafana-cloud/synthetics/blockfrost.js`). */
const REQUEST_PATH = '/blocks/latest'
const PREFIX = 'DEMETER_BLOCKFROST_PREPROD'

const fail = (message: string): never => {
  throw new Failure(message)
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * The browser's cookies, for `Secrets`: a Playwright error's call log
 * carries the request's `cookie:` header, the Console session included.
 * Short values (flags, `Lax`) are not credentials.
 */
async function addCookieSecrets(context: BrowserContext, secrets: Secrets): Promise<void> {
  for (const cookie of await context.cookies()) if (cookie.value.length >= 16) secrets.add('session cookie', cookie.value)
}

/**
 * A Playwright call that may fail with its call log (request headers, the
 * cookie among them): the step keeps the first line, scrubbed.
 */
async function guarded<T>(secrets: Secrets, what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    return fail(secrets.scrub(`${what}: ${(error as Error).message.split('\n')[0]}`))
  }
}

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
    const answer = await call('GET', `${url}${REQUEST_PATH}`, { headers: { 'dmtr-api-key': key }, timeoutMs: 15_000 })
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
  return `${u.origin}${u.pathname}`
}

export async function j0({ env, run, secrets, user, password, between, firstRequestMs = 180_000 }: J0Options): Promise<void> {
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
  /** Set when the claim button was pressed, whether or not the landing followed. */
  let claimSent = false
  let claimed = false
  let browser: Browser | undefined
  let context: BrowserContext | undefined
  /** Positions in the mock's call log around `between`, whose calls are not J0's. */
  let skip: [number, number] | undefined

  // A cancelled run skips `finally`: the .env.demeter goes before the signal
  // takes its default course.
  const onSignal = (signal: NodeJS.Signals) => {
    rmSync(dir, { recursive: true, force: true })
    process.kill(process.pid, signal)
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  try {
    if (onMock) await run.step('start from an empty mock', () => resetMock(env).then(() => 'POST /__mock/reset'))

    await run.step(`register as agent ${AGENT.name} into .env.demeter`, async () => {
      const t0 = performance.now()
      registration.register = await register(env, AGENT)
      const answer = registration.register
      if (answer.status !== 200) fail(`register answered ${describe(answer)}, wanted 200`)
      const got = dotenvVars(answer.body)
      addRegistrationSecrets(secrets, answer.body)
      await writeFile(envFile, answer.body, { mode: 0o600 })
      namespace = got.get('DEMETER_PROJECT_NAMESPACE') ?? ''
      expiresAt = got.get('DEMETER_EXPIRES_AT') ?? ''
      if (!namespace || !got.get('DEMETER_CLAIM_URL')) fail('register answered 200 without DEMETER_PROJECT_NAMESPACE and DEMETER_CLAIM_URL')
      return `200 in ${seconds(performance.now() - t0)}: namespace ${namespace}, expires ${expiresAt}`
    })

    await run.step(`create a Blockfrost port (${J0_PORT.kind}) on ${J0_PORT.network}`, async () => {
      const got = await vars()
      const apiKey = got.get('DEMETER_API_KEY') ?? fail('.env.demeter has no DEMETER_API_KEY: register failed')
      const projectId = got.get('DEMETER_PROJECT_ID') ?? fail('.env.demeter has no DEMETER_PROJECT_ID: register failed')
      const t0 = performance.now()
      registration.port = await createPort(env, { apiKey, projectId }, { ...J0_PORT })
      const answer = registration.port
      if (answer.status !== 200) fail(`ports answered ${describe(answer)}, wanted 200`)
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
      const { answer, statuses, elapsed } = await request(url, key, firstRequestMs, 5_000, () => true)
      firstStatuses.push(...statuses)
      return `${where(url)}${REQUEST_PATH}: ${answer.status} after ${seconds(elapsed)} and ${statuses.length} attempt${statuses.length === 1 ? '' : 's'}`
    })

    await run.step(`claim in the browser as ${onMock ? 'a mock user' : user}`, async () => {
      const claimUrl = (await vars()).get('DEMETER_CLAIM_URL') ?? fail('.env.demeter has no DEMETER_CLAIM_URL: register failed')
      // The browser goes only to the Console: the claim page leads to the
      // sign-in, where the test user's password is typed.
      const claimOrigin = URL.canParse(claimUrl) ? new URL(claimUrl).origin : '(not a URL)'
      if (claimOrigin !== new URL(env.console).origin) fail(`DEMETER_CLAIM_URL is on ${claimOrigin}, not the Console (${env.console}), so the browser does not open it`)
      const t0 = performance.now()
      browser = await chromium.launch()
      context = await browser.newContext()
      const page = await context.newPage()
      try {
        await page.goto(claimUrl, { waitUntil: 'domcontentloaded' })
        await page.getByRole('link', { name: 'Log in' }).click()
        await signIn(page, user, password, { origin: env.auth0 })
        await addCookieSecrets(context, secrets)
        const claim = page.getByRole('button', { name: 'Claim project' })
        await claim.waitFor({ timeout: 30_000 })
        const name = await page.locator('input[name="name"]').inputValue()
        if (name !== namespace) fail(`the project name defaults to "${name}", wanted the namespace ${namespace}`)
        claimSent = true
        await claim.click()
        await page.waitForURL((url) => url.pathname === `/${namespace}/ports`, { timeout: 30_000 })
        claimed = true
      } catch (error) {
        if (error instanceof Failure) throw error
        // A Playwright error carries a call log and URLs with their queries
        // (Auth0's state); the first line and where the browser was are enough.
        // Either may hold the claim URL, so neither leaves unscrubbed.
        if (context) await addCookieSecrets(context, secrets).catch(() => {})
        const here = new URL(page.url())
        fail(secrets.scrub(`${(error as Error).message.split('\n')[0]} (the browser was at ${here.origin}${here.pathname})`))
      }
      return `claimed ${namespace} and landed on /${namespace}/ports in ${seconds(performance.now() - t0)}`
    })

    await run.step('after the claim, the same request with the same key still answers 2xx', async () => {
      if (!claimed) fail('not run: the claim did not land, so no request comes after it')
      const { url, key } = await port()
      // The port is up: only a missing or 5xx answer is worth another try.
      const { answer, statuses, elapsed } = await request(url, key, 30_000, 5_000, (a) => a.status === null || a.status >= 500)
      laterStatuses.push(...statuses)
      return `${answer.status} after ${seconds(elapsed)} and ${statuses.length} attempt${statuses.length === 1 ? '' : 's'}`
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
          'POST /claim/[redacted] 302',
          `GET /${namespace}/ports 200`,
          ...data(laterStatuses),
        ]
        if (got.join('\n') !== want.join('\n')) fail(`the mock logged:\n${got.join('\n')}\nwanted:\n${want.join('\n')}`)
        return `${got.length} calls`
      })
    } else {
      await run.step('delete the claimed project through the Console', async () => {
        const registered = registration.register
        if (registered.status !== 200) {
          // A refusal registered nothing; a timeout or a 5xx may have, without
          // handing its credentials over.
          return registered.status !== null && registered.status < 500
            ? `register answered ${describe(registered)}: nothing was registered, so nothing is left behind`
            : `register answered ${describe(registered)}: a project may have been registered without this run learning it, and if so it expires unclaimed within 7 days`
        }
        if (!namespace) fail('register answered 200 but named no namespace, so nothing can be deleted')
        if (!claimSent || !context) fail(`${namespace} was never claimed: it expires unclaimed at ${expiresAt}`)
        const session = context!
        await addCookieSecrets(session, secrets)
        const portsPage = `${env.console}/${namespace}/ports`
        const get = (url: string) => guarded(secrets, `GET ${new URL(url).pathname}`, () => session.request.get(url, { maxRedirects: 0 }))
        const redirectedTo = (answer: { headers(): Record<string, string> }) => new URL(answer.headers().location ?? '/', env.console).pathname

        // The project must be the test user's to be deleted. A claim whose
        // landing failed may still have gone through: it gets the landing's time.
        if (!claimed) {
          const t0 = performance.now()
          for (;;) {
            const page = await get(portsPage)
            if (page.status() === 200) break
            if (performance.now() - t0 > 30_000) {
              fail(
                `the claim was sent, but /${namespace}/ports answered ${page.status()} for the next 30 s: if the claim went through, ${namespace} is on ${user}'s account and needs deleting by hand; if not, it expires unclaimed at ${expiresAt}`,
              )
            }
            await sleep(3_000)
          }
        }

        // The settings page's DELETE button posts this form. Its action answers
        // a redirect once fabric has taken the delete: to the user's next
        // project, or to /, whose loader creates "My First Project" for a user
        // left with none, so the redirect is not followed. A redirect to /login
        // means the session was refused. A 200 is the action reporting an
        // error, a 5xx one of its own (fabric's projection may lag the claim),
        // and a lost answer says nothing: each is tried again, unless the
        // project's page has stopped loading meanwhile, when the delete went
        // through without its answer.
        const settings = `${env.console}/${namespace}/settings`
        let accepted = ''
        for (let attempt = 1; !accepted; attempt++) {
          let answered: string
          try {
            const answer = await session.request.post(settings, { form: { intent: 'DELETE_PROJECT' }, maxRedirects: 0 })
            const to = answer.status() === 302 ? redirectedTo(answer) : ''
            if (to.startsWith('/login')) fail(`POST /${namespace}/settings redirected to ${to}: the Console refused the session, so ${namespace} is still on ${user}'s account`)
            if (to) {
              accepted = `302 to ${to}${attempt > 1 ? ` on attempt ${attempt}` : ''}`
              break
            }
            answered = String(answer.status())
          } catch (error) {
            if (error instanceof Failure) throw error
            answered = secrets.scrub((error as Error).message.split('\n')[0]!)
          }
          await sleep(5_000)
          const page = await get(portsPage)
          if (page.status() !== 200 && page.status() !== 302) accepted = `${answered} on attempt ${attempt}, then /${namespace}/ports answered ${page.status()}`
          else if (attempt === 3) fail(`POST /${namespace}/settings answered ${answered} on the last of 3 attempts, wanted a redirect after the delete: ${namespace} is still on ${user}'s account`)
        }

        // fabric deletes on its event stream: the project leaves the Console a
        // moment later, and its pages stop loading (fabric no longer knows the
        // namespace, and the Console answers 500). Two such answers in a row,
        // so one passing error is not taken for the delete.
        const t0 = performance.now()
        let gone = 0
        for (;;) {
          const page = await get(portsPage)
          if (page.status() === 302) {
            fail(`deleted (${accepted}), but /${namespace}/ports then redirected to ${redirectedTo(page)}, so the session cannot confirm the project is gone`)
          }
          gone = page.status() === 200 ? 0 : gone + 1
          if (gone === 2) return `deleted (${accepted}); /${namespace}/ports answers ${page.status()} twice in a row after ${seconds(performance.now() - t0)}`
          if (performance.now() - t0 > 60_000) fail(`deleted (${accepted}), but /${namespace}/ports still loads after 60 s`)
          await sleep(3_000)
        }
      })
    }
    await browser?.close()
    await rm(dir, { recursive: true, force: true })
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
  }
}
