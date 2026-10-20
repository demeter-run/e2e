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
 * returned. Or, as `/?at-once` (the fetch done sooner than the click returns),
 * it sends the browser on before the click returns. As `/?misses=<n>`, its
 * first n clicks go nowhere, as two of eleven did on 2026-10-20. Auth0
 * answers as `logout` says: with a redirect back, to a page on the Console's
 * origin that answers a second later, or never.
 */

const consolePage = (auth0: string, atOnce: boolean, misses: number) => `<!doctype html>
<a href="/logout">Log out</a>
<script>
  window.__remixRouter = { state: { initialized: true, navigation: { state: 'idle' } } }
  history.scrollRestoration = 'manual'
  let clicks = 0
  document.querySelector('a').addEventListener('click', async (e) => {
    e.preventDefault()
    if ((clicks += 1) <= ${misses}) return
    ${atOnce ? '' : "await fetch('/logout?_data=routes%2Flogout')"}
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
      const url = new URL(req.url ?? '/', console_.url)
      if (url.pathname === '/') {
        const page = consolePage(auth0.url, url.searchParams.has('at-once'), Number(url.searchParams.get('misses') ?? 0))
        return void res.writeHead(200, { 'content-type': 'text/html' }).end(page)
      }
      // Slower than the page it came from, which a wait for the origin alone would take for it.
      setTimeout(() => res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><p>signed out</p>'), 1_000)
    })
  })
  after(async () => {
    await browser.close()
    await Promise.all([console_.close(), auth0.close()])
  })

  const env = () => ({ ...environment('production'), console: console_.url, auth0: auth0.url })

  for (const [how, path] of [['after a fetch', '/'], ['at once', '/?at-once']] as const) {
    it(`follows Auth0 back to where it sends a signed-out browser, when the link navigates ${how}`, async () => {
      logout = 'redirect'
      const page = await browser.newPage()
      try {
        await page.goto(`${console_.url}${path}`)
        assert.equal(await signOut(page, env(), 5_000), `signed out through Auth0's /v2/logout, now on ${console_.url}/signed-out`)
      } finally {
        await page.close()
      }
    })

    // A request whose answer never comes would hold the clean slate until J2's
    // 100-minute test timeout. A click left waiting for the navigation it
    // starts would fail the step after the runner's 30-second action limit
    // (playwright.config.ts) instead of saying that Auth0 never answered.
    it(`fails within its limit when Auth0 never answers, and the link navigates ${how}`, { timeout: 30_000 }, async () => {
      logout = 'never'
      const page = await browser.newPage()
      try {
        await page.goto(`${console_.url}${path}`)
        const t0 = performance.now()
        await assert.rejects(signOut(page, env(), 3_000), { message: "Auth0's /v2/logout answered nothing, wanted a redirect out of the tenant" })
        assert.ok(performance.now() - t0 < 10_000, `${Math.round(performance.now() - t0)} ms`)
      } finally {
        await page.close()
      }
    })
  }

  it('clicks once more when the first click goes nowhere, and says what that click left', { timeout: 30_000 }, async () => {
    logout = 'redirect'
    const page = await browser.newPage()
    try {
      await page.goto(`${console_.url}/?misses=1`)
      const t0 = performance.now()
      const said = await signOut(page, env(), 4_000)
      assert.match(
        said,
        /^signed out through Auth0's \/v2\/logout on the second click \(click 1: nothing within 2 s, still on .+, the router idle, the click requested nothing from the Console or Auth0, the page logged no error\), now on http:\/\/127\.0\.0\.1:\d+\/signed-out$/,
      )
      // The first click's wait ended at its limit, half the sign-out's.
      const ms = performance.now() - t0
      assert.ok(ms >= 2_000 && ms < 10_000, `${Math.round(ms)} ms`)
    } finally {
      await page.close()
    }
  })

  it('fails within its limit when no click goes anywhere, naming both', { timeout: 30_000 }, async () => {
    logout = 'redirect'
    const page = await browser.newPage()
    try {
      await page.goto(`${console_.url}/?misses=2`)
      const t0 = performance.now()
      await assert.rejects(signOut(page, env(), 3_000), (error: Error) => {
        assert.match(error.message, /^the sign-out link sent the browser to no http:\/\/127\.0\.0\.1:\d+\/v2\/logout; click 1: nothing within 1\.5 s, .+; click 2: nothing within 1\.5 s, /)
        return true
      })
      assert.ok(performance.now() - t0 < 10_000, `${Math.round(performance.now() - t0)} ms`)
    } finally {
      await page.close()
    }
  })
})
