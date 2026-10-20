import type { BrowserContext, Page } from '@playwright/test'
import type { Environment } from '../env.ts'
import { safeUrl } from '../http.ts'
import { Failure } from '../report.ts'
import { arrives } from './browser.ts'

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

/** Waits for the browser to land on a project's ports page, and returns that project's namespace. */
export async function landOnPorts(page: Page, env: Environment, timeoutMs = 60_000): Promise<string> {
  const url = await arrives(
    page,
    (u) => u.origin === env.console && /^\/[^/]+\/ports$/.test(u.pathname),
    `a project's ports page on ${env.console}`,
    timeoutMs,
  )
  return projectOf(url)!
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
export async function deleteProjects(context: BrowserContext, env: Environment, first: string): Promise<string[]> {
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
 * Signs out through the Console's `/logout`, which clears its session and then
 * Auth0's (`routes/logout.tsx`, `routes/logout.auth0.tsx`), and checks that
 * the Console's cookie is gone.
 */
export async function signOut(page: Page, env: Environment): Promise<string> {
  await page.goto(`${env.console}/logout`, { waitUntil: 'load', timeout: 60_000 })
  const left = (await page.context().cookies(env.console)).filter((c) => c.name === sessionCookie)
  if (left.length) throw new Failure(`the browser still sends ${sessionCookie} to ${env.console} after /logout (now on ${safeUrl(page.url())})`)
  return `signed out, now on ${safeUrl(page.url())}`
}
