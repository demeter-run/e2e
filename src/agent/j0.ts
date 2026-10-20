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
 * never printed, and removed at the end.
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
  let claimed = false
  let browser: Browser | undefined
  let context: BrowserContext | undefined
  /** Positions in the mock's call log around `between`, whose calls are not J0's. */
  let skip: [number, number] | undefined

  try {
    if (onMock) await run.step('start from an empty mock', () => resetMock(env).then(() => 'POST /__mock/reset'))

    await run.step(`register as agent ${AGENT.name} into .env.demeter`, async () => {
      const t0 = performance.now()
      registration.register = await register(env, AGENT)
      const answer = registration.register
      if (answer.status !== 200) fail(`register answered ${describe(answer)}, wanted 200`)
      const got = dotenvVars(answer.body)
      addRegistrationSecrets(secrets, got)
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
      addPortSecrets(secrets, dotenvVars(answer.body))
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
      const t0 = performance.now()
      browser = await chromium.launch()
      context = await browser.newContext()
      const page = await context.newPage()
      try {
        await page.goto(claimUrl, { waitUntil: 'domcontentloaded' })
        await page.getByRole('link', { name: 'Log in' }).click()
        await signIn(page, user, password)
        const claim = page.getByRole('button', { name: 'Claim project' })
        await claim.waitFor({ timeout: 30_000 })
        const name = await page.locator('input[name="name"]').inputValue()
        if (name !== namespace) fail(`the project name defaults to "${name}", wanted the namespace ${namespace}`)
        await claim.click()
        await page.waitForURL((url) => url.pathname === `/${namespace}/ports`, { timeout: 30_000 })
        claimed = true
      } catch (error) {
        if (error instanceof Failure) throw error
        // A Playwright error carries a call log and URLs with their queries
        // (Auth0's state); the first line and where the browser was are enough.
        // Either may hold the claim URL, so neither leaves unscrubbed.
        const here = new URL(page.url())
        fail(secrets.scrub(`${(error as Error).message.split('\n')[0]} (the browser was at ${here.origin}${here.pathname})`))
      }
      return `claimed ${namespace} and landed on /${namespace}/ports in ${seconds(performance.now() - t0)}`
    })

    await run.step('after the claim, the same request with the same key still answers 2xx', async () => {
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
        if (registration.register.status !== 200) return 'nothing was registered, so nothing is left behind'
        if (!namespace) fail('register answered 200 but named no namespace, so nothing can be deleted')
        if (!claimed || !context) fail(`${namespace} was not claimed, so it cannot be deleted: it expires unclaimed at ${expiresAt}`)
        // The settings page's DELETE button posts this form. The browser would
        // then follow the redirect to /, whose loader creates "My First
        // Project" for a user left with no project, so the post is sent
        // without following it.
        const settings = `${env.console}/${namespace}/settings`
        const deleted = await context!.request.post(settings, { form: { intent: 'DELETE_PROJECT' }, maxRedirects: 0 })
        if (deleted.status() !== 302) fail(`POST /${namespace}/settings answered ${deleted.status()}, wanted 302 after the delete`)
        // fabric deletes on its event stream: the project leaves the Console a moment later.
        const t0 = performance.now()
        for (;;) {
          const page = await context!.request.get(`${env.console}/${namespace}/ports`, { maxRedirects: 0 })
          if (page.status() !== 200) return `deleted; /${namespace}/ports answers ${page.status()} after ${seconds(performance.now() - t0)}`
          if (performance.now() - t0 > 60_000) fail(`deleted, but /${namespace}/ports still answers 200 after 60 s`)
          await new Promise((resolve) => setTimeout(resolve, 3_000))
        }
      })
    }
    await browser?.close()
    await rm(dir, { recursive: true, force: true })
  }
}
