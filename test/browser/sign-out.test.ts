import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { type Browser, chromium } from '@playwright/test'
import { environment } from '../../src/env.ts'
import { signOut } from '../../src/journeys/console.ts'
import { type Served, serve } from '../helpers.ts'

/**
 * The sign-out a journey ends on, against a stand-in Console and Auth0. The
 * Console's page is its sidebar's sign-out link on an app that has started
 * (`started` in `src/journeys/console.ts`). Its click does what Remix's router
 * does: it fetches `/logout`'s loader, whose answer is a redirect to Auth0,
 * and only then sends the browser to Auth0's `/v2/logout`, after the click has
 * returned. Auth0 answers as `logout` says: with a redirect back, or never.
 */

const consolePage = (auth0: string) => `<!doctype html>
<a href="/logout">Log out</a>
<script>
  window.__remixRouter = { state: { initialized: true, navigation: { state: 'idle' } } }
  history.scrollRestoration = 'manual'
  document.querySelector('a').addEventListener('click', async (e) => {
    e.preventDefault()
    await fetch('/logout?_data=routes%2Flogout')
    location.href = '${auth0}/v2/logout'
  })
</script>`

describe('signing out', () => {
  let browser: Browser
  let console_: Served
  let auth0: Served
  /** How Auth0's `/v2/logout` answers: a redirect back to the Console, or never. */
  let logout: 'redirect' | 'never' = 'redirect'

  before(async () => {
    browser = await chromium.launch()
    auth0 = await serve((req, res) => {
      if (req.url !== '/v2/logout') return void res.writeHead(404).end()
      if (logout === 'redirect') res.writeHead(302, { location: `${console_.url}/signed-out` }).end()
    })
    console_ = await serve((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' }).end(req.url === '/' ? consolePage(auth0.url) : '<!doctype html><p>signed out</p>')
    })
  })
  after(async () => {
    await browser.close()
    await Promise.all([console_.close(), auth0.close()])
  })

  const env = () => ({ ...environment('production'), console: console_.url, auth0: auth0.url })

  it('follows Auth0 back to where it sends a signed-out browser', async () => {
    logout = 'redirect'
    const page = await browser.newPage()
    try {
      await page.goto(`${console_.url}/`)
      assert.equal(await signOut(page, env(), 5_000), `signed out through Auth0's /v2/logout, now on ${console_.url}/signed-out`)
    } finally {
      await page.close()
    }
  })

  // A request whose answer never comes would hold the clean slate until J2's
  // 100-minute test timeout.
  it('fails within its limit when Auth0 never answers', { timeout: 30_000 }, async () => {
    logout = 'never'
    const page = await browser.newPage()
    try {
      await page.goto(`${console_.url}/`)
      const t0 = performance.now()
      await assert.rejects(signOut(page, env(), 3_000), { message: "Auth0's /v2/logout answered nothing, wanted a redirect out of the tenant" })
      assert.ok(performance.now() - t0 < 10_000, `${Math.round(performance.now() - t0)} ms`)
    } finally {
      await page.close()
    }
  })
})
