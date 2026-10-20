import type { Page } from '@playwright/test'

/** The standing test user every journey that signs in signs in as (decision 0047). */
export const TEST_USER = 'e2e@txpipe.io'

/**
 * Fills the sign-in form the browser is on and submits it: Auth0's New
 * Universal Login, read from the live tenant on 2026-10-19 (`/u/login`, a
 * `#username` and a `#password` field and a "Continue" submit), or the
 * agent-route mock's copy of it. An identifier-first prompt, which asks for
 * the password on a second screen, is filled the same way.
 *
 * Nothing is typed unless the form is on `origin`, the environment's sign-in
 * (`env.auth0`): a page elsewhere never receives the user name or the
 * password.
 *
 * Returns once the browser has left the form. When it stays, the error names
 * where it is and what the form says, never what was typed. Traces and
 * screenshots are off (`playwright.config.ts`), so the password reaches no
 * file.
 */
export async function signIn(page: Page, user: string, password: string, { origin, timeoutMs = 30_000 }: { origin: string; timeoutMs?: number }): Promise<void> {
  const username = page.locator('#username')
  const secret = page.locator('#password')
  const submit = page.locator('button[type="submit"][name="action"][value="default"]')
  const expected = new URL(origin).origin
  const onSignIn = () => {
    const here = new URL(page.url())
    if (here.origin !== expected) throw new Error(`the sign-in form is on ${here.origin}, not ${expected}, so nothing was typed into it`)
  }
  await username.waitFor({ timeout: timeoutMs })
  onSignIn()
  const form = new URL(page.url())
  // Auth0's screens all sit under /u/login (/u/login/password on an
  // identifier-first prompt); the mock's form is /login.
  const formPath = form.pathname.startsWith('/u/login') ? '/u/login' : form.pathname

  await username.fill(user)
  if (!(await secret.isVisible())) {
    await submit.click()
    await secret.waitFor({ timeout: timeoutMs })
    onSignIn()
  }
  await secret.fill(password)
  await submit.click()

  try {
    await page.waitForURL((url) => url.origin !== form.origin || !url.pathname.startsWith(formPath), { timeout: timeoutMs })
  } catch {
    const alert = (await page.locator('[role="alert"], #error-element-password, #error-element-username').allInnerTexts())
      .map((t) => t.trim())
      .filter(Boolean)
      .join(' ')
    const here = new URL(page.url())
    throw new Error(
      `still on the sign-in form at ${here.origin}${here.pathname} after ${timeoutMs / 1000} s${alert ? `, which says "${alert}"` : ', with no error shown'}`,
    )
  }
}
