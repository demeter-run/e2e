import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, before, beforeEach, describe, it, mock as mocks } from 'node:test'
import {
  type AgentAnswer,
  addRegistrationSecrets,
  call,
  dotenvVars,
  names,
  parseDotenv,
  registerWithPort,
  Secrets,
} from '../src/agent/client.ts'
import { contractTests, runContract } from '../src/agent/contract.spec.ts'
import { main } from '../src/cli/agent.ts'
import { type Environment, environment, environments } from '../src/env.ts'
import { mockState, resetMock, setMockState } from '../src/mock/control.ts'
import { type Mock, startMock } from '../src/mock/server.ts'
import { Run, type Result } from '../src/report.ts'
import { type Served, serve, withEnv } from './helpers.ts'

let mock: Mock
let env: Environment

before(async () => {
  mock = await startMock({ port: 0 })
  env = { ...environments.mock, console: mock.url }
})
after(() => mock.close())
beforeEach(() => resetMock(env))

/** A request as the rewriting proxy forwards it. */
interface Seen {
  method: string
  path: string
  headers: Record<string, string>
  body: string
}

/**
 * The mock behind a server that rewrites what it answers (status, headers,
 * body), the way a drifted mock or a broken production would. Calls to it are
 * forwarded whole, and the mock's origin in what it answers becomes the
 * proxy's, as `--base-url` would write it.
 */
async function rewriting(rewrite: (answer: AgentAnswer, request: Seen) => AgentAnswer): Promise<Served> {
  let self = ''
  const served = await serve(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    const headers = Object.fromEntries(Object.entries(request.headers).flatMap(([k, v]) => (typeof v === 'string' && k !== 'host' ? [[k, v]] : [])))
    const body = Buffer.concat(chunks).toString('utf8')
    const answer = await call(request.method ?? 'GET', `${mock.url}${request.url}`, { headers, ...(body ? { body } : {}) })
    const out = rewrite({ ...answer, body: answer.body.split(mock.url).join(self) }, { method: request.method ?? 'GET', path: request.url ?? '', headers, body })
    const { 'transfer-encoding': _te, connection: _c, 'content-length': _cl, ...kept } = out.headers
    response.writeHead(out.status ?? 502, { ...kept, 'content-length': String(Buffer.byteLength(out.body)) })
    response.end(out.body)
  })
  self = served.url
  return served
}

/** A rewrite of the bodies of one path only. */
const onBody =
  (path: string, edit: (body: string) => string) =>
  (answer: AgentAnswer, request: Seen): AgentAnswer =>
    request.path === path ? { ...answer, body: edit(answer.body) } : answer

/** A rewrite of the contract's error answers only. */
const onError =
  (edit: (answer: AgentAnswer, request: Seen) => AgentAnswer) =>
  (answer: AgentAnswer, request: Seen): AgentAnswer =>
    answer.body.startsWith('{"error"') ? edit(answer, request) : answer

async function contractOn(target: Environment) {
  const secrets = new Secrets()
  const run = new Run('agent-contract', target.name)
  let made: ReturnType<typeof registerWithPort> | undefined
  await runContract(run, { env: target, secrets, registration: () => (made ??= registerWithPort(target, secrets, 'e2e-contract')) })
  return run.finish()
}

/** The contract suite's result through a proxy making `rewrite`. */
async function contractThrough(rewrite: (answer: AgentAnswer, request: Seen) => AgentAnswer): Promise<Result> {
  const proxy = await rewriting(rewrite)
  try {
    return await contractOn({ ...env, console: proxy.url })
  } finally {
    await proxy.close()
  }
}

const failed = (result: Result) => result.steps.filter((s) => !s.ok).map((s) => s.name)

/** The detail of the step whose name starts with `prefix`, which must have failed. */
function failedDetail(result: Result, prefix: string): string {
  const step = result.steps.find((s) => s.name.startsWith(prefix))
  assert.ok(step, `no step starts with ${prefix}`)
  assert.equal(step.ok, false, `${step.name} passed: ${step.detail}`)
  return step.detail
}

