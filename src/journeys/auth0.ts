import type { Page, Request } from '@playwright/test'
import { auth0Screens } from '../checks/intent.ts'
import type { Environment } from '../env.ts'
import { safeUrl } from '../http.ts'
import { Failure } from '../report.ts'
import { keepSecret } from '../secrets.ts'
import { firstLine, visible, where } from './browser.ts'

/**
 * Signing in on Auth0's New Universal Login, as the standing test user
 * (decision 0047). The screens were read from the live tenant on 2026-10-19:
 * `/u/login` has `#username` ("Email address"), `#password` and a "Continue"
 * button (beside "Continue with Google" and "Continue with GitHub"); `/u/signup`
 * links to it with "Log in".
 *
 * A challenge, an MFA prompt or a refused login fails naming what Auth0
 * showed, never what was typed.
 */

export interface TestUser {
  email: string
  password: string
}

/** The environment's test user, with its password from `E2E_USER_PASSWORD` kept secret. */
export function testUser(env: Environment): TestUser {
  if (!env.testUser) throw new Failure(`the ${env.name} environment has no test user to sign in as`)
  const password = process.env.E2E_USER_PASSWORD
  if (!password) throw new Failure(`E2E_USER_PASSWORD is not set: it holds ${env.testUser}'s password`)
  return { email: env.testUser, password: keepSecret(password) }
}

const onTenant = (env: Environment, url: URL) => url.origin === env.auth0

/** Something a scripted login cannot pass, as Auth0 renders it. */
const challenges = [
  '[data-captcha-provider]',
  '[data-captcha-sitekey]',
  'iframe[src*="captcha" i]',
  'iframe[title*="captcha" i]',
  'iframe[src*="challenges.cloudflare.com"]',
].join(', ')

/**
 * What Auth0 shows instead of letting the user through: a challenge, an MFA
 * screen, the error messages on the form, and the screen itself.
 */
export async function auth0Refusal(page: Page): Promise<string> {
  const url = new URL(page.url())
  const seen: string[] = []
  if (url.pathname.startsWith('/u/mfa')) seen.push('an MFA prompt')
  if ((await page.locator(challenges).count()) > 0) seen.push('a CAPTCHA')
  const errors = await page.locator('[id^="error-element"], [role="alert"], .ulp-input-error-message, #prompt-alert').allInnerTexts()
  const messages = [...new Set(errors.map((e) => e.trim()).filter(Boolean))]
  if (messages.length) seen.push(`the message${messages.length === 1 ? '' : 's'} ${messages.map((m) => `"${m}"`).join(', ')}`)
  const heading = (await page.locator('h1').first().innerText({ timeout: 2_000 }).catch(() => '')).trim()
  return `Auth0 kept the browser on ${await where(page)}${heading ? `, heading "${heading}"` : ''}${seen.length ? `, showing ${seen.join(' and ')}` : ''}`
}

/**
 * Signs in on Auth0's login screen, where `page` has arrived, and returns once
 * the browser has left the tenant. A browser Auth0 already holds a session for
 * is redirected straight back without a form; that counts as signed in too.
 *
 * A page load that never answers (the Console's callback, it seems, in
 * sign-in proof run 39414682199) held Playwright's click, which waits for the
 * page it loads with no limit under the test runner, until the test timed
 * out. The click no longer waits, so `timeoutMs` bounds it. The pending load
 * also leaves the page unreadable, so reading what Auth0 showed gives up
 * after 10 s and names that page load instead.
 */
export async function signIn(page: Page, env: Environment, user: TestUser, timeoutMs = 60_000): Promise<'form' | 'session'> {
  const url = new URL(page.url())
  if (!onTenant(env, url)) return 'session'
  if (url.pathname !== auth0Screens.login.path) throw new Failure(await auth0Refusal(page))
  await (await visible(page, page.locator('#username'), 'email field')).fill(user.email)
  await (await visible(page, page.locator('#password'), 'password field')).fill(user.password)
  let loading = ''
  const onRequest = (r: Request) => {
    if (r.isNavigationRequest() && r.frame() === page.mainFrame()) loading = safeUrl(r.url())
  }
  page.on('request', onRequest)
  try {
    await page.getByRole('button', { name: 'Continue', exact: true }).click({ noWaitAfter: true })
    try {
      await page.waitForURL((u) => !onTenant(env, u), { timeout: timeoutMs, waitUntil: 'commit' })
    } catch {
      const stalled = `no page answered within ${timeoutMs / 1000} s of "Continue"; the browser was still loading ${loading || 'nothing'}`
      const read = auth0Refusal(page).catch((error) => `${stalled} (${firstLine(error)})`)
      throw new Failure(await Promise.race([read, new Promise<string>((resolve) => setTimeout(() => resolve(stalled), 10_000))]))
    }
  } finally {
    page.off('request', onRequest)
  }
  return 'form'
}
