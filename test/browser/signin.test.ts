import assert from 'node:assert/strict'
import type { IncomingMessage } from 'node:http'
import { after, before, describe, it } from 'node:test'
import { type Browser, chromium } from '@playwright/test'
import { signIn as signInPage } from '../../src/mock/pages.ts'
import { signIn } from '../../src/signin.ts'
import { type Served, serve } from '../helpers.ts'

/**
 * The sign-in form filler in Chromium against stand-in forms: Auth0's two
 * screens (identifier first, then the password), and forms on an origin
 * other than the environment's sign-in, which must receive nothing.
 */

const PASSWORD = 'stand-in-password-0123456789'

let browser: Browser
before(async () => {
  browser = await chromium.launch()
})
after(() => browser.close())

const text = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

const html = (body: string) => `<!doctype html><html><head><link rel="icon" href="data:,"></head><body>${body}</body></html>`
const identifierScreen = html(
  '<form method="post"><input id="username" name="username"><button type="submit" name="action" value="default">Continue</button></form>',
)
const passwordScreen = html(
  '<form method="post"><input id="username" name="username" value="e2e@txpipe.io" readonly><input type="password" id="password" name="password"><button type="submit" name="action" value="default">Continue</button></form>',
)

/**
 * Auth0's identifier-first prompt: `/u/login/identifier`, then the password
 * on `/u/login/password` at `passwordOrigin` (its own by default), then out.
 */
async function auth0(posts: string[], passwordOrigin?: () => string): Promise<Served> {
  const served: Served = await serve(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    if (req.method === 'POST') {
      posts.push(`${path} ${await text(req)}`)
      const next = path === '/u/login/identifier' ? `${passwordOrigin?.() ?? ''}/u/login/password` : '/signed-in'
      return res.writeHead(302, { location: next }).end()
    }
    const page = path === '/u/login/identifier' ? identifierScreen : path === '/u/login/password' ? passwordScreen : html('<h1>signed in</h1>')
    res.writeHead(200, { 'content-type': 'text/html' }).end(page)
  })
  return served
}

/** The same server under another origin: `localhost` for `127.0.0.1`. */
const elsewhere = (url: string) => url.replace('127.0.0.1', 'localhost')

describe('signIn in the browser', () => {
  it("fills Auth0's identifier-first prompt: the user name, then the password on its second screen", async () => {
    const posts: string[] = []
    const form = await auth0(posts)
    const page = await browser.newPage()
    try {
      await page.goto(`${form.url}/u/login/identifier?state=abc`)
      await signIn(page, 'e2e@txpipe.io', PASSWORD, { origin: form.url, timeoutMs: 3_000 })
      assert.equal(new URL(page.url()).pathname, '/signed-in')
      assert.deepEqual(posts, [
        '/u/login/identifier username=e2e%40txpipe.io&action=default',
        `/u/login/password username=e2e%40txpipe.io&password=${PASSWORD}&action=default`,
      ])
    } finally {
      await page.close()
      await form.close()
    }
  })

  it('types nothing into a form on another origin than the sign-in', async () => {
    const posts: string[] = []
    const form = await serve(async (req, res) => {
      if (req.method === 'POST') posts.push(await text(req))
      res.writeHead(200, { 'content-type': 'text/html' }).end(signInPage())
    })
    const page = await browser.newPage()
    try {
      await page.goto(`${elsewhere(form.url)}/login`)
      await assert.rejects(signIn(page, 'e2e@txpipe.io', PASSWORD, { origin: form.url, timeoutMs: 3_000 }), {
        message: `the sign-in form is on ${elsewhere(form.url)}, not ${form.url}, so nothing was typed into it`,
      })
      assert.deepEqual([await page.locator('#username').inputValue(), await page.locator('#password').inputValue()], ['', ''])
      assert.deepEqual(posts, [])
    } finally {
      await page.close()
      await form.close()
    }
  })

  it('types no password when the second screen moves to another origin', async () => {
    const posts: string[] = []
    let self = ''
    const form = await auth0(posts, () => elsewhere(self))
    self = form.url
    const page = await browser.newPage()
    try {
      await page.goto(`${form.url}/u/login/identifier`)
      await assert.rejects(signIn(page, 'e2e@txpipe.io', PASSWORD, { origin: form.url, timeoutMs: 3_000 }), {
        message: `the sign-in form is on ${elsewhere(form.url)}, not ${form.url}, so nothing was typed into it`,
      })
      assert.equal(await page.locator('#password').inputValue(), '')
      assert.deepEqual(posts, ['/u/login/identifier username=e2e%40txpipe.io&action=default'])
    } finally {
      await page.close()
      await form.close()
    }
  })

  it('names where it is and what the form says when the sign-in does not take, never what was typed', async () => {
    const form = await serve(async (req, res) => {
      if (req.method === 'POST') await text(req)
      res.writeHead(200, { 'content-type': 'text/html' }).end(signInPage(req.method === 'POST' ? 'Wrong email or password' : undefined))
    })
    const page = await browser.newPage()
    try {
      await page.goto(`${form.url}/login`)
      const error = await signIn(page, 'e2e@txpipe.io', PASSWORD, { origin: form.url, timeoutMs: 1_000 }).then(
        () => assert.fail('signed in'),
        (e: Error) => e.message,
      )
      assert.equal(error, `still on the sign-in form at ${form.url}/login after 1 s, which says "Wrong email or password"`)
    } finally {
      await page.close()
      await form.close()
    }
  })
})