describe('the contract suite', () => {
  it('passes every test on the mock, prod-safe and mock-only', async () => {
    const result = await contractOn(env)
    assert.deepEqual(failed(result), [])
    assert.equal(result.steps.length, contractTests.length)
    assert.ok(contractTests.some((t) => t.tag === 'mock-only') && contractTests.some((t) => t.tag === 'prod-safe'))
  })

  it('passes through a proxy that changes nothing, so the tests below fail for their rewrite alone', async () => {
    assert.deepEqual(failed(await contractThrough((answer) => answer)), [])
  })

  it('fails when one dotenv line name drifts, which is the drift guard', async () => {
    const result = await contractThrough(onBody('/api/agent/register', (body) => body.replace('DEMETER_USER_CODE=', 'DEMETER_DEVICE_CODE=')))
    assert.deepEqual(failed(result), [
      '[prod-safe] register answers a dotenv body of the six lines, in order',
      "[prod-safe] register's values have the contract's formats",
    ])
    assert.match(result.steps[0]!.detail, /DEMETER_DEVICE_CODE/)
  })

  it('fails when a ports line moves out of order', async () => {
    const result = await contractThrough(
      onBody('/api/agent/ports', (body) => {
        if (!body.includes('_KEY=')) return body
        const [id, url, key] = body.trimEnd().split('\n')
        return `${id}\n${key}\n${url}\n`
      }),
    )
    assert.deepEqual(failed(result), ['[prod-safe] ports answers a dotenv body of _PORT_ID, _URL (then _URL_2, _URL_3…) and _KEY, in order'])
  })

  it('fails a body in another form (CRLF, export, spaces), naming its lines and never printing a value', async () => {
    let body = ''
    const result = await contractThrough(
      onBody('/api/agent/register', (text) => {
        if (!text.includes('DEMETER_API_KEY=')) return text
        const lines = text.trimEnd().split('\n')
        body = [lines[0], `export ${lines[1]}`, lines[2]!.replace('=', ' = '), ...lines.slice(3).map((l) => `${l}\r`)].join('\n')
        return `${body}\n`
      }),
    )
    const detail = failedDetail(result, '[prod-safe] register answers a dotenv body')
    assert.match(detail, /DEMETER_PROJECT_NAMESPACE \(not NAME=value\), DEMETER_API_KEY \(not NAME=value\), DEMETER_CLAIM_URL \(not NAME=value\)/)
    const vars = dotenvVars(body)
    for (const value of [vars.get('DEMETER_API_KEY')!, vars.get('DEMETER_USER_CODE')!, new URL(vars.get('DEMETER_CLAIM_URL')!).pathname]) {
      assert.ok(value.length >= 9 && !JSON.stringify(result).includes(value), `the result carries ${value.slice(0, 4)}…`)
    }
  })

  it('fails a dotenv answer that may be cached', async () => {
    const result = await contractThrough((answer, request) =>
      request.path === '/api/agent/register' ? { ...answer, headers: { ...answer.headers, 'cache-control': 'private' } } : answer,
    )
    assert.deepEqual(failed(result), ['[prod-safe] register answers a dotenv body of the six lines, in order'])
    assert.match(result.steps[0]!.detail, /Cache-Control is "private", wanted "no-store"/)
  })

  it("fails an error whose status alone drifts, and one whose code alone does", async () => {
    const status = await contractThrough(onError((answer) => (answer.status === 401 ? { ...answer, status: 403 } : answer)))
    assert.match(failedDetail(status, '[prod-safe] a bad API key'), /answered 403 unauthenticated, wanted 401 unauthenticated/)
    const code = await contractThrough(
      onError((answer, request) => (request.path === '/api/agent/register' ? { ...answer, body: answer.body.replace('"invalid_request"', '"bad_request"') } : answer)),
    )
    assert.deepEqual(failed(code), ['[prod-safe] a 65-character agent name is 400 invalid_request'])
    assert.match(code.steps.find((s) => !s.ok)!.detail, /answered 400 bad_request, wanted 400 invalid_request/)
  })

  it('fails an error that is not JSON, or whose docs link moved', async () => {
    const text = await contractThrough(onError((answer) => ({ ...answer, headers: { ...answer.headers, 'content-type': 'text/plain' } })))
    assert.match(failedDetail(text, '[prod-safe] a 65-character'), /Content-Type is "text\/plain", wanted JSON/)
    const docs = await contractThrough(onError((answer) => ({ ...answer, body: answer.body.replace('https://demeter.run/auth.md', 'https://demeter.run/docs') })))
    assert.match(failedDetail(docs, '[prod-safe] a bad API key'), /docs is "https:\/\/demeter.run\/docs", wanted "https:\/\/demeter.run\/auth.md"/)
  })

  it('fails an error body that carries the key the request sent, without printing it', async () => {
    const result = await contractThrough(
      onError((answer, request) =>
        request.headers['dmtr-api-key'] ? { ...answer, body: answer.body.replace('"message":"', `"message":"${request.headers['dmtr-api-key']} `) } : answer,
      ),
    )
    assert.match(failedDetail(result, '[prod-safe] a bad API key'), /carries the key the request sent/)
    assert.match(failedDetail(result, '[prod-safe] an error body'), /carries the API key/)
    assert.ok(!JSON.stringify(result).includes('dmtr_apikey1'), 'the result carries a key')
  })

  it('fails a claim token of another length, and an expiry other than 7 days away', async () => {
    const token = await contractThrough(onBody('/api/agent/register', (body) => body.replace(/(\/claim\/[A-Za-z0-9_-]+)[A-Za-z0-9_-]\n/, '$1\n')))
    assert.match(failedDetail(token, "[prod-safe] register's values"), /^the claim token is not 32 bytes of base64url$/)
    const sixDays = new Date(Date.now() + 6 * 86_400_000).toISOString().replace('Z', '+00:00')
    const expiry = await contractThrough(onBody('/api/agent/register', (body) => body.replace(/DEMETER_EXPIRES_AT=.*/, `DEMETER_EXPIRES_AT=${sixDays}`)))
    assert.match(failedDetail(expiry, "[prod-safe] register's values"), /^DEMETER_EXPIRES_AT .* is not 7 days away$/)
  })

  it('fails an ip_cap whose Retry-After differs from retry_after_seconds', async () => {
    const result = await contractThrough((answer) => (answer.headers['retry-after'] ? { ...answer, headers: { ...answer.headers, 'retry-after': '60' } } : answer))
    assert.deepEqual(failed(result), ['[mock-only] ip_cap is 429 with retry_after_seconds and the same Retry-After'])
    assert.match(result.steps.find((s) => !s.ok)!.detail, /Retry-After is "60", wanted "4321"/)
  })

  it("fails when the Console's port catalog drifts from the mock's", async () => {
    const gone = await contractThrough((answer, request) =>
      request.path === '/api/agent/ports' && request.body.includes('"KupoPort"') && request.body.includes('cardano-preview') && answer.status === 401
        ? { ...answer, status: 400, body: answer.body.replace('"unauthenticated"', '"invalid_request"') }
        : answer,
    )
    assert.deepEqual(failed(gone), ["[prod-safe] the port catalog on preprod and preview is the mock's"])
    assert.match(gone.steps.find((s) => !s.ok)!.detail, /^KupoPort on cardano-preview answered 400 invalid_request, wanted 401 unauthenticated$/)
    const added = await contractThrough(onError((answer) => ({ ...answer, body: answer.body.replace('UtxoRpcPort.', 'UtxoRpcPort, WarpPort.') })))
    assert.match(failedDetail(added, '[prod-safe] the port catalog'), /^the Console knows WarpPort, which the mock does not$/)
  })

  it("switches a mock error state on for one test and puts the route's previous state back", async () => {
    await setMockState(env, { route: 'register', error: 'registration_disabled' })
    const globalCap = contractTests.find((t) => t.name === 'global_cap is 503')!
    await globalCap.run({ env, secrets: new Secrets(), registration: () => Promise.reject(new Error('unused')) })
    assert.deepEqual((await mockState(env)).errors, { register: { error: 'registration_disabled' } })
  })
})

