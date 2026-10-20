import type { IncomingMessage, ServerResponse } from 'node:http'
import { request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { type Mock, startMock } from '../../src/mock/server.ts'
import { type Served, serve } from '../helpers.ts'

/**
 * A stand-in Console for J0's browser steps: the agent-route mock behind a
 * proxy that adds what production has and the mock lacks (the settings
 * form's delete, and a deleted project's page answering 500), and breaks
 * one thing on request, the way production could.
 */

export interface Breaks {
  /** `GET /claim/<token>` answers 500: on its first load, or on the load after the sign-in. */
  claimPage?: 'first' | 'signed-in'
  /** `GET /claim/<token>` never answers. */
  hangClaimPage?: boolean
  /**
   * The claim form's project name is emptied as the page finishes loading,
   * by a script that delays its `load`, as production's hydration does. The
   * signed-in claim page first comes as a page that reloads itself by
   * script, as a sign-in callback may, so the sign-in's own wait for a page
   * load ends before the claim form's page loads.
   */
  hydrationEmptiesName?: boolean
  /** The claim's post never reaches the mock: it is redirected to the project's page, which answers 500 as it does to a user who does not own it. */
  claimLost?: boolean
  /**
   * The claim form posts by fetch, as production's hydrated form does, and
   * the post answers 500 with the Console's error, which the page shows: a
   * claim fabric refused. The browser stays on the claim page.
   */
  claimRefused?: boolean
  /**
   * The claim form posts as a page load, as production's does before it has
   * hydrated, and the post answers a 500 page, which the browser shows on
   * the claim's path.
   */
  claimErrorPage?: boolean
  /** Before the claim, the project's page answers the user 200: register named a project the user already owns. */
  alreadyOwned?: boolean
  /** Before the claim, a request for the project's page from outside the browser gets a reset. */
  resetBeforeClaim?: boolean
  /** How many requests for the project's page from outside the browser, once the claim is posted, get a reset, from the first. */
  resetChecks?: number
}

export interface StandIn extends Served {
  /** The calls the proxy answered itself, or held: `POST /<ns>/settings <body>`, `GET /claim held`, `POST /login <body>`. */
  readonly log: string[]
  /** The mock's session cookie, once the sign-in set it. */
  readonly sessionCookie: string
  /** Whether the claim was posted, by any means. */
  readonly claimPosted: boolean
  mock: Mock
}

const text = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

export async function standIn(breaks: Breaks = {}): Promise<StandIn> {
  const log: string[] = []
  const deleted = new Set<string>()
  const held: ServerResponse[] = []
  let namespace = ''
  let sessionCookie = ''
  let claimLoads = 0
  let checks = 0
  let lost = false
  let claimPosted = false
  let upstream = ''

  /** Forwards to the mock, rewriting its body when asked; the mock's headers (two Set-Cookie among them) go back as they came. */
  const forward = (req: IncomingMessage, res: ServerResponse, rewrite?: (body: string) => string, sent?: string) => {
    const up = httpRequest(`${upstream}${req.url}`, { method: req.method, headers: req.headers, agent: false }, (answer) => {
      const cookie = /mock_session=([^;]+)/.exec([answer.headers['set-cookie'] ?? []].flat().join('\n'))?.[1]
      if (cookie) sessionCookie = cookie
      if (!rewrite) {
        res.writeHead(answer.statusCode ?? 502, answer.headers)
        answer.pipe(res)
        return
      }
      const chunks: Buffer[] = []
      answer.on('data', (chunk: Buffer) => chunks.push(chunk))
      answer.on('end', () => {
        const body = rewrite(Buffer.concat(chunks).toString('utf8'))
        const { 'content-length': _length, 'transfer-encoding': _chunked, ...headers } = answer.headers
        res.writeHead(answer.statusCode ?? 502, { ...headers, 'content-length': String(Buffer.byteLength(body)) }).end(body)
      })
    })
    up.on('error', () => res.destroy())
    if (sent === undefined) req.pipe(up)
    else up.end(sent)
  }

  /** Scripts the claim form's page gets, on the load where it has the form. */
  const scripts = [
    breaks.hydrationEmptiesName ? '<script async src="/__standin/hydrate.js"></script>' : '',
    breaks.claimRefused
      ? `<script>
document.querySelector('form').addEventListener('submit', async (event) => {
  event.preventDefault()
  const answer = await fetch(event.target.action + '?_data=routes%2Fclaim.%24token', { method: 'POST', body: new URLSearchParams(new FormData(event.target)) })
  const alert = document.createElement('p')
  alert.setAttribute('role', 'alert')
  alert.textContent = (await answer.json()).error
  event.target.append(alert)
})
</script>`
      : '',
  ].join('')

  const served = await serve(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    const settings = /^\/([a-z0-9-]+)\/settings$/.exec(path)
    const ports = /^\/([a-z0-9-]+)\/ports$/.exec(path)
    const claim = /^\/claim\/[^/]+$/.test(path)
    const page = (status: number) => res.writeHead(status, { 'content-type': 'text/html' }).end(`<h1>${status}</h1>`)
    if (claim && req.method === 'POST') claimPosted = true

    if (settings && req.method === 'POST') {
      const body = await text(req)
      log.push(`POST /<ns>/settings ${body}`)
      if (body !== 'intent=DELETE_PROJECT') return page(200)
      deleted.add(settings[1]!)
      return res.writeHead(302, { location: '/' }).end()
    }
    if (ports && req.method === 'GET') {
      if (deleted.has(ports[1]!) || lost) return page(500)
      if (breaks.alreadyOwned && !claimPosted) return page(200)
      // Chromium marks its navigations; Playwright's request API does not.
      const outside = req.headers['sec-fetch-mode'] !== 'navigate'
      if (outside && !claimPosted && breaks.resetBeforeClaim) return req.socket.destroy()
      if (outside && claimPosted && checks++ < (breaks.resetChecks ?? 0)) return req.socket.destroy()
    }
    if (path === '/__standin/hydrate.js') {
      // Late enough that the button shows well before the page's load.
      await new Promise((resolve) => setTimeout(resolve, 500))
      return res.writeHead(200, { 'content-type': 'text/javascript' }).end(`document.querySelector('input[name="name"]').value = ''`)
    }
    if (path === '/login' && req.method === 'POST') {
      const body = await text(req)
      log.push(`POST /login ${body}`)
      return forward(req, res, undefined, body)
    }
    if (claim && req.method === 'GET') {
      claimLoads += 1
      if (breaks.hangClaimPage) {
        log.push('GET /claim held')
        return void held.push(res)
      }
      if (breaks.claimPage === (claimLoads === 1 ? 'first' : 'signed-in')) return page(500)
      if (breaks.hydrationEmptiesName && claimLoads === 2) {
        return res.writeHead(200, { 'content-type': 'text/html' }).end('<p>Signing you in…</p><script>setTimeout(() => location.reload(), 100)</script>')
      }
      if (scripts) return forward(req, res, (body) => (body.includes('name="name"') ? body.replace('</body>', `${scripts}</body>`) : body))
    }
    if (claim && req.method === 'POST' && breaks.claimLost) {
      req.resume()
      lost = true
      return res.writeHead(302, { location: `/${namespace}/ports` }).end()
    }
    if (claim && req.method === 'POST' && breaks.claimErrorPage) {
      req.resume()
      log.push('POST /claim error page')
      return page(500)
    }
    if (claim && req.method === 'POST' && breaks.claimRefused) {
      req.resume()
      log.push('POST /claim refused')
      return res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'The project could not be claimed. Try again.' }))
    }
    if (path === '/api/agent/register') {
      return forward(req, res, (body) => {
        namespace = /^DEMETER_PROJECT_NAMESPACE=(.*)$/m.exec(body)?.[1] ?? namespace
        return body
      })
    }
    forward(req, res)
  })
  const mock = await startMock({ port: 0, baseUrl: served.url })
  upstream = `http://127.0.0.1:${(mock.server.address() as AddressInfo).port}`

  return {
    ...served,
    mock,
    log,
    get sessionCookie() {
      return sessionCookie
    },
    get claimPosted() {
      return claimPosted
    },
    async close() {
      for (const res of held) res.destroy()
      await served.close()
      await mock.close()
    },
  }
}
