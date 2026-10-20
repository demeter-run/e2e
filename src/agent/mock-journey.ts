import type { Environment } from '../env.ts'
import { DOCS_URL } from '../mock/server.ts'
import { Failure } from '../report.ts'
import {
  type AgentAnswer,
  addPortSecrets,
  addRegistrationSecrets,
  call,
  createPort,
  type Credentials,
  credentials,
  describe,
  dotenvVars,
  type ErrorBody,
  errorBody,
  J0_PORT,
  NAMESPACE,
  register,
  type Secrets,
} from './client.ts'

/**
 * What the journeys that run on the mock alone (J3, J9) share: agents that
 * register from an address of their own, ports, the data plane, the
 * contract's errors, and a person's claim over HTTP. Like J0, a step reports
 * statuses, codes and names, never a body: dotenv bodies carry credentials.
 */

export const fail = (message: string): never => {
  throw new Failure(message)
}

/** The Blockfrost call J0 makes on a port. */
const REQUEST_PATH = '/blocks/latest'

/** A project an agent registered. */
export interface Project extends Credentials {
  namespace: string
  claimUrl: string
  expiresAt: string
}

/** A port an agent created, as its dotenv lines hand it over. */
export interface Port {
  url: string
  key: string
}

/**
 * A coding agent on one client IP, as the mock counts registrations: it sends
 * the address as `X-Forwarded-For`, so one runner acts as several sources.
 * The addresses come from TEST-NET-1 (RFC 5737), which reaches nothing.
 */
export class Agent {
  constructor(
    readonly env: Environment,
    readonly secrets: Secrets,
    readonly name: string,
    readonly ip: string,
  ) {}

  /** `POST /api/agent/register` from this agent's address; whatever it hands out goes to `secrets`. */
  async register(): Promise<AgentAnswer> {
    const answer = await register(this.env, { name: this.name }, { 'x-forwarded-for': this.ip })
    addRegistrationSecrets(this.secrets, answer.body)
    return answer
  }

  /** A registration that must answer 200 with a usable project. */
  async registered(): Promise<Project> {
    const answer = await this.register()
    if (answer.status !== 200 || answer.error) fail(`register from ${this.ip} answered ${describe(answer)}, wanted 200`)
    const vars = dotenvVars(answer.body)
    const made = credentials({ register: answer, port: null })
    const namespace = vars.get('DEMETER_PROJECT_NAMESPACE') ?? ''
    const claimUrl = vars.get('DEMETER_CLAIM_URL') ?? ''
    if (!made || !NAMESPACE.test(namespace) || !claimUrl) fail('register answered 200 without a project id, API key, namespace and claim URL')
    return { ...made!, namespace, claimUrl, expiresAt: vars.get('DEMETER_EXPIRES_AT') ?? '' }
  }
}

/** `POST /api/agent/ports` on `project`; a port it hands out goes to `secrets`. */
export async function portOn(env: Environment, secrets: Secrets, project: Credentials, port: { kind: string; network: string } = J0_PORT): Promise<AgentAnswer> {
  const answer = await createPort(env, project, { ...port })
  addPortSecrets(secrets, answer.body)
  return answer
}

/** A port that must be created, 200 with its `_URL` and `_KEY`. */
export async function createdPort(env: Environment, secrets: Secrets, project: Credentials, port: { kind: string; network: string } = J0_PORT): Promise<Port> {
  const answer = await portOn(env, secrets, project, port)
  if (answer.status !== 200 || answer.error) fail(`${port.kind} on ${port.network} answered ${describe(answer)}, wanted 200`)
  const vars = [...dotenvVars(answer.body)]
  const url = vars.find(([name]) => name.endsWith('_URL'))?.[1]
  const key = vars.find(([name]) => name.endsWith('_KEY'))?.[1]
  if (!url || !key) fail(`${port.kind} on ${port.network} answered 200 without a _URL and a _KEY`)
  return { url: url!, key: key! }
}

/** One request to a port's data plane, with its key, as J0 makes it. */
export const dataRequest = (port: Port): Promise<AgentAnswer> =>
  call('GET', `${port.url.replace(/\/+$/, '')}${REQUEST_PATH}`, { headers: { 'dmtr-api-key': port.key }, timeoutMs: 15_000 })

/** A data-plane request that must answer 2xx. */
export async function answers(port: Port): Promise<string> {
  const answer = await dataRequest(port)
  if (answer.status === null || answer.status < 200 || answer.status >= 300) fail(`the port answered ${describe(answer)}, wanted 2xx`)
  return `${answer.status}`
}

/**
 * An error answer as the contract has it: the status and code of its table,
 * a JSON body with a message and the docs link, and no credential in it.
 */
export function expectError(answer: AgentAnswer, status: number, code: string, secrets: Secrets): ErrorBody {
  const body = errorBody(answer)
  if (answer.status !== status || body?.error !== code) fail(`answered ${describe(answer)}, wanted ${status} ${code}`)
  const problems = [
    typeof body!.message === 'string' && body!.message ? '' : 'it has no message',
    body!.docs === DOCS_URL ? '' : `docs is ${JSON.stringify(body!.docs)}, wanted "${DOCS_URL}"`,
    ...secrets.find(answer.body).map((kind) => `it carries the ${kind}`),
  ].filter(Boolean)
  if (problems.length) fail(`${status} ${code}, but ${problems.join('; ')}`)
  return body!
}

/**
 * An `ip_cap` refusal whose wait is the same in `retry_after_seconds` and
 * `Retry-After`, a whole number of seconds; returns it.
 */
export function expectIpCap(answer: AgentAnswer, secrets: Secrets): number {
  const body = expectError(answer, 429, 'ip_cap', secrets)
  const wait = body.retry_after_seconds
  if (!Number.isInteger(wait) || wait! < 1) fail(`retry_after_seconds is ${JSON.stringify(wait)}, wanted a whole number of seconds, at least 1`)
  if (answer.headers['retry-after'] !== String(wait)) fail(`Retry-After is "${answer.headers['retry-after'] ?? ''}", wanted "${wait}", as retry_after_seconds`)
  return wait!
}

/**
 * A person signed in to the mock, as a browser would be: the mock's sign-in
 * takes any user name, and its session cookie is kept, and concealed, for the
 * pages after it.
 */
export async function signedIn(env: Environment, secrets: Secrets, user: string) {
  const login = await call('POST', `${env.console}/login`, {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: user, password: 'mock' }).toString(),
  })
  const sid = /(?:^|, )mock_session=([^;]+)/.exec(login.headers['set-cookie'] ?? '')?.[1]
  if (login.status !== 302 || !sid) fail(`the mock's sign-in answered ${describe(login)} without a session, wanted 302 and a session cookie`)
  secrets.add('session cookie', sid)
  return (method: 'GET' | 'POST', path: string, form?: Record<string, string>) =>
    call(method, `${env.console}${path}`, {
      headers: { cookie: `mock_session=${sid}`, ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      ...(form ? { body: new URLSearchParams(form).toString() } : {}),
    })
}

/** The path of a claim URL on the mock; one elsewhere is never opened. */
export function claimPath(env: Environment, project: Project): string {
  const url = URL.canParse(project.claimUrl) ? new URL(project.claimUrl) : undefined
  if (!url || url.origin !== new URL(env.console).origin) fail(`DEMETER_CLAIM_URL is not on the mock (${env.console}), so it is not opened`)
  return url!.pathname
}
