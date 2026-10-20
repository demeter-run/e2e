import { randomBytes, randomInt, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { canonicalKind, catalog, preClaimNetworks, variablePrefix } from './catalog.ts'
import * as pages from './pages.ts'

/**
 * A mock of the Console's agent routes, built from the contract
 * (`solution/devex/contracts/registration-and-claim.md`): "HTTP for agents",
 * "Errors" and "Claim pages". Every credential it issues is random and
 * reaches nothing real. Each port's `_URL` points back at the mock's fake
 * data plane, `/data/<port id>/`.
 *
 * Control routes live under `/__mock/`, never on a contract path, and are not
 * logged. A `POST` to one must be `Content-Type: application/json`, which a
 * page on another site cannot send without a preflight the mock never
 * grants, and each answers only a `Host` naming the mock (its base URL's
 * name, or a loopback one), which a page that rebinds a name of its own to
 * the mock's address does not send. So a page open in the same browser
 * cannot read the call log, switch states or reset the mock under a run:
 *
 * - `POST /__mock/state` with `{"route": "register" | "ports", "error": <code>
 *   | null, "retry_after_seconds"?: <int>}` makes every call to that route
 *   answer that error (any code in the contract's table), or stops it; with
 *   `{"project": <id or namespace>, "expired": true | false}` it expires a
 *   project or revives it (with a fresh 7 days when its expiry has passed, so
 *   the next sweep leaves it); with `{"provisional_enabled": true | false}` it
 *   turns the kill switch; with `{"limits": {"ip_cap"?, "global_cap"?,
 *   "port_cap"?}}` it sets the caps it enforces. It answers the state after,
 *   as `GET /__mock/state` does: `{"errors": {<route>: {"error",
 *   "retry_after_seconds"?}}, "expired": [<project id>], "provisional_enabled",
 *   "limits": {"ip_cap", "global_cap", "port_cap"}, "now"}`.
 * - `POST /__mock/clock` with `{"advance_seconds": <int>}` moves the mock's
 *   clock forward, at most 100 years ahead of this machine's in all, then sweeps: every unclaimed project whose expiry has
 *   passed expires, as fabric's sweep does (every 10 minutes; the mock's at
 *   each move). It answers the state after.
 * - `GET /__mock/calls`: every other call so far, `{method, path, status,
 *   headers}`, with each credential the mock issued replaced by
 *   `[redacted]` and the credential headers redacted whole.
 * - `POST /__mock/reset`: forgets every project, session, error and call.
 */

/** The contract's error codes and the status each answers with. */
export const errorStatus = {
  invalid_request: 400,
  unauthenticated: 401,
  pre_claim_limit: 403,
  expired: 410,
  ip_cap: 429,
  port_cap: 429,
  global_cap: 503,
  registration_disabled: 503,
} as const

export type ErrorCode = keyof typeof errorStatus

/** The messages production sends with each code (the Console's `agent.server.ts`). */
const messages: Record<ErrorCode, string> = {
  invalid_request: 'The request was refused; check its body.',
  unauthenticated: 'Send DEMETER_API_KEY as dmtr-api-key and DEMETER_PROJECT_ID as project-id.',
  pre_claim_limit: 'An unclaimed project only gets Free ports on cardano-preprod and cardano-preview.',
  expired: 'This project expired unclaimed; register again.',
  ip_cap: 'This address has registered 3 projects in the last 24 hours.',
  port_cap: 'An unclaimed project holds at most 3 ports; claim it to add more.',
  global_cap: 'Too many unclaimed projects are live; try again later.',
  registration_disabled: 'Agent registration is closed right now.',
}

export const DOCS_URL = 'https://demeter.run/auth.md'

/** The caps the mock enforces, by default fabric's (`domain/provisional/mod.rs`). */
export interface Limits {
  /** Registrations from one client IP in the trailing 24 hours. */
  ip_cap: number
  /** Unclaimed projects live at once. */
  global_cap: number
  /** Ports on one unclaimed project. */
  port_cap: number
}

export const defaultLimits: Readonly<Limits> = { ip_cap: 3, global_cap: 200, port_cap: 3 }

/**
 * The rules the mock enforces, each of which a test may break
 * (`MockOptions.broken`) to show the journey that holds it fails without it.
 */
export const rules = ['ip_cap', 'ip_window', 'global_cap', 'port_cap', 'kill_switch', 'expiry', 'expired_data_plane', 'expired_claim'] as const
export type Rule = (typeof rules)[number]

const TTL_DAYS = 7
const TTL_MS = TTL_DAYS * 86_400_000
/** How far ahead of this machine's the mock's clock may run: far past any journey, and well inside what a `Date` holds. */
const MAX_CLOCK_AHEAD_SECONDS = 100 * 365 * 86_400
const IP_CAP_WINDOW_MS = 86_400_000
/** The `ip_cap` wait when none is switched on: the whole window, as when fabric reports none. */
const IP_CAP_RETRY_AFTER_SECONDS = 86400

const AGENT_NAME_MAX = 64
const AGENT_FIELD_MAX = 256
const USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const BECH32_ALPHABET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'

/** Headers whose whole value is a credential. */
const secretHeaders = new Set(['dmtr-api-key', 'authorization', 'cookie', 'set-cookie'])

export interface Call {
  method: string
  path: string
  status: number
  headers: Record<string, string>
}

interface Port {
  id: string
  kind: string
  network: string
  key: string
}

interface Project {
  id: string
  namespace: string
  apiKey: string
  /** Void (null) once the project is claimed. */
  claimToken: string | null
  /** As agents relay it, `XXXX-XXXX`; void (null) once claimed. */
  userCode: string | null
  expiresAt: string
  agent: { name: string; version?: string; url?: string }
  ports: Port[]
  /** The user name that claimed it; null while provisional. */
  owner: string | null
  name: string
  expired: boolean
  /** When it was registered, on the mock's clock, and from which client IP. */
  createdAt: number
  source: string
}

interface State {
  projects: Project[]
  /** Session id → user name. */
  sessions: Map<string, string>
  errors: Partial<Record<'register' | 'ports', { error: ErrorCode; retryAfterSeconds?: number }>>
  calls: Call[]
  /** Every credential issued since the last reset, so the call log can redact them. */
  issued: Set<string>
  /** The kill switch: while false, registration is refused. */
  enabled: boolean
  limits: Limits
  /** How far the mock's clock runs ahead of this machine's, in milliseconds. */
  clockMs: number
}

const freshState = (): State => ({
  projects: [],
  sessions: new Map(),
  errors: {},
  calls: [],
  issued: new Set(),
  enabled: true,
  limits: { ...defaultLimits },
  clockMs: 0,
})

const random = (alphabet: string, length: number): string =>
  Array.from({ length }, () => alphabet[randomInt(alphabet.length)]).join('')

/** RFC 3339 in UTC, as fabric's `to_rfc3339()` writes it. */
const rfc3339 = (date: Date): string => date.toISOString().replace('Z', '+00:00')

const codePoints = (text: string): number => Array.from(text).length

/** A user code as typed, in its relayed form `XXXX-XXXX`; null when it cannot be one. */
export function normalizeUserCode(input: string): string | null {
  const compact = input.replace(/[\s-]/g, '').toUpperCase()
  if (compact.length !== 8 || ![...compact].every((c) => USER_CODE_ALPHABET.includes(c))) return null
  return `${compact.slice(0, 4)}-${compact.slice(4)}`
}

function cookies(request: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {}
  for (const pair of (request.headers.cookie ?? '').split(';')) {
    const at = pair.indexOf('=')
    if (at > 0) out[pair.slice(0, at).trim()] = decodeURIComponent(pair.slice(at + 1).trim())
  }
  return out
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

const dotenv = (lines: [string, string][]): string => lines.map(([name, value]) => `${name}=${value}\n`).join('')

export interface MockOptions {
  /** Where the mock listens. Port 0 picks a free one. */
  port?: number
  host?: string
  /** The origin the mock writes into claim URLs and port URLs; by default, where it listens. */
  baseUrl?: string
  /** Rules the mock does not enforce, for the tests that show a journey fails without them; `pnpm mock` breaks none. */
  broken?: readonly Rule[]
}

export interface Mock {
  /** The base URL, as `--env mock` reads it. */
  url: string
  server: Server
  close(): Promise<void>
}

export async function startMock({ port = 4010, host = '127.0.0.1', baseUrl, broken = [] }: MockOptions = {}): Promise<Mock> {
  let state = freshState()
  const enforced = (rule: Rule) => !broken.includes(rule)
  /** The mock's clock: this machine's, moved forward by `POST /__mock/clock`. */
  const now = () => Date.now() + state.clockMs
  // Paths are appended to it, so a trailing slash would make them `//claim/…`.
  let base = (baseUrl ?? '').replace(/\/+$/, '')

  /**
   * A logged path or header value without credentials: a claim token and a
   * user code go by their place in a URL, whatever was typed (a code in lower
   * case, a token that is not one yet), and every credential the mock issued
   * goes wherever it appears.
   */
  const scrub = (text: string): string => {
    let out = text.replace(/\/claim\/[^/?#\s]+/g, '/claim/[redacted]').replace(/([?&]code=)[^&#\s]*/g, '$1[redacted]')
    for (const secret of state.issued) out = out.split(secret).join('[redacted]')
    return out
  }

  const send = (response: ServerResponse, status: number, type: string, body: string, headers: Record<string, string> = {}) => {
    response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...headers })
    response.end(body)
  }
  const sendHtml = (response: ServerResponse, status: number, body: string, headers: Record<string, string> = {}) =>
    send(response, status, 'text/html; charset=utf-8', body, headers)
  const sendJson = (response: ServerResponse, status: number, body: unknown) =>
    send(response, status, 'application/json; charset=utf-8', `${JSON.stringify(body)}\n`)
  const redirect = (response: ServerResponse, location: string, headers: Record<string, string> = {}) => {
    response.writeHead(302, { Location: location, 'Cache-Control': 'no-store', ...headers })
    response.end()
  }

  /** A contract error: JSON, never a credential, `retry_after_seconds` and `Retry-After` with `ip_cap`. */
  function agentError(
    response: ServerResponse,
    error: ErrorCode,
    { message = messages[error], retryAfterSeconds, status = errorStatus[error] }: { message?: string; retryAfterSeconds?: number; status?: number } = {},
  ) {
    const retry = error === 'ip_cap' ? (retryAfterSeconds ?? IP_CAP_RETRY_AFTER_SECONDS) : undefined
    const body = { error, message, ...(retry !== undefined ? { retry_after_seconds: retry } : {}), docs: DOCS_URL }
    send(response, status, 'application/json; charset=utf-8', JSON.stringify(body), retry !== undefined ? { 'Retry-After': String(retry) } : {})
  }
  const forcedError = (response: ServerResponse, forced: { error: ErrorCode; retryAfterSeconds?: number }) =>
    agentError(response, forced.error, forced.retryAfterSeconds !== undefined ? { retryAfterSeconds: forced.retryAfterSeconds } : {})

  const sendDotenv = (response: ServerResponse, lines: [string, string][]) => send(response, 200, 'text/plain; charset=utf-8', dotenv(lines))

  const issue = (...secrets: string[]) => {
    for (const secret of secrets) state.issued.add(secret)
  }

  const user = (request: IncomingMessage): string | undefined => {
    const sid = cookies(request).mock_session
    return sid ? state.sessions.get(sid) : undefined
  }

  /** Remembers the page to return to after sign-in, as the Console's `_redirect_to` cookie does. */
  const remember = (path: string) => ({ 'Set-Cookie': `_redirect_to=${encodeURIComponent(path)}; Path=/; HttpOnly; SameSite=Lax` })

  async function register(request: IncomingMessage, response: ServerResponse) {
    const forced = state.errors.register
    if (forced) return forcedError(response, forced)

    let body: unknown
    try {
      body = JSON.parse(await readBody(request))
    } catch {
      return agentError(response, 'invalid_request', { message: 'The body must be JSON: {"agent": {"name": "…"}}.' })
    }
    const agent = (body as { agent?: unknown } | null)?.agent as Record<string, unknown> | undefined
    const optional = (value: unknown) => value === undefined || value === null || (typeof value === 'string' && codePoints(value) <= AGENT_FIELD_MAX)
    const name = typeof agent?.name === 'string' ? agent.name.trim() : ''
    if (!agent || !name || codePoints(name) > AGENT_NAME_MAX || !optional(agent.version) || !optional(agent.url)) {
      return agentError(response, 'invalid_request', {
        message: `agent.name is required and at most ${AGENT_NAME_MAX} characters; agent.version and agent.url are at most ${AGENT_FIELD_MAX}.`,
      })
    }

    // fabric's order (`domain/provisional/command.rs`): the kill switch, the
    // client IP's window, then the global cap.
    if (!state.enabled && enforced('kill_switch')) return agentError(response, 'registration_disabled')
    const at = now()
    const source = clientIp(request)
    const recent = state.projects
      .filter((p) => p.source === source && (!enforced('ip_window') || p.createdAt >= at - IP_CAP_WINDOW_MS))
      .map((p) => p.createdAt)
      .sort((a, b) => a - b)
    if (recent.length >= state.limits.ip_cap && enforced('ip_cap')) {
      // The window slides: the source may register again once enough of its
      // registrations age out to bring it back under the cap.
      const freeing = recent[recent.length - state.limits.ip_cap]
      const wait = freeing === undefined ? IP_CAP_RETRY_AFTER_SECONDS : Math.max(1, Math.ceil((freeing + IP_CAP_WINDOW_MS - at) / 1000))
      return agentError(response, 'ip_cap', { retryAfterSeconds: wait })
    }
    const live = state.projects.filter((p) => p.owner === null && !p.expired).length
    if (live >= state.limits.global_cap && enforced('global_cap')) return agentError(response, 'global_cap')

    const project: Project = {
      id: randomUUID(),
      namespace: `mock-project-${random('abcdefghijklmnopqrstuvwxyz0123456789', 6)}`,
      apiKey: `dmtr_apikey1${random(BECH32_ALPHABET, 58)}`,
      claimToken: randomBytes(32).toString('base64url'),
      userCode: `${random(USER_CODE_ALPHABET, 4)}-${random(USER_CODE_ALPHABET, 4)}`,
      expiresAt: rfc3339(new Date(at + TTL_MS)),
      agent: {
        name,
        ...(typeof agent.version === 'string' ? { version: agent.version } : {}),
        ...(typeof agent.url === 'string' ? { url: agent.url } : {}),
      },
      ports: [],
      owner: null,
      name: '',
      expired: false,
      createdAt: at,
      source,
    }
    project.name = project.namespace
    issue(project.apiKey, project.claimToken!, project.userCode!, project.userCode!.replace('-', ''))
    state.projects.push(project)

    sendDotenv(response, [
      ['DEMETER_PROJECT_ID', project.id],
      ['DEMETER_PROJECT_NAMESPACE', project.namespace],
      ['DEMETER_API_KEY', project.apiKey],
      ['DEMETER_CLAIM_URL', `${base}/claim/${project.claimToken}`],
      ['DEMETER_USER_CODE', project.userCode!],
      ['DEMETER_EXPIRES_AT', project.expiresAt],
    ])
  }

  // In production's order (the Console's `api.agent.ports.ts`): the credential
  // headers' presence, the body, the network and tier, the kind and its
  // options, and only then the key, the expiry and the port cap, which fabric
  // checks.
  async function createPort(request: IncomingMessage, response: ServerResponse) {
    const forced = state.errors.ports
    if (forced) return forcedError(response, forced)

    const key = request.headers['dmtr-api-key']
    const projectId = request.headers['project-id']
    if (typeof key !== 'string' || !key || typeof projectId !== 'string' || !projectId) return agentError(response, 'unauthenticated')

    let body: Record<string, unknown> | null
    try {
      body = JSON.parse(await readBody(request))
    } catch {
      return agentError(response, 'invalid_request', { message: 'The body must be JSON: {"kind": "OgmiosPort", "network": "cardano-preprod"}.' })
    }
    const { kind, network, throughputTier } = body ?? {}
    const tierOk = throughputTier === undefined || typeof throughputTier === 'string' || typeof throughputTier === 'number'
    if (typeof kind !== 'string' || !kind || typeof network !== 'string' || !network || !tierOk) {
      return agentError(response, 'invalid_request', { message: 'kind and network are required, e.g. {"kind": "OgmiosPort", "network": "cardano-preprod"}.' })
    }
    if (!preClaimNetworks.includes(network)) return agentError(response, 'pre_claim_limit')
    if (throughputTier !== undefined && String(throughputTier) !== '0') return agentError(response, 'pre_claim_limit')

    const canonical = canonicalKind(kind)
    if (!canonical) return agentError(response, 'invalid_request', { message: `Unknown port kind; use one of ${Object.keys(catalog).join(', ')}.` })
    if (!catalog[canonical]!.includes(network)) return agentError(response, 'pre_claim_limit')

    const project = state.projects.find((p) => p.id === projectId)
    if (!project || project.apiKey !== key) return agentError(response, 'unauthenticated')
    if (project.expired) return agentError(response, 'expired')
    if (project.owner === null && project.ports.length >= state.limits.port_cap && enforced('port_cap')) return agentError(response, 'port_cap')

    const short = canonical.toLowerCase().replace(/port$/, '')
    const password = random(BECH32_ALPHABET, 32)
    const port: Port = {
      id: randomUUID(),
      kind: canonical,
      network,
      // db-sync answers username:password; every other kind an authToken.
      key: canonical === 'DbSyncPort' ? `dmtr_user${random(BECH32_ALPHABET, 12)}:${password}` : `dmtr_${short}1${random(BECH32_ALPHABET, 38)}`,
    }
    issue(port.key, password)
    project.ports.push(port)

    const prefix = variablePrefix(canonical, network)
    sendDotenv(response, [
      [`${prefix}_PORT_ID`, port.id],
      [`${prefix}_URL`, `${base}/data/${port.id}/`],
      [`${prefix}_KEY`, port.key],
    ])
  }

  /** The fake data plane: 200 JSON to a request carrying the port's key, 401 otherwise. */
  function data(request: IncomingMessage, response: ServerResponse, portId: string, rest: string) {
    const project = state.projects.find((p) => p.ports.some((port) => port.id === portId))
    const port = project?.ports.find((p) => p.id === portId)
    if (!project || !port || (project.expired && enforced('expired_data_plane')) || request.headers['dmtr-api-key'] !== port.key) {
      return sendJson(response, 401, { error: 'unauthorized' })
    }
    sendJson(response, 200, { mock: true, port: port.id, kind: port.kind, network: port.network, path: rest || '/' })
  }

  async function login(request: IncomingMessage, response: ServerResponse) {
    if (request.method !== 'POST') return sendHtml(response, 200, pages.signIn())
    const form = new URLSearchParams(await readBody(request))
    const username = form.get('username')?.trim() ?? ''
    if (!username) return sendHtml(response, 400, pages.signIn('Enter a user name.'))

    const sid = randomBytes(18).toString('base64url')
    state.sessions.set(sid, username)
    issue(sid)
    const back = cookies(request)._redirect_to ?? ''
    const target = back.startsWith('/claim/') || back.startsWith('/activate') ? back : '/'
    response.writeHead(302, {
      Location: target,
      'Cache-Control': 'no-store',
      'Set-Cookie': [`mock_session=${sid}; Path=/; HttpOnly; SameSite=Lax`, '_redirect_to=; Path=/; Max-Age=0'],
    })
    response.end()
  }

  /** The claim view, or the expired one, for the live project a token or code names. */
  async function claimPage(
    request: IncomingMessage,
    response: ServerResponse,
    project: Project | undefined,
    via: 'link' | 'code',
    here: string,
  ) {
    const who = user(request)
    if (!who) {
      if (request.method === 'POST') return redirect(response, '/login', remember(here))
      return sendHtml(response, 200, pages.signedOut(), remember(here))
    }
    if (!project || (project.expired && enforced('expired_claim')) || project.owner !== null) return sendHtml(response, 200, pages.expired(via))

    if (request.method !== 'POST') {
      return sendHtml(
        response,
        200,
        pages.claim({
          namespace: project.namespace,
          agentName: project.agent.name,
          ...(project.agent.version ? { agentVersion: project.agent.version } : {}),
          expiresAt: project.expiresAt,
          ports: project.ports.map(({ kind, network }) => ({ kind, network })),
          action: here,
        }),
      )
    }

    const name = new URLSearchParams(await readBody(request)).get('name')?.trim()
    project.owner = who
    project.name = name || project.namespace
    project.claimToken = null
    project.userCode = null
    redirect(response, `/${project.namespace}/ports`)
  }

  async function activate(request: IncomingMessage, response: ServerResponse, url: URL) {
    const input = url.searchParams.get('code')
    const notACode = 'That is not a user code. It looks like ABCD-2345.'
    const status = request.method === 'POST' ? 400 : 200
    if (input === null) {
      if (!user(request)) return sendHtml(response, 200, pages.signedOut(), remember('/activate'))
      return sendHtml(response, status, pages.codeForm('', request.method === 'POST' ? notACode : undefined))
    }
    const code = normalizeUserCode(input)
    if (!code) return sendHtml(response, status, pages.codeForm(input, notACode))
    const project = state.projects.find((p) => p.userCode === code)
    // As the Console does, the page remembers and posts to the URL as requested.
    return claimPage(request, response, project, 'code', `${url.pathname}${url.search}`)
  }

  /**
   * The client IP registration counts by, as the Console's Fastify takes it
   * behind its one trusted proxy (`TRUST_PROXY_HOPS`, 1 by default): the last
   * non-empty `X-Forwarded-For` entry, the one that proxy wrote, so an entry
   * the client put before it is ignored, and an empty one is skipped as
   * Fastify's `forwarded` parser drops it; or the connection's address. A run
   * sets the header to act as several sources.
   */
  const clientIp = (request: IncomingMessage): string =>
    request.headers['x-forwarded-for']
      ?.toString()
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .at(-1) ||
    request.socket.remoteAddress ||
    ''

  /** Whether a request names the mock as its host: its base URL's name, or a loopback one. */
  const ownHost = (request: IncomingMessage) => {
    const host = `http://${request.headers.host ?? ''}`
    const name = URL.canParse(host) ? new URL(host).hostname : ''
    return name === new URL(base).hostname || name === '127.0.0.1' || name === 'localhost' || name === '[::1]'
  }

  async function control(request: IncomingMessage, response: ServerResponse, path: string) {
    if (!ownHost(request)) {
      request.resume()
      return sendJson(response, 403, { error: `a control route answers only under the mock's own name (${new URL(base).hostname}) or a loopback one` })
    }
    if (request.method === 'POST' && !/^application\/json\s*(;|$)/i.test(request.headers['content-type'] ?? '')) {
      request.resume()
      return sendJson(response, 415, { error: 'a control route takes Content-Type: application/json' })
    }
    if (path === '/__mock/calls' && request.method === 'GET') return sendJson(response, 200, state.calls)
    if (path === '/__mock/state' && request.method === 'GET') return sendJson(response, 200, snapshot())
    if (path === '/__mock/reset' && request.method === 'POST') {
      state = freshState()
      return sendJson(response, 200, {})
    }
    if ((path !== '/__mock/state' && path !== '/__mock/clock') || request.method !== 'POST') return sendJson(response, 404, { error: 'not_found' })

    let body: Record<string, unknown>
    try {
      body = JSON.parse(await readBody(request)) ?? {}
    } catch {
      return sendJson(response, 400, { error: 'the body must be JSON' })
    }
    if (path === '/__mock/clock') {
      const seconds = body.advance_seconds
      if (!Number.isInteger(seconds) || (seconds as number) < 0) return sendJson(response, 400, { error: 'send {"advance_seconds": <whole seconds, at least 0>}' })
      if (state.clockMs / 1000 + (seconds as number) > MAX_CLOCK_AHEAD_SECONDS) {
        return sendJson(response, 400, { error: `the mock's clock runs at most ${MAX_CLOCK_AHEAD_SECONDS} seconds (100 years) ahead; reset it to start again` })
      }
      state.clockMs += (seconds as number) * 1000
      sweep()
      return sendJson(response, 200, snapshot())
    }
    if (body.route === 'register' || body.route === 'ports') {
      if (body.error === null) delete state.errors[body.route]
      else if (typeof body.error === 'string' && Object.hasOwn(errorStatus, body.error)) {
        const retry = body.retry_after_seconds
        if (retry !== undefined && !(Number.isInteger(retry) && (retry as number) >= 1)) {
          return sendJson(response, 400, { error: 'retry_after_seconds is a whole number of seconds, at least 1' })
        }
        state.errors[body.route] = { error: body.error as ErrorCode, ...(retry !== undefined ? { retryAfterSeconds: retry as number } : {}) }
      } else return sendJson(response, 400, { error: `error is null or one of ${Object.keys(errorStatus).join(', ')}` })
    } else if (typeof body.project === 'string' && typeof body.expired === 'boolean') {
      const project = state.projects.find((p) => p.id === body.project || p.namespace === body.project)
      if (!project) return sendJson(response, 404, { error: 'no such project' })
      project.expired = body.expired
      // A revived project gets a fresh 7 days if its expiry has passed, or the next sweep would expire it again.
      if (!body.expired && Date.parse(project.expiresAt) <= now()) project.expiresAt = rfc3339(new Date(now() + TTL_MS))
    } else if (typeof body.provisional_enabled === 'boolean') {
      state.enabled = body.provisional_enabled
    } else if (typeof body.limits === 'object' && body.limits !== null && !Array.isArray(body.limits)) {
      const limits = body.limits as Record<string, unknown>
      const unknown = Object.keys(limits).filter((name) => !Object.hasOwn(defaultLimits, name))
      if (unknown.length) return sendJson(response, 400, { error: `limits are ${Object.keys(defaultLimits).join(', ')}, not ${unknown.join(', ')}` })
      if (!Object.values(limits).every((n) => Number.isInteger(n) && (n as number) >= 0)) return sendJson(response, 400, { error: 'a limit is a whole number, at least 0' })
      Object.assign(state.limits, limits)
    } else {
      return sendJson(response, 400, { error: 'send {"route", "error"}, {"project", "expired"}, {"provisional_enabled"} or {"limits"}' })
    }
    sendJson(response, 200, snapshot())
  }

  /** fabric's sweep: every unclaimed project whose expiry has passed expires, and its ports stop answering. */
  const sweep = () => {
    if (!enforced('expiry')) return
    for (const p of state.projects) if (p.owner === null && !p.expired && Date.parse(p.expiresAt) < now()) p.expired = true
  }

  /** The error states, expired projects, kill switch and caps, in the shape `POST /__mock/state` takes them, and the mock's time. */
  const snapshot = () => ({
    errors: Object.fromEntries(
      Object.entries(state.errors).map(([route, { error, retryAfterSeconds }]) => [
        route,
        { error, ...(retryAfterSeconds !== undefined ? { retry_after_seconds: retryAfterSeconds } : {}) },
      ]),
    ),
    expired: state.projects.filter((p) => p.expired).map((p) => p.id),
    provisional_enabled: state.enabled,
    limits: { ...state.limits },
    now: rfc3339(new Date(now())),
  })

  async function handle(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? '/', 'http://mock')
    const path = url.pathname
    if (path.startsWith('/__mock/')) return control(request, response, path)

    response.on('finish', () => {
      const headers: Record<string, string> = {}
      for (const [name, value] of Object.entries(request.headers)) {
        const text = Array.isArray(value) ? value.join(', ') : (value ?? '')
        headers[name] = secretHeaders.has(name) ? '[redacted]' : scrub(text)
      }
      state.calls.push({ method: request.method ?? 'GET', path: scrub(`${path}${url.search}`), status: response.statusCode, headers })
    })

    if (path === '/api/agent/register' || path === '/api/agent/ports') {
      // The contract defines POST only. Production answers another method
      // with this 405, except GET and HEAD, which never reach its action:
      // Remix answers those 400 with its own JSON, `{"message": "Unexpected
      // Server Error"}` (no code, no docs, no Cache-Control), which no test reads.
      if (request.method !== 'POST') return agentError(response, 'invalid_request', { message: 'Use POST with a JSON body.', status: 405 })
      return path === '/api/agent/register' ? register(request, response) : createPort(request, response)
    }
    if (path === '/login') return login(request, response)
    if (path === '/activate') return activate(request, response, url)

    const claimed = /^\/claim\/([^/]+)$/.exec(path)
    if (claimed) {
      const token = decodeURIComponent(claimed[1]!)
      return claimPage(request, response, state.projects.find((p) => p.claimToken === token), 'link', path)
    }

    const plane = /^\/data\/([^/]+)(\/.*)?$/.exec(path)
    if (plane) return data(request, response, plane[1]!, plane[2] ?? '')

    const ports = /^\/([a-z0-9-]+)\/ports$/.exec(path)
    if (ports && request.method === 'GET') {
      const who = user(request)
      if (!who) return redirect(response, '/login')
      const project = state.projects.find((p) => p.namespace === ports[1] && p.owner === who)
      if (!project) return sendHtml(response, 404, pages.notFound())
      return sendHtml(response, 200, pages.ports(project.name, project.namespace, project.ports))
    }

    if (path.startsWith('/api/')) return sendJson(response, 404, { error: 'not_found' })
    sendHtml(response, 404, pages.notFound())
  }

  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      // On stderr, where a run that starts the mock can find it: a 500 alone
      // says nothing of why.
      console.error(`mock error: ${request.method} ${scrub(request.url ?? '/')}: ${scrub(error instanceof Error ? (error.stack ?? error.message) : String(error))}`)
      if (!response.headersSent) sendJson(response, 500, { error: 'mock_error', message: error instanceof Error ? error.message : String(error) })
      else response.end()
    })
  })
  server.listen(port, host)
  await once(server, 'listening')
  const address = server.address() as AddressInfo
  // An IPv6 address goes in brackets in a URL.
  base ||= `http://${host.includes(':') ? `[${host}]` : host}:${address.port}`

  return {
    url: base,
    server,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
