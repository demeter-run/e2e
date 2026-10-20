import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, before, beforeEach, describe, it, mock as mocks } from 'node:test'
import { call, parseDotenv, registerWithPort, Secrets } from '../src/agent/client.ts'
import { contractTests, runContract } from '../src/agent/contract.spec.ts'
import { main } from '../src/cli/agent.ts'
import { type Environment, environment, environments } from '../src/env.ts'
import { resetMock } from '../src/mock/control.ts'
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

/**
 * The mock behind a server that rewrites what it answers, the way a drifted
 * mock or a broken production would. Calls to it are forwarded whole.
 */
async function rewriting(rewrite: (path: string, body: string) => string): Promise<Served> {
  return serve(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    const headers = Object.fromEntries(Object.entries(request.headers).flatMap(([k, v]) => (typeof v === 'string' && k !== 'host' ? [[k, v]] : [])))
    const body = Buffer.concat(chunks).toString('utf8')
    const answer = await call(request.method ?? 'GET', `${mock.url}${request.url}`, { headers, ...(body ? { body } : {}) })
    const out = rewrite(request.url ?? '', answer.body)
    const { 'transfer-encoding': _te, connection: _c, 'content-length': _cl, ...kept } = answer.headers
    response.writeHead(answer.status ?? 502, { ...kept, 'content-length': String(Buffer.byteLength(out)) })
    response.end(out)
  })
}

async function contractOn(target: Environment) {
  const secrets = new Secrets()
  const run = new Run('agent-contract', target.name)
  let made: ReturnType<typeof registerWithPort> | undefined
  await runContract(run, { env: target, secrets, registration: () => (made ??= registerWithPort(target, secrets, 'e2e-contract')) })
  return run.finish()
}

const failed = (result: Result) => result.steps.filter((s) => !s.ok).map((s) => s.name)

describe('the contract suite', () => {
  it('passes every test on the mock, prod-safe and mock-only', async () => {
    const result = await contractOn(env)
    assert.deepEqual(failed(result), [])
    assert.equal(result.steps.length, contractTests.length)
    assert.ok(contractTests.some((t) => t.tag === 'mock-only') && contractTests.some((t) => t.tag === 'prod-safe'))
  })

  it('fails when one dotenv line name drifts, which is the drift guard', async () => {
    const drifted = await rewriting((path, body) => (path === '/api/agent/register' ? body.replace('DEMETER_USER_CODE=', 'DEMETER_DEVICE_CODE=') : body))
    try {
      const result = await contractOn({ ...env, console: drifted.url })
      assert.deepEqual(failed(result), [
        '[prod-safe] register answers a dotenv body of the six lines, in order',
        "[prod-safe] register's values have the contract's formats",
      ])
      assert.match(result.steps[0]!.detail, /DEMETER_DEVICE_CODE/)
    } finally {
      await drifted.close()
    }
  })

  it('fails when a ports line moves out of order', async () => {
    const drifted = await rewriting((path, body) => {
      if (path !== '/api/agent/ports' || !body.includes('_KEY=')) return body
      const [id, url, key] = body.trimEnd().split('\n')
      return `${id}\n${key}\n${url}\n`
    })
    try {
      assert.ok(failed(await contractOn({ ...env, console: drifted.url })).includes('[prod-safe] ports answers a dotenv body of _PORT_ID, _URL (then _URL_2, _URL_3…) and _KEY, in order'))
    } finally {
      await drifted.close()
    }
  })

  it('fails an error body that carries the key the request sent, without printing it', async () => {
    let key = ''
    const leaky = await rewriting((path, body) => {
      if (path === '/api/agent/register' && body.includes('DEMETER_API_KEY=')) key = /DEMETER_API_KEY=(.*)/.exec(body)![1]!
      return body.startsWith('{"error"') ? body.replace('"message":"', `"message":"${key} `) : body
    })
    try {
      const result = await contractOn({ ...env, console: leaky.url })
      const step = result.steps.find((s) => s.name.startsWith('[prod-safe] an error body'))!
      assert.equal(step.ok, false)
      assert.match(step.detail, /carries the API key/)
      assert.ok(!JSON.stringify(result).includes(key), 'the result carries the key')
    } finally {
      await leaky.close()
    }
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
    assert.ok(result.steps.slice(0, -1).every((s) => s.name.startsWith('[mock-only]')))
  })

  it('refuses to run the contract alone on production, where only J0 may register', async () => {
    assert.equal(await run('contract', {}, '--env', 'production'), 2)
    assert.match(usageError(), /only inside J0/)
  })

  it('refuses J0 on production without the password, before registering anything', async () => {
    assert.equal(await run('j0', { E2E_USER_PASSWORD: undefined }, '--env', 'production', '--contract', 'prod-safe'), 2)
    assert.match(usageError(), /set E2E_USER_PASSWORD/)
    assert.deepEqual(await readdir(dir), [])
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

describe('parseDotenv', () => {
  it('keeps the order, and a line that is not NAME=value with no value', () => {
    assert.deepEqual(parseDotenv('A=1\nnot a line\nB_2=x=y\n'), [
      { name: 'A', value: '1' },
      { name: 'not a line', value: null },
      { name: 'B_2', value: 'x=y' },
    ])
  })
})
