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
  /** The claim form's project name comes empty. */
  emptyName?: boolean
  /** The claim's post never reaches the mock: it is redirected to the project's page, which answers 500 as it does to a user who does not own it. */
  claimLost?: boolean
  /** The first request for the project's page from outside the browser gets a reset. */
  resetFirstCheck?: boolean
}

export interface StandIn extends Served {
  /** The calls the proxy answered itself, or held: `POST /<ns>/settings <body>`, `GET /claim held`. */
  readonly log: string[]
  /** The mock's session cookie, once the sign-in set it. */
  readonly sessionCookie: string
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
  let upstream = ''

  /** Forwards to the mock, rewriting its body when asked; the mock's headers (two Set-Cookie among them) go back as they came. */
  const forward = (req: IncomingMessage, res: ServerResponse, rewrite?: (body: string) => string) => {
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
    req.pipe(up)
  }

  const served = await serve(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    const settings = /^\/([a-z0-9-]+)\/settings$/.exec(path)
    const ports = /^\/([a-z0-9-]+)\/ports$/.exec(path)
    const claim = /^\/claim\/[^/]+$/.test(path)
    const page = (status: number) => res.writeHead(status, { 'content-type': 'text/html' }).end(`<h1>${status}</h1>`)

    if (settings && req.method === 'POST') {
      const body = await text(req)
      log.push(`POST /<ns>/settings ${body}`)
      if (body !== 'intent=DELETE_PROJECT') return page(200)
      deleted.add(settings[1]!)
      return res.writeHead(302, { location: '/' }).end()
    }
    if (ports && req.method === 'GET') {
      if (deleted.has(ports[1]!) || lost) return page(500)
      // Chromium marks its navigations; Playwright's request API does not.
      if (breaks.resetFirstCheck && req.headers['sec-fetch-mode'] !== 'navigate' && checks++ === 0) return req.socket.destroy()
    }
    if (claim && req.method === 'GET') {
      claimLoads += 1
      if (breaks.hangClaimPage) {
        log.push('GET /claim held')
        return void held.push(res)
      }
      if (breaks.claimPage === (claimLoads === 1 ? 'first' : 'signed-in')) return page(500)
      if (breaks.emptyName) return forward(req, res, (body) => body.replace(/(<input[^>]*name="name"[^>]*value=")[^"]*"/, '$1"'))
    }
    if (claim && req.method === 'POST' && breaks.claimLost) {
      req.resume()
      lost = true
      return res.writeHead(302, { location: `/${namespace}/ports` }).end()
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
    async close() {
      for (const res of held) res.destroy()
      await served.close()
      await mock.close()
    },
  }
}
