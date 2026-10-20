import { randomUUID } from 'node:crypto'
import type { Environment } from '../env.ts'
import { catalog, preClaimNetworks } from '../mock/catalog.ts'
import { mockState, setMockState } from '../mock/control.ts'
import { errorStatus } from '../mock/server.ts'
import { Failure, type Run } from '../report.ts'
import {
  type AgentAnswer,
  addPortSecrets,
  addRegistrationSecrets,
  createPort,
  credentials,
  describe,
  dotenvVars,
  errorBody,
  J0_PORT,
  names,
  type Registration,
  register,
  type Secrets,
} from './client.ts'

/**
 * The registration-and-claim contract's HTTP rules, one test per rule, run
 * against any environment: the same file runs on the mock in CI and on
 * production in the daily probe, so the mock cannot drift from production
 * unnoticed (`solution/devex/contracts/registration-and-claim.md`, "HTTP for
 * agents" and "Errors").
 *
 * Each test is tagged:
 *
 * - `prod-safe`: it reads, or uses the run's own registration (one per run,
 *   which J0 then claims and deletes on production). It creates nothing else
 *   unless production breaks a rule.
 * - `mock-only`: it needs one of the mock's error states, or more ports than
 *   a production run may create.
 *
 * A test reports statuses, codes and line names, never a body: dotenv bodies
 * carry credentials.
 */

export type Tag = 'prod-safe' | 'mock-only'

export interface ContractContext {
  env: Environment
  /** The run's own registration and its first port; on production, J0's. */
  registration(): Promise<Registration>
  secrets: Secrets
}

export interface ContractTest {
  name: string
  tag: Tag
  run(ctx: ContractContext): Promise<string | void>
}

const tests: ContractTest[] = []
const test = (name: string, tag: Tag, run: ContractTest['run']) => void tests.push({ name, tag, run })

/** Every contract test, in the order they run. */
export const contractTests: readonly ContractTest[] = tests

const DOCS = 'https://demeter.run/auth.md'
const REGISTER_LINES = [
  'DEMETER_PROJECT_ID',
  'DEMETER_PROJECT_NAMESPACE',
  'DEMETER_API_KEY',
  'DEMETER_CLAIM_URL',
  'DEMETER_USER_CODE',
  'DEMETER_EXPIRES_AT',
]
/** A key with the right prefix that no project holds. */
const BAD_KEY = `dmtr_apikey1${'q'.repeat(58)}`

const fail = (message: string): never => {
  throw new Failure(message)
}

/** A dotenv answer as the contract has it: 200, `text/plain; charset=utf-8`, never cached. */
function expectDotenv(answer: AgentAnswer, route: string): void {
  if (answer.status !== 200 || answer.error) fail(`${route} answered ${describe(answer)}, wanted 200`)
  const problems = [
    answer.headers['content-type'] === 'text/plain; charset=utf-8' ? '' : `Content-Type is "${answer.headers['content-type'] ?? ''}", wanted "text/plain; charset=utf-8"`,
    answer.headers['cache-control'] === 'no-store' ? '' : `Cache-Control is "${answer.headers['cache-control'] ?? ''}", wanted "no-store"`,
  ].filter(Boolean)
  if (problems.length) fail(`${route}'s dotenv answer: ${problems.join('; ')}`)
}

/**
 * An error answer as the contract has it: the status and code of its table,
 * a JSON body `{error, message, docs}`, and no credential in it, neither one
 * the run holds nor one the request sent.
 */
function expectError(answer: AgentAnswer, status: number, code: string, secrets: Secrets) {
  const body = errorBody(answer)
  if (answer.status !== status || body?.error !== code) fail(`answered ${describe(answer)}, wanted ${status} ${code}`)
  const problems = [
    answer.headers['content-type']?.startsWith('application/json') ? '' : `Content-Type is "${answer.headers['content-type'] ?? ''}", wanted JSON`,
    typeof body!.message === 'string' && body!.message ? '' : 'it has no message',
    body!.docs === DOCS ? '' : `docs is ${JSON.stringify(body!.docs)}, wanted "${DOCS}"`,
    ...secrets.find(answer.body).map((kind) => `it carries the ${kind}`),
    answer.body.includes(BAD_KEY) ? 'it carries the key the request sent' : '',
  ].filter(Boolean)
  if (problems.length) fail(`${status} ${code}, but ${problems.join('; ')}`)
  return body!
}

