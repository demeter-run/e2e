import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { type APIRequestContext, request } from '@playwright/test'
import { Secrets } from '../src/agent/client.ts'
import { type ConsoleWaits, deleteClaimed } from '../src/agent/console.ts'
import { Failure } from '../src/report.ts'
import { type Served, serve } from './helpers.ts'

/**
 * J0's delete step against a stand-in Console: the settings form's action and
 * the project's ports page answer as a script says, so every answer the step
 * weighs is reached without production. The session is Playwright's request
 * API, as the browser context's is, with a session cookie of its own.
 */

// Under node:test, a `::add-mask::` line that `Secrets` prints reaches the job
// log as a `# ` diagnostic, which Actions does not read as a command: every
// throwaway credential a test makes would print in plain text. This file's
// process masks nothing; the test of the masking sets the variable itself.
delete process.env.GITHUB_ACTIONS

const COOKIE = 'stand-in-session-cookie-0123456789'
const NS = 'prj-stand-in-abc123'
const fast: ConsoleWaits = { landingMs: 300, deleteAttempts: 3, deleteEveryMs: 10, goneMs: 300, pageEveryMs: 10 }

/** What a route answers: a status, a redirect, or a connection reset with no answer. */
type Answer = number | { redirect: string } | 'reset'

/** A stand-in Console answering each route's script in order, the last answer repeating; it logs what it was asked. */
async function standIn(script: { ports?: Answer[]; settings?: Answer[] }) {
  const log: { method: string; path: string; cookie: string; body: string; answered: string }[] = []
  const at = { ports: 0, settings: 0 }
  const served = await serve(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const path = new URL(req.url ?? '/', 'http://x').pathname
    const route = req.method === 'GET' && path === `/${NS}/ports` ? 'ports' : req.method === 'POST' && path === `/${NS}/settings` ? 'settings' : undefined
    const list = route ? (script[route] ?? [404]) : [404]
    const answer = list[Math.min(route ? at[route]++ : 0, list.length - 1)]!
    log.push({
      method: req.method ?? '',
      path,
      cookie: req.headers.cookie ?? '',
      body: Buffer.concat(chunks).toString('utf8'),
      answered: typeof answer === 'object' ? `302 ${answer.redirect}` : String(answer),
    })
    if (answer === 'reset') req.socket.destroy()
    else if (typeof answer === 'object') res.writeHead(302, { location: answer.redirect }).end()
    else res.writeHead(answer, { 'content-type': 'text/html' }).end('<h1>stand-in</h1>')
  })
  return { ...served, log }
}

let session: APIRequestContext
let console_: Served & { log: { method: string; path: string; cookie: string; body: string; answered: string }[] }
const secrets = new Secrets()

