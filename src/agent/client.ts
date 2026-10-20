import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { Environment } from '../env.ts'

/**
 * Calls to the agent routes (`POST /api/agent/register`, `/api/agent/ports`)
 * and the data plane, as a coding agent makes them, and the credentials they
 * hand out.
 *
 * A dotenv body carries credentials: it goes to a file, as `curl -o
 * .env.demeter` would, and is never printed. What a step reports is a status,
 * an error code or a line name (`describe`, `names`), and every detail passes
 * through `Secrets.scrub` before it reaches a result.
 */

/** What one call answered. `body` may hold credentials. */
export interface AgentAnswer {
  /** The HTTP status, or null when nothing answered. */
  status: number | null
  /** Response headers, lower-cased. */
  headers: Record<string, string>
  body: string
  /** Why nothing answered, or why the body did not finish. */
  error?: string
}

/**
 * One request on its own connection, closed after it, never following a
 * redirect: like `probe` in `src/http.ts`, which a reused keep-alive
 * connection to the apex once reset in CI.
 */
export function call(
  method: string,
  url: string,
  { headers = {}, body, timeoutMs = 30_000 }: { headers?: Record<string, string>; body?: string; timeoutMs?: number } = {},
): Promise<AgentAnswer> {
  const target = new URL(url)
  const send = target.protocol === 'http:' ? httpRequest : httpsRequest
  return new Promise((resolve) => {
    let head: Pick<AgentAnswer, 'status' | 'headers'> | undefined
    const settle = (answer: AgentAnswer) => {
      clearTimeout(timer)
      request.destroy()
      resolve(answer)
    }
    const broke = (why: string) =>
      settle(head ? { ...head, body: '', error: `the body did not finish${why}` } : { status: null, headers: {}, body: '', error: `no answer${why}` })
    const request = send(
      target,
      {
        method,
        agent: false,
        headers: {
          connection: 'close',
          'user-agent': 'demeter-run-e2e',
          ...(body !== undefined ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) } : {}),
          ...headers,
        },
      },
      (response) => {
        const flat: Record<string, string> = {}
        for (const [name, value] of Object.entries(response.headers)) flat[name] = Array.isArray(value) ? value.join(', ') : (value ?? '')
        head = { status: response.statusCode ?? null, headers: flat }
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => settle({ ...head!, body: Buffer.concat(chunks).toString('utf8') }))
        response.on('error', (error: NodeJS.ErrnoException) => broke(`: ${error.code ?? error.name}`))
      },
    )
    const timer = setTimeout(() => broke(` within ${timeoutMs / 1000} s`), timeoutMs)
    request.on('error', (error: NodeJS.ErrnoException) => broke(`: ${error.code ?? error.name} (${error.message})`))
    request.end(body)
  })
}

export interface AgentIdentity {
  name: string
  version?: string
  url?: string
}

/** `POST /api/agent/register`. */
export const register = (env: Environment, agent: AgentIdentity | Record<string, unknown>): Promise<AgentAnswer> =>
  call('POST', `${env.console}/api/agent/register`, { body: JSON.stringify({ agent }) })

/** The headers `/api/agent/ports` reads the pre-claim credential from. */
export interface Credentials {
  apiKey: string
  projectId: string
}

/** `POST /api/agent/ports`; `body` is sent as it is when it is a string, so a test can send one that is not JSON. */
export const createPort = (env: Environment, credentials: Credentials, body: Record<string, unknown> | string): Promise<AgentAnswer> =>
  call('POST', `${env.console}/api/agent/ports`, {
    headers: { 'dmtr-api-key': credentials.apiKey, 'project-id': credentials.projectId },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

/** The port J0 creates, and the one the contract's ports rules read: the cheapest real port, Free on preprod. */
export const J0_PORT = { kind: 'BlockfrostPort', network: 'cardano-preprod' } as const

/**
 * The run's own registration and its first port, made once per run and
 * shared: J0 makes them, and the contract's prod-safe tests read them, so a
 * production run registers once and J0 claims and deletes what it made.
 */
export interface Registration {
  register: AgentAnswer
  /** Null when the registration failed and no port was asked for. */
  port: AgentAnswer | null
}

/** The pre-claim credential a registration handed out, when it did. */
export function credentials(registration: Registration): Credentials | null {
  const vars = dotenvVars(registration.register.body)
  const apiKey = vars.get('DEMETER_API_KEY')
  const projectId = vars.get('DEMETER_PROJECT_ID')
  return registration.register.status === 200 && apiKey && projectId ? { apiKey, projectId } : null
}

/**
 * A registration of `name` and its first port, the run's own when J0 does not
 * make one (`pnpm contract`, on the mock), with their credentials in
 * `secrets`.
 */
export async function registerWithPort(env: Environment, secrets: Secrets, name: string): Promise<Registration> {
  const answer = await register(env, { name })
  addRegistrationSecrets(secrets, dotenvVars(answer.body))
  const made = credentials({ register: answer, port: null })
  const port = made ? await createPort(env, made, { ...J0_PORT }) : null
  if (port) addPortSecrets(secrets, dotenvVars(port.body))
  return { register: answer, port }
}

/** A dotenv body's lines, in order. A line that is not `NAME=value` is kept with a null value, so the order check sees it. */
export function parseDotenv(body: string): { name: string; value: string | null }[] {
  return body
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line)
      return match ? { name: match[1]!, value: match[2]! } : { name: line.slice(0, 40), value: null }
    })
}

