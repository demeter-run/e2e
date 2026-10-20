import type { APIRequestContext } from '@playwright/test'
import { Failure } from '../report.ts'
import type { Secrets } from './client.ts'

/**
 * What J0 asks the Console as the test user, outside the browser but with its
 * session: whether a claimed project's page loads for the user, and the
 * delete that removes the project after the run (umbrella ruling 3).
 *
 * A Playwright request error carries a call log with the request's headers,
 * the `cookie:` one among them: what reaches a step is its first line,
 * scrubbed, with the session's cookies registered in `Secrets` first.
 */

/** How long the Console steps wait, and how often they try again; the tests shorten them. */
export interface ConsoleWaits {
  /** For the project's page to load for the user after the claim: fabric's projection may lag it. */
  landingMs: number
  /** Delete posts, at most, and the wait between them. */
  deleteAttempts: number
  deleteEveryMs: number
  /** For the project's page to stop loading after the delete. */
  goneMs: number
  /** Between looks at the project's page. */
  pageEveryMs: number
}

export const consoleWaits: ConsoleWaits = { landingMs: 30_000, deleteAttempts: 3, deleteEveryMs: 5_000, goneMs: 60_000, pageEveryMs: 3_000 }

const fail = (message: string): never => {
  throw new Failure(message)
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`

const isRedirect = (status: number | null) => status !== null && status >= 300 && status < 400

/** Anything that holds the session's cookies: the browser context, or its request API. */
interface CookieJar {
  storageState(): Promise<{ cookies: { value: string }[] }>
}

/** The session's cookies, into `Secrets`. Short values (flags, `Lax`) are not credentials. */
export async function addCookieSecrets(jar: CookieJar, secrets: Secrets): Promise<void> {
  for (const cookie of (await jar.storageState()).cookies) if (cookie.value.length >= 16) secrets.add('session cookie', cookie.value)
}

/** The first line of a Playwright error, scrubbed: the rest is its call log, which carries the request headers. */
export const firstLine = (secrets: Secrets, error: unknown): string =>
  secrets.scrub((error instanceof Error ? error.message : String(error)).split('\n')[0]!)

/** How one page answered the session: its status, where it redirected, or why nothing answered. */
export interface PageAnswer {
  status: number | null
  /** The redirect's path, for a 3xx. */
  location: string
  /** Why nothing answered, scrubbed. */
  error?: string
}

/** An answer as a step may print it. */
export const said = (answer: PageAnswer): string =>
  answer.status === null ? `no answer (${answer.error})` : `${answer.status}${answer.location ? ` to ${answer.location}` : ''}`

/** `GET url` with the session, never following a redirect and never throwing: a lost answer is an answer too. */
export async function pageAnswer(session: APIRequestContext, url: string, secrets: Secrets): Promise<PageAnswer> {
  try {
    const answer = await session.get(url, { maxRedirects: 0, timeout: 30_000 })
    const location = isRedirect(answer.status()) ? new URL(answer.headers().location ?? '/', url).pathname : ''
    return { status: answer.status(), location }
  } catch (error) {
    return { status: null, location: '', error: firstLine(secrets, error) }
  }
}

/**
 * Looks at `url` with the session until it answers 200, `everyMs` apart for
 * `withinMs`, and returns the last answer: 200, or what it answered instead.
 * Nothing but a 200 counts as the page loading, a redirect included.
 */
export async function pageLoads(session: APIRequestContext, url: string, secrets: Secrets, withinMs: number, everyMs: number): Promise<PageAnswer> {
  const t0 = performance.now()
  for (;;) {
    const page = await pageAnswer(session, url, secrets)
    if (page.status === 200 || performance.now() - t0 > withinMs) return page
    await sleep(everyMs)
  }
}

export interface Claimed {
  /** The Console's origin. */
  console: string
  namespace: string
  /** When the project expires if nobody owns it. */
  expiresAt: string
  /** Who claimed it. */
  user: string
  /** The user's session: the browser context's request API. */
  session: APIRequestContext
  secrets: Secrets
  /** Whether the claim landed on the project's page and that page answered the user 200. */
  landed: boolean
}

/**
 * Deletes a claimed project through the Console, as its settings page's
 * DELETE button does, and waits for it to leave. Returns what happened, or
 * fails naming the project and whether it may still be on the user's account.
 */
export async function deleteClaimed(claimed: Claimed, waits: ConsoleWaits = consoleWaits): Promise<string> {
  const { namespace, user } = claimed
  try {
    return await deleteOnce(claimed, waits)
  } catch (error) {
    if (error instanceof Failure) throw error
    return fail(`${firstLine(claimed.secrets, error)}: the delete stopped, and ${namespace} may still be on ${user}'s account`)
  }
}

