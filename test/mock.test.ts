import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import { type AgentAnswer, call, createPort, type Credentials, dotenvVars, errorBody, names, register } from '../src/agent/client.ts'
import { type Environment, environments } from '../src/env.ts'
import { mockCalls, resetMock, setMockState } from '../src/mock/control.ts'
import { type Mock, startMock } from '../src/mock/server.ts'

let mock: Mock
let env: Environment

before(async () => {
  mock = await startMock({ port: 0 })
  env = { ...environments.mock, console: mock.url }
})
after(() => mock.close())
beforeEach(() => resetMock(env))

const BLOCKFROST = { kind: 'BlockfrostPort', network: 'cardano-preprod' }

async function registered(name = 'test-agent') {
  const answer = await register(env, { name })
  assert.equal(answer.status, 200)
  const vars = dotenvVars(answer.body)
  return { vars, credentials: { apiKey: vars.get('DEMETER_API_KEY')!, projectId: vars.get('DEMETER_PROJECT_ID')! } satisfies Credentials }
}

const codeOf = (answer: AgentAnswer) => [answer.status, errorBody(answer)?.error]

/** A browser's session on the mock: a cookie jar over `call`. */
function browser() {
  const jar = new Map<string, string>()
  return async (method: string, path: string, form?: Record<string, string>) => {
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
    const answer = await call(method, `${mock.url}${path}`, {
      headers: { ...(cookie ? { cookie } : {}), ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      ...(form ? { body: new URLSearchParams(form).toString() } : {}),
    })
    for (const set of (answer.headers['set-cookie'] ?? '').split(/, (?=[a-z_]+=)/)) {
      const [pair = ''] = set.split(';')
      const at = pair.indexOf('=')
      if (at > 0) jar.set(pair.slice(0, at), pair.slice(at + 1))
    }
    return answer
  }
}

describe('the mock: register', () => {
  it('answers the six dotenv lines in order, uncached, with credentials in the contract formats', async () => {
    const answer = await register(env, { name: 'claude-code', version: '2.1.0' })
    assert.equal(answer.status, 200)
    assert.equal(answer.headers['content-type'], 'text/plain; charset=utf-8')
    assert.equal(answer.headers['cache-control'], 'no-store')
    assert.deepEqual(names(answer.body), [
      'DEMETER_PROJECT_ID',
      'DEMETER_PROJECT_NAMESPACE',
      'DEMETER_API_KEY',
      'DEMETER_CLAIM_URL',
      'DEMETER_USER_CODE',
      'DEMETER_EXPIRES_AT',
    ])
    const vars = dotenvVars(answer.body)
    assert.match(vars.get('DEMETER_API_KEY')!, /^dmtr_apikey1[0-9a-z]{58}$/)
    assert.match(vars.get('DEMETER_CLAIM_URL')!, new RegExp(`^${mock.url}/claim/[A-Za-z0-9_-]{43}$`))
    assert.match(vars.get('DEMETER_USER_CODE')!, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/)
    const days = (Date.parse(vars.get('DEMETER_EXPIRES_AT')!) - Date.now()) / 86_400_000
    assert.ok(days > 6.99 && days <= 7, `expires in ${days} days`)
  })

  it('refuses a missing, empty or 65-character name, and an oversized version, with 400 invalid_request', async () => {
    for (const agent of [{}, { name: '  ' }, { name: 'x'.repeat(65) }, { name: 'ok', version: 'v'.repeat(257) }]) {
      assert.deepEqual(codeOf(await register(env, agent)), [400, 'invalid_request'], JSON.stringify(agent))
    }
    // Characters, not bytes, as the Console counts them.
    assert.equal((await register(env, { name: '🦀'.repeat(64) })).status, 200)
  })

  it('refuses a body that is not JSON with 400, and GET with 405', async () => {
    assert.deepEqual(codeOf(await call('POST', `${mock.url}/api/agent/register`, { body: 'agent=x' })), [400, 'invalid_request'])
    assert.deepEqual(codeOf(await call('GET', `${mock.url}/api/agent/register`)), [405, 'invalid_request'])
  })
})

describe('the mock: ports', () => {
  it('answers _PORT_ID, _URL and _KEY, and the URL answers with the key and refuses without it', async () => {
    const { credentials } = await registered()
    const answer = await createPort(env, credentials, BLOCKFROST)
    assert.equal(answer.status, 200)
    assert.equal(answer.headers['cache-control'], 'no-store')
    assert.deepEqual(names(answer.body), ['DEMETER_BLOCKFROST_PREPROD_PORT_ID', 'DEMETER_BLOCKFROST_PREPROD_URL', 'DEMETER_BLOCKFROST_PREPROD_KEY'])
    const vars = dotenvVars(answer.body)
    const url = `${vars.get('DEMETER_BLOCKFROST_PREPROD_URL')}/blocks/latest`
    assert.equal(url, `${mock.url}/data/${vars.get('DEMETER_BLOCKFROST_PREPROD_PORT_ID')}/blocks/latest`)
    assert.equal((await call('GET', url, { headers: { 'dmtr-api-key': vars.get('DEMETER_BLOCKFROST_PREPROD_KEY')! } })).status, 200)
    assert.equal((await call('GET', url, { headers: { 'dmtr-api-key': credentials.apiKey } })).status, 401)
    assert.equal((await call('GET', url)).status, 401)
  })

  it("names a db-sync port's key username:password", async () => {
    const { credentials } = await registered()
    const vars = dotenvVars((await createPort(env, credentials, { kind: 'dbsyncport', network: 'cardano-preview' })).body)
    assert.match(vars.get('DEMETER_DBSYNC_PREVIEW_KEY')!, /^dmtr_user[0-9a-z]+:[0-9a-z]+$/)
  })

  it('checks the request in production order: credentials present, body, network and tier, kind, then the key', async () => {
    const { credentials } = await registered()
    const bad = { ...credentials, apiKey: 'dmtr_apikey1nope' }
    const cases: [Credentials, Record<string, unknown> | string, number, string][] = [
      [{ apiKey: '', projectId: credentials.projectId }, BLOCKFROST, 401, 'unauthenticated'],
      [credentials, 'kind=BlockfrostPort', 400, 'invalid_request'],
      [credentials, { kind: 'BlockfrostPort' }, 400, 'invalid_request'],
      // The route refuses mainnet and paid tiers before fabric checks the key.
      [bad, { kind: 'BlockfrostPort', network: 'cardano-mainnet' }, 403, 'pre_claim_limit'],
      [bad, { ...BLOCKFROST, throughputTier: 1 }, 403, 'pre_claim_limit'],
      [credentials, { kind: 'NoSuchPort', network: 'cardano-preprod' }, 400, 'invalid_request'],
      // Mumak names its networks without the cardano- prefix: no option.
      [credentials, { kind: 'MumakPort', network: 'cardano-preprod' }, 403, 'pre_claim_limit'],
      [bad, BLOCKFROST, 401, 'unauthenticated'],
      [{ ...credentials, projectId: 'no-such-project' }, BLOCKFROST, 401, 'unauthenticated'],
    ]
    for (const [creds, body, status, code] of cases) {
      assert.deepEqual(codeOf(await createPort(env, creds, body)), [status, code], JSON.stringify(body))
    }
  })

  it('caps an unclaimed project at 3 ports with 429 port_cap', async () => {
    const { credentials } = await registered()
    for (let i = 0; i < 3; i++) assert.equal((await createPort(env, credentials, BLOCKFROST)).status, 200)
    assert.deepEqual(codeOf(await createPort(env, credentials, BLOCKFROST)), [429, 'port_cap'])
  })

  it('never puts a credential in an error body', async () => {
    const { credentials } = await registered()
    for (const body of [{ kind: 'BlockfrostPort', network: 'cardano-mainnet' }, 'not json', { kind: 'NoSuchPort', network: 'cardano-preprod' }]) {
      const answer = await createPort(env, credentials, body)
      assert.equal(errorBody(answer)?.docs, 'https://demeter.run/auth.md')
      assert.ok(!answer.body.includes(credentials.apiKey))
    }
  })
})

describe('the mock: error states', () => {
  it('answers ip_cap with retry_after_seconds and Retry-After: 86400 by default, or the wait switched on', async () => {
    await setMockState(env, { route: 'register', error: 'ip_cap' })
    let answer = await register(env, { name: 'a' })
    assert.deepEqual([answer.status, errorBody(answer)?.retry_after_seconds, answer.headers['retry-after']], [429, 86400, '86400'])
    await setMockState(env, { route: 'register', error: 'ip_cap', retry_after_seconds: 60 })
    answer = await register(env, { name: 'a' })
    assert.deepEqual([errorBody(answer)?.retry_after_seconds, answer.headers['retry-after']], [60, '60'])
    await setMockState(env, { route: 'register', error: null })
    assert.equal((await register(env, { name: 'a' })).status, 200)
  })

  it('answers any code of the table on either route, with its status, and Retry-After only with ip_cap', async () => {
    const { credentials } = await registered()
    const table: [string, number][] = [
      ['invalid_request', 400],
      ['unauthenticated', 401],
      ['pre_claim_limit', 403],
      ['expired', 410],
      ['port_cap', 429],
      ['global_cap', 503],
      ['registration_disabled', 503],
    ]
    for (const [error, status] of table) {
      await setMockState(env, { route: 'ports', error: error as never })
      const answer = await createPort(env, credentials, BLOCKFROST)
      assert.deepEqual(codeOf(answer), [status, error])
      assert.equal(answer.headers['retry-after'], undefined)
    }
  })

  it('expires a project: its /ports is 410 expired, its URL stops answering, and its claim link shows expired', async () => {
    const { credentials, vars } = await registered()
    const port = dotenvVars((await createPort(env, credentials, BLOCKFROST)).body)
    await setMockState(env, { project: vars.get('DEMETER_PROJECT_NAMESPACE')!, expired: true })
    assert.deepEqual(codeOf(await createPort(env, credentials, BLOCKFROST)), [410, 'expired'])
    const url = `${port.get('DEMETER_BLOCKFROST_PREPROD_URL')}/blocks/latest`
    assert.equal((await call('GET', url, { headers: { 'dmtr-api-key': port.get('DEMETER_BLOCKFROST_PREPROD_KEY')! } })).status, 401)
    const visit = browser()
    await visit('POST', '/login', { username: 'alice', password: 'x' })
    assert.match((await visit('GET', new URL(vars.get('DEMETER_CLAIM_URL')!).pathname)).body, /This link has expired or was already used/)
  })

  it('refuses a state it does not know with 400, and an unknown project with 404', async () => {
    const post = (body: unknown) => call('POST', `${mock.url}/__mock/state`, { body: JSON.stringify(body) })
    assert.equal((await post({ route: 'register', error: 'teapot' })).status, 400)
    assert.equal((await post({ route: 'register', error: 'ip_cap', retry_after_seconds: 0 })).status, 400)
    assert.equal((await post({ project: 'nope', expired: true })).status, 404)
    assert.equal((await post({})).status, 400)
  })
})

describe('the mock: claim pages', () => {
  it('claims through the link: sign in first, then the default name, then the ports page; the token is void after', async () => {
    const { vars, credentials } = await registered('e2e-test')
    const port = dotenvVars((await createPort(env, credentials, BLOCKFROST)).body)
    const namespace = vars.get('DEMETER_PROJECT_NAMESPACE')!
    const claim = new URL(vars.get('DEMETER_CLAIM_URL')!).pathname
    const visit = browser()

    const signedOut = await visit('GET', claim)
    assert.match(signedOut.body, /<a href="\/login">Log in<\/a>/)
    const login = await visit('POST', '/login', { username: 'alice', password: 'anything', action: 'default' })
    assert.deepEqual([login.status, login.headers.location], [302, claim])

    const view = (await visit('GET', claim)).body
    assert.match(view, new RegExp(`<h1>Claim ${namespace}</h1>`))
    assert.match(view, /e2e-test/)
    assert.match(view, /BlockfrostPort · cardano-preprod/)
    assert.match(view, new RegExp(`name="name" value="${namespace}"`))
    assert.ok(!view.includes(credentials.apiKey) && !view.includes(port.get('DEMETER_BLOCKFROST_PREPROD_KEY')!), 'the claim page shows no key')

    const claimed = await visit('POST', claim, { name: '' })
    assert.deepEqual([claimed.status, claimed.headers.location], [302, `/${namespace}/ports`])
    assert.match((await visit('GET', `/${namespace}/ports`)).body, new RegExp(`Project ${namespace} \\(${namespace}\\)`))
    assert.match((await visit('GET', claim)).body, /This link has expired or was already used/)

    // Owned now: the key keeps working, and the pre-claim port cap is gone.
    const url = `${port.get('DEMETER_BLOCKFROST_PREPROD_URL')}/blocks/latest`
    assert.equal((await call('GET', url, { headers: { 'dmtr-api-key': port.get('DEMETER_BLOCKFROST_PREPROD_KEY')! } })).status, 200)
    for (let i = 0; i < 3; i++) assert.equal((await createPort(env, credentials, BLOCKFROST)).status, 200)
  })

  it('claims through /activate with the user code in any case, with or without the hyphen', async () => {
    const { vars } = await registered()
    const code = vars.get('DEMETER_USER_CODE')!.replace('-', '').toLowerCase()
    const visit = browser()
    assert.match((await visit('GET', `/activate?code=${code}`)).body, /Log in/)
    const login = await visit('POST', '/login', { username: 'bob', password: 'x' })
    assert.equal(login.headers.location, `/activate?code=${code}`)
    assert.match((await visit('GET', `/activate?code=${code}`)).body, /Claim project/)
    const claimed = await visit('POST', `/activate?code=${code}`, { name: 'Mine' })
    assert.equal(claimed.status, 302)
    assert.match((await visit('GET', claimed.headers.location!)).body, /Project Mine/)
    assert.match((await visit('GET', `/activate?code=${code}`)).body, /This code has expired or was already used/)
    assert.match((await visit('GET', '/activate?code=nope')).body, /That is not a user code/)
  })

  it("keeps another user's ports page from a signed-in stranger, and sends the signed-out to sign in", async () => {
    const { vars } = await registered()
    const namespace = vars.get('DEMETER_PROJECT_NAMESPACE')!
    const owner = browser()
    await owner('POST', '/login', { username: 'alice', password: 'x' })
    await owner('POST', new URL(vars.get('DEMETER_CLAIM_URL')!).pathname, { name: '' })
    const stranger = browser()
    await stranger('POST', '/login', { username: 'mallory', password: 'x' })
    assert.equal((await stranger('GET', `/${namespace}/ports`)).status, 404)
    assert.deepEqual([(await browser()('GET', `/${namespace}/ports`)).headers.location], ['/login'])
  })
})

describe('the mock: control routes', () => {
  it('logs every call but its own, with credentials redacted, and forgets everything on reset', async () => {
    const { vars, credentials } = await registered()
    const port = dotenvVars((await createPort(env, credentials, BLOCKFROST)).body)
    const visit = browser()
    await visit('GET', new URL(vars.get('DEMETER_CLAIM_URL')!).pathname)
    await visit('GET', `/activate?code=${vars.get('DEMETER_USER_CODE')!.toLowerCase().replace('-', '')}`)
    await visit('POST', '/login', { username: 'alice', password: 'hunter22' })
    await call('GET', `${port.get('DEMETER_BLOCKFROST_PREPROD_URL')}/x`, { headers: { 'dmtr-api-key': port.get('DEMETER_BLOCKFROST_PREPROD_KEY')! } })

    const calls = await mockCalls(env)
    assert.deepEqual(
      calls.map((c) => `${c.method} ${c.path} ${c.status}`),
      [
        'POST /api/agent/register 200',
        'POST /api/agent/ports 200',
        'GET /claim/[redacted] 200',
        'GET /activate?code=[redacted] 200',
        'POST /login 302',
        `GET /data/${port.get('DEMETER_BLOCKFROST_PREPROD_PORT_ID')}/x 200`,
      ],
    )
    assert.equal(calls[1]!.headers['dmtr-api-key'], '[redacted]')
    assert.equal(calls[4]!.headers.cookie, '[redacted]')
    const log = JSON.stringify(calls)
    for (const secret of [...vars.values(), ...port.values()].filter((v) => /^dmtr_|\/claim\/|^[A-Z0-9]{4}-/.test(v))) {
      assert.ok(!log.includes(secret), 'the log carries a credential')
    }
    assert.ok(!log.includes('hunter22'), 'the log carries the password')

    await resetMock(env)
    assert.deepEqual(await mockCalls(env), [])
    assert.deepEqual(codeOf(await createPort(env, credentials, BLOCKFROST)), [401, 'unauthenticated'])
  })
})