/** A dotenv body as a map from name to value. */
export const dotenvVars = (body: string): Map<string, string> =>
  new Map(parseDotenv(body).flatMap(({ name, value }) => (value === null ? [] : [[name, value] as const])))

/** The line names of a dotenv body, which a step may print. */
export const names = (body: string): string[] => parseDotenv(body).map((l) => l.name)

/** The contract's error body, when the answer is JSON in that shape. */
export interface ErrorBody {
  error: string
  message: string
  retry_after_seconds?: number
  docs: string
}

export function errorBody(answer: AgentAnswer): ErrorBody | null {
  try {
    const body = JSON.parse(answer.body) as Partial<ErrorBody> | null
    return body && typeof body.error === 'string' ? (body as ErrorBody) : null
  } catch {
    return null
  }
}

/** An answer as a step may print it: its status and, for an error, its code. Never the body. */
export function describe(answer: AgentAnswer): string {
  if (answer.status === null) return answer.error ?? 'no answer'
  const code = errorBody(answer)?.error
  return `${answer.status}${code ? ` ${code}` : ''}${answer.error ? `, but ${answer.error}` : ''}`
}

/**
 * Every credential a run has received or holds: API keys, port keys, claim
 * tokens, user codes, the test user's password. `scrub` takes them out of
 * text before it is printed or written, and `find` says which kinds a text
 * carries, for the check that none leaked. In GitHub Actions each one is also
 * masked in the job log as it arrives, as a second line of defence: this
 * repository's logs are public.
 */
export class Secrets {
  readonly #values = new Map<string, string>()

  add(kind: string, value: string | undefined): void {
    if (!value || value.length < 6 || this.#values.has(value)) return
    this.#values.set(value, kind)
    if (process.env.GITHUB_ACTIONS === 'true') console.log(`::add-mask::${value}`)
  }

  get size(): number {
    return this.#values.size
  }

  scrub(text: string): string {
    let out = text
    // Longest first, so a key that contains another is replaced whole.
    for (const value of [...this.#values.keys()].sort((a, b) => b.length - a.length)) out = out.split(value).join('[redacted]')
    return out
  }

  /** The kinds of credential `text` carries, once each. */
  find(text: string): string[] {
    return [...new Set([...this.#values].filter(([value]) => text.includes(value)).map(([, kind]) => kind))]
  }
}

/** Registers the credentials a register body hands out. */
export function addRegistrationSecrets(secrets: Secrets, vars: Map<string, string>): void {
  secrets.add('API key', vars.get('DEMETER_API_KEY'))
  const claimUrl = vars.get('DEMETER_CLAIM_URL')
  if (claimUrl) {
    const token = /\/claim\/([^/?#]+)/.exec(claimUrl)?.[1]
    if (token) {
      secrets.add('claim token', token)
      secrets.add('claim token', decodeURIComponent(token))
    }
  }
  secrets.add('user code', vars.get('DEMETER_USER_CODE'))
}

/** Registers the credentials a ports body hands out: every key, and every URL that may carry one. */
export function addPortSecrets(secrets: Secrets, vars: Map<string, string>): void {
  for (const [name, value] of vars) {
    if (name.endsWith('_KEY')) {
      secrets.add('port key', value)
      // db-sync's is username:password; the password alone is the secret part.
      const password = value.split(':')[1]
      if (password) secrets.add('port key', password)
    }
  }
}