/** The pre-claim credential of the run's registration; a test that needs it fails when there is none. */
async function credentialsOf(ctx: ContractContext) {
  return credentials(await ctx.registration()) ?? fail('the run has no registration to use: register failed')
}

/** A registration of a test's own, on the mock. */
async function registerOwn(ctx: ContractContext, name: string) {
  const answer = await register(ctx.env, { name })
  if (answer.status !== 200) fail(`register answered ${describe(answer)}, wanted 200`)
  addRegistrationSecrets(ctx.secrets, answer.body)
  return credentials({ register: answer, port: null }) ?? fail('register answered 200 without DEMETER_API_KEY and DEMETER_PROJECT_ID')
}

/** Switches a mock error state on for `fn`, and back to the route's previous state after it, pass or fail. */
async function withMockError(ctx: ContractContext, state: { route: 'register' | 'ports'; error: 'ip_cap' | 'global_cap' | 'registration_disabled'; retry_after_seconds?: number }, fn: () => Promise<string>) {
  const before = (await mockState(ctx.env)).errors[state.route]
  await setMockState(ctx.env, state)
  try {
    return await fn()
  } finally {
    await setMockState(ctx.env, { route: state.route, ...(before ?? { error: null }) })
  }
}

test('register answers a dotenv body of the six lines, in order', 'prod-safe', async (ctx) => {
  const { register: answer } = await ctx.registration()
  expectDotenv(answer, 'register')
  const got = names(answer.body)
  if (got.join() !== REGISTER_LINES.join()) fail(`register's lines are ${got.join(', ') || '(none)'}, wanted ${REGISTER_LINES.join(', ')}`)
  return `${got.length} lines in order`
})

test("register's values have the contract's formats", 'prod-safe', async (ctx) => {
  const { register: answer } = await ctx.registration()
  if (answer.status !== 200) fail(`register answered ${describe(answer)}, wanted 200`)
  const vars = dotenvVars(answer.body)
  const value = (name: string) => vars.get(name) ?? ''
  const claim = /^(.*)\/claim\/([A-Za-z0-9_-]+)$/.exec(value('DEMETER_CLAIM_URL'))
  const expires = Date.parse(value('DEMETER_EXPIRES_AT'))
  const sevenDays = Date.now() + 7 * 86_400_000
  const problems = [
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value('DEMETER_PROJECT_ID')) ? '' : 'DEMETER_PROJECT_ID is not a UUID',
    /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(value('DEMETER_PROJECT_NAMESPACE')) ? '' : 'DEMETER_PROJECT_NAMESPACE is not a namespace',
    /^dmtr_apikey1[0-9a-z]+$/.test(value('DEMETER_API_KEY')) ? '' : 'DEMETER_API_KEY is not dmtr_apikey1…',
    claim?.[1] === ctx.env.console ? '' : `DEMETER_CLAIM_URL is not ${ctx.env.console}/claim/<token>`,
    // 32 random bytes, base64url without padding.
    claim && claim[2]!.length === 43 ? '' : 'the claim token is not 32 bytes of base64url',
    /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/.test(value('DEMETER_USER_CODE'))
      ? ''
      : 'DEMETER_USER_CODE is not XXXX-XXXX in the contract alphabet',
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|\+00:00)$/.test(value('DEMETER_EXPIRES_AT'))
      ? ''
      : `DEMETER_EXPIRES_AT "${value('DEMETER_EXPIRES_AT')}" is not RFC 3339 UTC`,
    Number.isNaN(expires) || Math.abs(expires - sevenDays) <= 3_600_000 ? '' : `DEMETER_EXPIRES_AT ${value('DEMETER_EXPIRES_AT')} is not 7 days away`,
  ].filter(Boolean)
  if (problems.length) fail(problems.join('\n'))
  return `namespace ${value('DEMETER_PROJECT_NAMESPACE')}, expires ${value('DEMETER_EXPIRES_AT')}`
})