describe('the agent CLI', () => {
  let dir: string
  let log: ReturnType<typeof mocks.method>
  let error: ReturnType<typeof mocks.method>

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'e2e-agent-'))
    log = mocks.method(console, 'log', () => {})
    error = mocks.method(console, 'error', () => {})
  })
  afterEach(async () => {
    log.mock.restore()
    error.mock.restore()
    await rm(dir, { recursive: true, force: true })
  })

  const lookup = (name: string) => (name === 'mock' ? env : environment(name))
  const quiet = { IRM_E2E_WEBHOOK_URL: undefined, GITHUB_STEP_SUMMARY: undefined, GITHUB_ACTIONS: undefined }
  const run = (suite: 'j0' | 'contract', vars: Record<string, string | undefined>, ...argv: string[]) =>
    withEnv({ ...quiet, ...vars }, () => main(suite, [...argv, '--results', dir], { lookup }))
  const usageError = () => String(error.mock.calls[0]?.arguments[0]).split('\n')[0] ?? ''

  it('runs the contract on the mock and writes its result, with the leak check last', async () => {
    assert.equal(await run('contract', {}, '--env', 'mock'), 0)
    assert.deepEqual(await readdir(dir), ['agent-contract.json'])
    const result = JSON.parse(await readFile(join(dir, 'agent-contract.json'), 'utf8')) as Result
    assert.equal(result.ok, true)
    assert.equal(result.steps.at(-1)!.name, 'no credential in a result or the call log')
  })

  it('runs only the tests of one tag', async () => {
    assert.equal(await run('contract', {}, '--env', 'mock', '--tag', 'mock-only'), 0)
    const result = JSON.parse(await readFile(join(dir, 'agent-contract.json'), 'utf8')) as Result
    assert.ok(result.steps.slice(1, -1).every((s) => s.name.startsWith('[mock-only]')))
  })

  it('starts from an empty mock, so an error state another client left on fails nothing', async () => {
    await setMockState(env, { route: 'register', error: 'ip_cap' })
    assert.equal(await run('contract', {}, '--env', 'mock'), 0)
    const result = JSON.parse(await readFile(join(dir, 'agent-contract.json'), 'utf8')) as Result
    assert.equal(result.steps[0]!.name, 'start from an empty mock')
  })

  it('fails the leak check, exits 1 and writes a scrubbed result, when a credential reaches a result', async () => {
    // A Console that names the API key as its error code, which a test prints.
    let key = ''
    const leaky = await rewriting((answer, request) => {
      if (request.path === '/api/agent/register' && answer.status === 200) key = dotenvVars(answer.body).get('DEMETER_API_KEY') ?? key
      return request.path === '/api/agent/ports' && answer.status === 401 ? { ...answer, body: answer.body.replace('"unauthenticated"', JSON.stringify(key)) } : answer
    })
    try {
      const code = await withEnv({ ...quiet }, () => main('contract', ['--env', 'mock', '--results', dir], { lookup: () => ({ ...env, console: leaky.url }) }))
      assert.equal(code, 1)
      const written = await readFile(join(dir, 'agent-contract.json'), 'utf8')
      const leak = (JSON.parse(written) as Result).steps.at(-1)!
      assert.deepEqual([leak.name, leak.ok, leak.detail], ['no credential in a result or the call log', false, 'the agent-contract result carries the API key'])
      assert.ok(key && !written.includes(key), 'the written result carries the key')
    } finally {
      await leaky.close()
    }
  })

  it('refuses to run the contract alone on production, where only J0 may register', async () => {
    assert.equal(await run('contract', {}, '--env', 'production'), 2)
    assert.match(usageError(), /only inside J0/)
  })

  it('fails J0 on production without the password in a result its alert carries, registering nothing', async () => {
    assert.equal(await run('j0', { E2E_USER_PASSWORD: undefined }, '--env', 'production', '--contract', 'prod-safe', '--alert'), 1)
    assert.deepEqual(await readdir(dir), ['j0.json'])
    const result = JSON.parse(await readFile(join(dir, 'j0.json'), 'utf8')) as Result
    assert.deepEqual(
      result.steps.map((s) => [s.name, s.ok]),
      [
        ['sign in as e2e@txpipe.io', false],
        ['no credential in a result or the call log', true],
      ],
    )
    assert.match(result.steps[0]!.detail, /E2E_USER_PASSWORD is not set/)
    assert.ok(log.mock.calls.some((c) => /alert skipped for j0/.test(String(c.arguments[0]))), 'no alert was tried')
  })

  it("refuses the mock-only tests on production, which has no error states to switch", async () => {
    assert.equal(await run('j0', { E2E_USER_PASSWORD: 'x' }, '--env', 'production', '--contract', 'all'), 2)
    assert.match(usageError(), /--contract prod-safe off the mock/)
  })

  it('refuses a flag of the other suite, or a value it does not know', async () => {
    assert.equal(await run('j0', {}, '--env', 'mock', '--tag', 'prod-safe'), 2)
    assert.equal(await run('contract', {}, '--env', 'mock', '--contract', 'all'), 2)
    assert.equal(await run('j0', {}, '--env', 'mock', '--contract', 'some'), 2)
    assert.equal(await run('contract', {}, '--env', 'nowhere'), 2)
  })
})

