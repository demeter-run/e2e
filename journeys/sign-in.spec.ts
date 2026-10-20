import { test } from '@playwright/test'
import { Failure, Run } from '../src/report.ts'
import { auth0Screens } from '../src/checks/intent.ts'
import { signIn, testUser } from '../src/journeys/auth0.ts'
import { deleteProjects, landOnPorts, signOut } from '../src/journeys/console.ts'
import { browserSteps, journeyEnvironment, NotRun, report, verdict } from '../src/journeys/spec.ts'

/**
 * The sign-in proof: before J2 is built on it, the standing test user signs in
 * to the Console from a GitHub runner, as a person does, through Auth0's form.
 * A CAPTCHA, an MFA prompt or a refused login fails the sign-in step naming
 * what Auth0 showed.
 *
 * Signing in lands on `/`, which creates "My First Project" for a user with
 * none, so the proof deletes every project the user owns before it signs out.
 */

const env = journeyEnvironment()

test.afterAll(verdict)

test('sign-in', async ({ browser }) => {
  test.setTimeout(5 * 60_000)
  const run = new Run('sign-in', env.name)
  const context = await browser.newContext()
  const page = await context.newPage()
  let namespace: string | undefined
  const step = browserSteps(run, () => page, (p) => [p.locator('input[type="password"]')])

  try {
    await step(`${env.console}/login shows Auth0's login form`, async () => {
      await page.goto(`${env.console}/login`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      const url = new URL(page.url())
      if (url.origin !== env.auth0 || url.pathname !== auth0Screens.login.path) {
        throw new Failure(`landed on ${url.origin}${url.pathname}, wanted ${env.auth0}${auth0Screens.login.path}`)
      }
      return `${url.origin}${url.pathname}`
    })
    const user = testUser(env)
    const signedIn = await step(`sign in as ${user.email}`, async () => `through the ${await signIn(page, env, user)}`)
    await step("land on a project's ports page", async () => {
      if (!signedIn) throw new NotRun('the sign-in failed')
      namespace = await landOnPorts(page, env)
      return `/${namespace}/ports`
    })
    await step('delete every project the user owns', async () => {
      if (!namespace) throw new NotRun('no project page was reached')
      const deleted = await deleteProjects(context, env, namespace)
      return `deleted ${deleted.length}: ${deleted.join(', ')}; the Console then names no project`
    })
    await step('sign out', async () => {
      if (!signedIn) throw new NotRun('never signed in')
      return signOut(page, env)
    })
  } finally {
    await report(run)
    await context.close()
  }
})