before(async () => {
  session = await request.newContext({
    storageState: {
      cookies: [{ name: '__session', value: COOKIE, domain: '127.0.0.1', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' }],
      origins: [],
    },
  })
})
after(() => session.dispose())

/** The delete against a stand-in answering `script`: what it returned, or the failure's message. */
async function remove(script: { ports?: Answer[]; settings?: Answer[] }, landed = true): Promise<{ ok: boolean; detail: string }> {
  console_ = await standIn(script)
  try {
    const detail = await deleteClaimed({ console: console_.url, namespace: NS, expiresAt: '2026-10-27T12:00:00+00:00', user: 'e2e@txpipe.io', session, secrets, landed }, fast)
    return { ok: true, detail }
  } catch (error) {
    assert.ok(error instanceof Failure, `not a Failure: ${error}`)
    return { ok: false, detail: error.message }
  } finally {
    await console_.close()
  }
}

const asked = () => console_.log.map((c) => `${c.method} ${c.path} ${c.answered}`)

describe("J0's delete through the Console", () => {
  it('posts the settings form with the session, takes its redirect as the delete, and waits for two failed page loads', async () => {
    const { ok, detail } = await remove({ settings: [{ redirect: '/' }], ports: [500] })
    assert.ok(ok, detail)
    assert.match(detail, new RegExp(`^deleted \\(302 to /\\); /${NS}/ports answers 500 twice in a row after \\d+\\.\\d s$`))
    assert.deepEqual(asked(), [`POST /${NS}/settings 302 /`, `GET /${NS}/ports 500`, `GET /${NS}/ports 500`])
    const post = console_.log[0]!
    assert.equal(post.body, 'intent=DELETE_PROJECT')
    assert.match(post.cookie, new RegExp(`__session=${COOKIE}`))
    assert.deepEqual(secrets.find(COOKIE), ['session cookie'])
  })

  it('fails on a redirect to /login: the session was refused and the project stays', async () => {
    const { ok, detail } = await remove({ settings: [{ redirect: '/login?redirectTo=x' }], ports: [500] })
    assert.ok(!ok)
    assert.equal(detail, `POST /${NS}/settings redirected to /login: the Console refused the session, so ${NS} is still on e2e@txpipe.io's account`)
    assert.deepEqual(asked(), [`POST /${NS}/settings 302 /login?redirectTo=x`])
  })

  it('fails as unconfirmed when no post is redirected, even while the project page fails too, as in a fabric outage', async () => {
    const { ok, detail } = await remove({ settings: [500], ports: [500] })
    assert.ok(!ok)
    assert.equal(
      detail,
      `POST /${NS}/settings answered 500, then 500, then 500, never the redirect that follows a delete: the delete is unconfirmed, and ${NS} may still be on e2e@txpipe.io's account`,
    )
    assert.deepEqual(asked(), Array(3).fill(`POST /${NS}/settings 500`))
  })

  it('tries again after an error page or a lost answer, and counts the redirect that follows', async () => {
    const error = await remove({ settings: [200, { redirect: `/other-project/ports` }], ports: [500] })
    assert.ok(error.ok, error.detail)
    assert.match(error.detail, /^deleted \(302 to \/other-project\/ports on attempt 2\)/)
    const lost = await remove({ settings: ['reset', 'reset', { redirect: '/' }], ports: [500] })
    assert.ok(lost.ok, lost.detail)
    assert.match(lost.detail, /^deleted \(302 to \/ on attempt 3\)/)
  })

  it('fails on lost answers alone with one line that carries no cookie, whatever the call log held', async () => {
    const { ok, detail } = await remove({ settings: ['reset'] })
    assert.ok(!ok)
    assert.match(detail, new RegExp(`^POST /${NS}/settings answered no answer \\(apiRequestContext\\.post: .+?\\), then no answer`))
    assert.ok(!detail.includes('\n'), `more than one line: ${detail}`)
    assert.ok(!detail.includes(COOKIE), 'the detail carries the session cookie')
  })

  it('counts a lost page answer for neither side, and a 200 between failures as the project still there', async () => {
    const reset = await remove({ settings: [{ redirect: '/' }], ports: ['reset', 500, 'reset', 500] })
    assert.ok(reset.ok, reset.detail)
    assert.equal(asked().length, 5)
    const flicker = await remove({ settings: [{ redirect: '/' }], ports: [500, 200, 500, 500] })
    assert.ok(flicker.ok, flicker.detail)
    assert.equal(asked().length, 5, 'one failed page load between two that loaded was taken for the delete')
  })

  it('fails when the project page still loads, or redirects, after the delete', async () => {
    const loads = await remove({ settings: [{ redirect: '/' }], ports: [200] })
    assert.ok(!loads.ok)
    assert.match(loads.detail, new RegExp(`^deleted \\(302 to /\\), but /${NS}/ports still answered 200 after 0\\.3 s, so ${NS} may still be on e2e@txpipe.io's account$`))
    const moved = await remove({ settings: [{ redirect: '/' }], ports: [{ redirect: '/login' }] })
    assert.ok(!moved.ok)
    assert.equal(moved.detail, `deleted (302 to /), but /${NS}/ports then answered 302 to /login, so the session cannot confirm the project is gone`)
  })

  it('after a claim whose landing failed, deletes once the project page loads for the user', async () => {
    const { ok, detail } = await remove({ settings: [{ redirect: '/' }], ports: [404, 'reset', 200, 500, 500] }, false)
    assert.ok(ok, detail)
    assert.deepEqual(asked().slice(0, 4), [`GET /${NS}/ports 404`, `GET /${NS}/ports reset`, `GET /${NS}/ports 200`, `POST /${NS}/settings 302 /`])
  })

  it('after a claim whose landing failed, posts nothing and says where the project may be when its page never loads', async () => {
    const { ok, detail } = await remove({ settings: [{ redirect: '/' }], ports: [404] }, false)
    assert.ok(!ok)
    assert.equal(
      detail,
      `the claim was sent, but /${NS}/ports answered 404 for the next 0.3 s: if the claim went through, ${NS} is on e2e@txpipe.io's account and needs deleting by hand; if not, it expires unclaimed at 2026-10-27T12:00:00+00:00`,
    )
    assert.ok(asked().every((c) => c.startsWith('GET ')), 'it posted the delete')
  })
})