async function deleteOnce({ console: origin, namespace, expiresAt, user, session, secrets, landed }: Claimed, waits: ConsoleWaits): Promise<string> {
  await addCookieSecrets(session, secrets).catch(() => {})
  const portsPage = `${origin}/${namespace}/ports`
  const look = () => pageAnswer(session, portsPage, secrets)

  // The project must be the user's to be deleted. A claim whose landing
  // failed may still have gone through: it gets the landing's time again.
  if (!landed) {
    const page = await pageLoads(session, portsPage, secrets, waits.landingMs, waits.pageEveryMs)
    if (page.status !== 200) {
      fail(
        `the claim was sent, but /${namespace}/ports answered ${said(page)} for the next ${seconds(waits.landingMs)}: if the claim went through, ${namespace} is on ${user}'s account and needs deleting by hand; if not, it expires unclaimed at ${expiresAt}`,
      )
    }
  }

  // fabric deletes on its event stream: the project leaves the Console a
  // moment later, and its pages stop loading (fabric no longer knows the
  // namespace, and the Console answers 500). Two such answers in a row, so
  // one passing error is not taken for the delete; a lost answer counts for
  // neither.
  const gone = async (accepted: string): Promise<string> => {
    const t0 = performance.now()
    let failed = 0
    for (;;) {
      const page = await look()
      if (isRedirect(page.status)) {
        fail(`deleted (${accepted}), but /${namespace}/ports then answered ${said(page)}, so the session cannot confirm the project is gone`)
      }
      if (page.status === 200) failed = 0
      else if (page.status !== null) failed += 1
      if (failed === 2) return `deleted (${accepted}); /${namespace}/ports answers ${page.status} twice in a row after ${seconds(performance.now() - t0)}`
      if (performance.now() - t0 > waits.goneMs) {
        fail(`deleted (${accepted}), but /${namespace}/ports still answered ${said(page)} after ${seconds(waits.goneMs)}, so ${namespace} may still be on ${user}'s account`)
      }
      await sleep(waits.pageEveryMs)
    }
  }

  // The settings page's DELETE button posts this form. Its action answers a
  // redirect once fabric has taken the delete: to the user's next project, or
  // to /, whose loader creates "My First Project" for a user left with none,
  // so the redirect is not followed. A redirect to /login means the session
  // was refused. Nothing else counts as the delete: a 200 is the action
  // reporting an error, a 5xx one of its own (fabric's projection may lag the
  // claim, or fabric be down, when the project's page fails too), and a lost
  // answer says nothing. Nor does a redirect back into the project: after an
  // action that reported an error, the settings loader runs again and sends a
  // user who is not the owner to the project's ports, while the action's own
  // redirect leaves the deleted project out. Each is tried again, and the
  // last one fails the step.
  const settings = `${origin}/${namespace}/settings`
  const answers: string[] = []
  for (let attempt = 1; attempt <= waits.deleteAttempts; attempt++) {
    try {
      const answer = await session.post(settings, { form: { intent: 'DELETE_PROJECT' }, maxRedirects: 0, timeout: 30_000 })
      const to = isRedirect(answer.status()) ? new URL(answer.headers().location ?? '/', settings).pathname : ''
      if (to.startsWith('/login')) {
        fail(`POST /${namespace}/settings redirected to ${to}: the Console refused the session, so ${namespace} is still on ${user}'s account`)
      }
      const intoProject = to === `/${namespace}` || to.startsWith(`/${namespace}/`)
      if (to && !intoProject) return await gone(`${answer.status()} to ${to}${attempt > 1 ? ` on attempt ${attempt}` : ''}`)
      answers.push(intoProject ? `${answer.status()} back to ${to}` : String(answer.status()))
    } catch (error) {
      if (error instanceof Failure) throw error
      answers.push(`no answer (${firstLine(secrets, error)})`)
    }
    if (attempt < waits.deleteAttempts) await sleep(waits.deleteEveryMs)
  }
  return fail(
    `POST /${namespace}/settings answered ${answers.join(', then ')}, never the redirect that follows a delete: the delete is unconfirmed, and ${namespace} may still be on ${user}'s account`,
  )
}