describe('Secrets', () => {
  it('scrubs the longest credential first and names the kinds a text carries', () => {
    const secrets = new Secrets()
    secrets.add('API key', 'dmtr_apikey1abcdef')
    secrets.add('claim token', 'dmtr_apikey1abcdef-and-more')
    secrets.add('short', 'abc')
    assert.equal(secrets.scrub('a dmtr_apikey1abcdef-and-more b dmtr_apikey1abcdef abc'), 'a [redacted] b [redacted] abc')
    assert.deepEqual(secrets.find('x dmtr_apikey1abcdef y'), ['API key'])
    assert.equal(secrets.size, 2)
  })

  it('masks each credential in the GitHub Actions log as it arrives', async () => {
    const log = mocks.method(console, 'log', () => {})
    try {
      await withEnv({ GITHUB_ACTIONS: 'true' }, () => new Secrets().add('API key', 'dmtr_apikey1abcdef'))
      assert.deepEqual(log.mock.calls.map((c) => c.arguments[0]), ['::add-mask::dmtr_apikey1abcdef'])
    } finally {
      log.mock.restore()
    }
  })
})

describe('parseDotenv and dotenvVars', () => {
  it('keeps the order, and a line that is not NAME=value with no value and only the name it seems to carry', () => {
    assert.deepEqual(parseDotenv('A=1\nnot a line\nB_2=x=y\nexport C=secret\nD = secret\nE=secret\r\n'), [
      { name: 'A', value: '1' },
      { name: '(a line that is not NAME=value)', value: null },
      { name: 'B_2', value: 'x=y' },
      { name: 'C (not NAME=value)', value: null },
      { name: 'D (not NAME=value)', value: null },
      { name: 'E (not NAME=value)', value: null },
    ])
    assert.ok(!names('X=1\nsecret-value-here\nY = secret-value-here\n').join().includes('secret'))
  })

  it('reads values as leniently as a dotenv loader, so a body in another form still yields its credentials', () => {
    assert.deepEqual([...dotenvVars('A=1\r\nexport B=two\nC = "three"\n  D=\'4\'\nnot a line\nE=x=y\n')], [
      ['A', '1'],
      ['B', 'two'],
      ['C', 'three'],
      ['D', '4'],
      ['E', 'x=y'],
    ])
  })
})