test('ports answers a dotenv body of _PORT_ID, _URL (then _URL_2, _URL_3…) and _KEY, in order', 'prod-safe', async (ctx) => {
  const { port } = await ctx.registration()
  if (!port) fail('no port was asked for: register failed')
  expectDotenv(port!, 'ports')
  const prefix = 'DEMETER_BLOCKFROST_PREPROD'
  const got = names(port!.body)
  const urls = got.slice(1, -1)
  const inOrder =
    got[0] === `${prefix}_PORT_ID` &&
    got.at(-1) === `${prefix}_KEY` &&
    urls.length > 0 &&
    urls.every((name, i) => name === (i === 0 ? `${prefix}_URL` : `${prefix}_URL_${i + 1}`))
  if (!inOrder) fail(`${J0_PORT.kind} on ${J0_PORT.network} answered ${got.join(', ') || '(no lines)'}, wanted ${prefix}_PORT_ID, ${prefix}_URL[, ${prefix}_URL_2…], ${prefix}_KEY`)
  const vars = dotenvVars(port!.body)
  const bad = [...vars].filter(([name, value]) => !value || (/_URL(_\d+)?$/.test(name) && !/^https?:\/\//.test(value))).map(([name]) => name)
  if (bad.length) fail(`${bad.join(', ')} ${bad.length === 1 ? 'is' : 'are'} empty or not a URL`)
  return got.join(', ')
})

// A 65-character name must be refused before fabric is called. Should
// production accept it, this registers a project that nobody claims and that
// expires in 7 days: a broken rule is worth that one.
test('a 65-character agent name is 400 invalid_request', 'prod-safe', async (ctx) => {
  const answer = await register(ctx.env, { name: 'e2e-j0-'.padEnd(65, 'x') })
  if (answer.status === 200) addRegistrationSecrets(ctx.secrets, answer.body)
  expectError(answer, 400, 'invalid_request', ctx.secrets)
  return describe(answer)
})

test('a bad API key on /ports is 401 unauthenticated', 'prod-safe', async (ctx) => {
  const projectId = credentials(await ctx.registration())?.projectId ?? randomUUID()
  const answer = await createPort(ctx.env, { apiKey: BAD_KEY, projectId }, { ...J0_PORT })
  expectError(answer, 401, 'unauthenticated', ctx.secrets)
  return describe(answer)
})

test('a mainnet port is 403 pre_claim_limit', 'prod-safe', async (ctx) => {
  const answer = await createPort(ctx.env, await credentialsOf(ctx), { kind: J0_PORT.kind, network: 'cardano-mainnet' })
  if (answer.status === 200) addPortSecrets(ctx.secrets, answer.body)
  expectError(answer, 403, 'pre_claim_limit', ctx.secrets)
  return describe(answer)
})

test('a tier other than 0 is 403 pre_claim_limit', 'prod-safe', async (ctx) => {
  const answer = await createPort(ctx.env, await credentialsOf(ctx), { ...J0_PORT, throughputTier: '1' })
  if (answer.status === 200) addPortSecrets(ctx.secrets, answer.body)
  expectError(answer, 403, 'pre_claim_limit', ctx.secrets)
  return describe(answer)
})

test('an unknown port kind is 400 invalid_request', 'prod-safe', async (ctx) => {
  const answer = await createPort(ctx.env, await credentialsOf(ctx), { kind: 'NoSuchPort', network: J0_PORT.network })
  expectError(answer, 400, 'invalid_request', ctx.secrets)
  return describe(answer)
})

// The mock's copy of fabric's catalog (`src/mock/catalog.ts`) against the
// environment's, read without creating anything: a request with a key no
// project holds passes every check the Console makes before fabric's, so a
// kind with an option on the network is refused only for its key (401), a
// kind without one is 403 and an unknown kind 400. The unknown kind's message
// names every kind the Console knows, which catches a kind the mock lacks.
test("the port catalog on preprod and preview is the mock's", 'prod-safe', async (ctx) => {
  const projectId = credentials(await ctx.registration())?.projectId ?? randomUUID()
  const problems: string[] = []
  for (const network of preClaimNetworks) {
    for (const [kind, networks] of Object.entries(catalog)) {
      const want = networks.includes(network) ? 'unauthenticated' : 'pre_claim_limit'
      const answer = await createPort(ctx.env, { apiKey: BAD_KEY, projectId }, { kind, network })
      if (answer.status === 200) addPortSecrets(ctx.secrets, answer.body)
      if (errorBody(answer)?.error !== want) problems.push(`${kind} on ${network} answered ${describe(answer)}, wanted ${errorStatus[want]} ${want}`)
    }
  }
  const unknown = await createPort(ctx.env, { apiKey: BAD_KEY, projectId }, { kind: 'NoSuchPort', network: J0_PORT.network })
  const listed = /use one of ([A-Za-z, ]+)\.$/.exec(errorBody(unknown)?.message ?? '')?.[1]?.split(', ')
  if (!listed) problems.push(`an unknown kind answered ${describe(unknown)} with no list of kinds, so a kind the mock lacks would go unseen`)
  else {
    const extra = listed.filter((kind) => !Object.hasOwn(catalog, kind))
    const missing = Object.keys(catalog).filter((kind) => !listed.includes(kind))
    if (extra.length) problems.push(`the Console knows ${extra.join(', ')}, which the mock does not`)
    if (missing.length) problems.push(`the mock knows ${missing.join(', ')}, which the Console does not`)
  }
  if (problems.length) fail(problems.join('\n'))
  return `${Object.keys(catalog).length} kinds on ${preClaimNetworks.join(' and ')}, as the mock has them`
})

test('an error body is JSON with error, message and docs, and never carries the key', 'prod-safe', async (ctx) => {
  // The run's real key, on a request refused for its body: the one error
  // whose request carries a working credential and reaches the route's end.
  const answer = await createPort(ctx.env, await credentialsOf(ctx), 'kind=BlockfrostPort')
  const body = expectError(answer, 400, 'invalid_request', ctx.secrets)
  return `${describe(answer)}, docs ${body.docs}`
})

test('ip_cap is 429 with retry_after_seconds and the same Retry-After', 'mock-only', async (ctx) =>
  withMockError(ctx, { route: 'register', error: 'ip_cap', retry_after_seconds: 4321 }, async () => {
    const answer = await register(ctx.env, { name: 'e2e-contract' })
    const body = expectError(answer, 429, 'ip_cap', ctx.secrets)
    if (body.retry_after_seconds !== 4321) fail(`retry_after_seconds is ${JSON.stringify(body.retry_after_seconds)}, wanted the mock's 4321`)
    if (answer.headers['retry-after'] !== '4321') fail(`Retry-After is "${answer.headers['retry-after'] ?? ''}", wanted "4321", as retry_after_seconds`)
    return `${describe(answer)}, retry after 4321 s`
  }),
)

test('the fourth port of an unclaimed project is 429 port_cap', 'mock-only', async (ctx) => {
  const own = await registerOwn(ctx, 'e2e-contract')
  const ports = [
    { kind: 'BlockfrostPort', network: 'cardano-preprod' },
    { kind: 'OgmiosPort', network: 'cardano-preprod' },
    { kind: 'KupoPort', network: 'cardano-preview' },
  ]
  for (const port of ports) {
    const answer = await createPort(ctx.env, own, port)
    if (answer.status !== 200) fail(`${port.kind} on ${port.network} answered ${describe(answer)}, wanted 200 before the cap`)
    addPortSecrets(ctx.secrets, answer.body)
  }
  const fourth = await createPort(ctx.env, own, { kind: 'UtxoRpcPort', network: 'cardano-preview' })
  expectError(fourth, 429, 'port_cap', ctx.secrets)
  return `3 ports, then ${describe(fourth)}`
})

test('global_cap is 503', 'mock-only', async (ctx) =>
  withMockError(ctx, { route: 'register', error: 'global_cap' }, async () => {
    const answer = await register(ctx.env, { name: 'e2e-contract' })
    expectError(answer, 503, 'global_cap', ctx.secrets)
    return describe(answer)
  }),
)

test('registration_disabled is 503', 'mock-only', async (ctx) =>
  withMockError(ctx, { route: 'register', error: 'registration_disabled' }, async () => {
    const answer = await register(ctx.env, { name: 'e2e-contract' })
    expectError(answer, 503, 'registration_disabled', ctx.secrets)
    return describe(answer)
  }),
)

test("an expired project's /ports is 410 expired", 'mock-only', async (ctx) => {
  const own = await registerOwn(ctx, 'e2e-contract')
  await setMockState(ctx.env, { project: own.projectId, expired: true })
  const answer = await createPort(ctx.env, own, { ...J0_PORT })
  expectError(answer, 410, 'expired', ctx.secrets)
  return describe(answer)
})

/** Runs the contract tests, every one or those of one tag, as steps of `run`. */
export async function runContract(run: Run, ctx: ContractContext, only?: Tag): Promise<void> {
  for (const t of tests.filter((t) => !only || t.tag === only)) await run.step(`[${t.tag}] ${t.name}`, () => t.run(ctx))
}