describe('the credentials a body hands out', () => {
  it('takes the claim URL whole and its token from the path or the query, and the user code with and without its hyphen', () => {
    const secrets = new Secrets()
    addRegistrationSecrets(
      secrets,
      'DEMETER_API_KEY=dmtr_apikey1aaaaaaaa\nDEMETER_CLAIM_URL=https://console.example/claim?token=tok%2Ben-in-query&x=1\nDEMETER_USER_CODE=ABCD-2345\n',
    )
    const text = 'https://console.example/claim?token=tok%2Ben-in-query&x=1 /claim?token=tok%2Ben-in-query tok+en-in-query ABCD2345 ABCD-2345 dmtr_apikey1aaaaaaaa'
    assert.equal(secrets.scrub(text), '[redacted] /claim?token=[redacted] [redacted] [redacted] [redacted] [redacted]')
  })

  it('takes every dmtr_ key in a body, whatever its line looks like', () => {
    const secrets = new Secrets()
    addRegistrationSecrets(secrets, 'export DEMETER_API_KEY = "dmtr_apikey1bbbbbbbb"\r\nsomething dmtr_apikey1cccccccc\n')
    assert.equal(secrets.scrub('dmtr_apikey1bbbbbbbb dmtr_apikey1cccccccc'), '[redacted] [redacted]')
  })
})
