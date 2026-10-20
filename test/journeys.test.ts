import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it, mock as mocks } from 'node:test'
import { call } from '../src/agent/client.ts'
import { main, type MockJourney } from '../src/cli/journey.ts'
import { type Environment, environments } from '../src/env.ts'
import { type Mock, type Rule, rules, startMock } from '../src/mock/server.ts'
import type { Result } from '../src/report.ts'
import { refusedUrl, serve, withEnv } from './helpers.ts'

// As in agent.test.ts: under node:test a `::add-mask::` line would print each
// throwaway credential plainly, so this process masks nothing.
delete process.env.GITHUB_ACTIONS

const quiet = { GITHUB_STEP_SUMMARY: undefined, GITHUB_ACTIONS: undefined }

let dir: string
let log: ReturnType<typeof mocks.method>
let error: ReturnType<typeof mocks.method>

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'e2e-journeys-'))
  log = mocks.method(console, 'log', () => {})
  error = mocks.method(console, 'error', () => {})
})
afterEach(async () => {
  log.mock.restore()
  error.mock.restore()
  await rm(dir, { recursive: true, force: true })
})

/** A journey's exit code and result, on `target`. */
async function journey(name: MockJourney, target: Environment): Promise<{ code: number; result: Result }> {
  const code = await withEnv(quiet, () => main(name, ['--env', 'mock', '--results', dir], { lookup: () => target }))
  return { code, result: JSON.parse(await readFile(join(dir, `${name}.json`), 'utf8')) as Result }
}

/** A journey on a mock of its own, which breaks `broken`. */
async function onMock(name: MockJourney, broken: Rule[] = []) {
  const mock: Mock = await startMock({ port: 0, broken })
  try {
    return await journey(name, { ...environments.mock, console: mock.url })
  } finally {
    await mock.close()
  }
}

const failed = (result: Result) => result.steps.filter((s) => !s.ok).map((s) => s.name)

describe('J3 and J9 on the mock', () => {
  for (const name of ['j3', 'j9'] as const) {
    it(`${name} passes every step, from an empty mock, with the leak check last`, async () => {
      const { code, result } = await onMock(name)
      assert.deepEqual(failed(result), [], JSON.stringify(result.steps, null, 1))
      assert.equal(code, 0)
      assert.deepEqual(await readdir(dir), [`${name}.json`])
      assert.equal(result.steps[0]!.name, 'start from an empty mock')
      assert.equal(result.steps.at(-1)!.name, 'no credential in the result or the call log')
    })
  }

  it('resets the mock it starts on, so each passes run after run on one long-lived mock', async () => {
    const mock: Mock = await startMock({ port: 0 })
    try {
      for (const name of ['j9', 'j9', 'j3', 'j3', 'j9'] as const) {
        const { code, result } = await journey(name, { ...environments.mock, console: mock.url })
        assert.deepEqual(failed(result), [], `${name}: ${JSON.stringify(result.steps.filter((s) => !s.ok))}`)
        assert.equal(code, 0)
      }
    } finally {
      await mock.close()
    }
  })

  // Each rule the mock enforces, broken alone, fails the step that holds it,
  // and that step names what went wrong.
  const breaks: [Rule, MockJourney, string, RegExp][] = [
    ['ip_cap', 'j9', 'the fourth is 429 ip_cap', /answered 200, wanted 429 ip_cap/],
    ['ip_window', 'j9', 'past the wait, the address registers again', /answered 429 ip_cap, wanted 200/],
    ['port_cap', 'j9', 'one project takes three ports', /answered 200, wanted 429 port_cap/],
    ['global_cap', 'j9', 'with the global limit one above the live projects', /answered 200, wanted 503 global_cap/],
    ['kill_switch', 'j9', 'with the kill switch off, registration is 503', /answered 200, wanted 503 registration_disabled/],
    ['expiry', 'j3', 'a minute past the expiry', /answered 200, wanted 410 expired/],
    ['expired_data_plane', 'j3', "the expired project's port no longer answers", /the port answered 200, wanted a refusal/],
    ['expired_claim', 'j3', "the expired project's claim link says it expired", /without "This link has expired or was already used"/],
  ]

  it('names a journey step for every rule the mock enforces', () => {
    assert.deepEqual([...new Set(breaks.map(([rule]) => rule))].sort(), [...rules].sort())
  })

  for (const [rule, name, step, detail] of breaks) {
    it(`fails ${name} when the mock stops enforcing ${rule}`, async () => {
      const { code, result } = await onMock(name, [rule])
      assert.equal(code, 1)
      const broke = result.steps.find((s) => s.name.startsWith(step))
      assert.ok(broke, `no step starts with ${step}`)
      assert.equal(broke.ok, false, `${broke.name} passed: ${broke.detail}`)
      assert.match(broke.detail, detail)
    })
  }

  it('fails the leak check, exits 1 and writes a scrubbed result, when a credential reaches a result', async () => {
    // A Console that names the API key as the expired project's error code, which J3 prints.
    const mock = await startMock({ port: 0 })
    let key = ''
    let self = ''
    const leaky = await serve(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(chunk as Buffer)
      const headers = Object.fromEntries(Object.entries(request.headers).flatMap(([k, v]) => (typeof v === 'string' && k !== 'host' ? [[k, v]] : [])))
      const body = Buffer.concat(chunks).toString('utf8')
      const answer = await call(request.method ?? 'GET', `${mock.url}${request.url}`, { headers, ...(body ? { body } : {}) })
      let out = answer.body.split(mock.url).join(self)
      key ||= /DEMETER_API_KEY=(.*)/.exec(out)?.[1] ?? ''
      if (answer.status === 410) out = out.replace('"expired"', JSON.stringify(key))
      response.writeHead(answer.status ?? 502, { 'content-type': answer.headers['content-type'] ?? 'text/plain' })
      response.end(out)
    })
    self = leaky.url
    try {
      const { code, result } = await journey('j3', { ...environments.mock, console: leaky.url })
      assert.equal(code, 1)
      const leak = result.steps.at(-1)!
      assert.deepEqual([leak.name, leak.ok, leak.detail], ['no credential in the result or the call log', false, 'the result carries the API key'])
      assert.ok(key && !(await readFile(join(dir, 'j3.json'), 'utf8')).includes(key), 'the written result carries the key')
    } finally {
      await leaky.close()
      await mock.close()
    }
  })

  it('stops at its first step, sending no agent-route call, when the control routes do not answer as the mock', async () => {
    // A server at E2E_MOCK_URL that is not the mock: 404 on /__mock/*, or 200 with something else.
    for (const control of [404, 200]) {
      const seen: string[] = []
      const stranger = await serve((request, response) => {
        seen.push(`${request.method} ${request.url}`)
        request.resume()
        response.writeHead(request.url?.startsWith('/__mock/') ? control : 200, { 'content-type': 'application/json' })
        response.end('{}')
      })
      try {
        for (const name of ['j3', 'j9'] as const) {
          seen.length = 0
          const { code, result } = await journey(name, { ...environments.mock, console: stranger.url })
          assert.equal(code, 1)
          assert.deepEqual(
            result.steps.map((s) => [s.name, s.ok]),
            [
              ['start from an empty mock', false],
              ['no credential in the result or the call log', control === 200],
            ],
          )
          assert.deepEqual(
            seen.filter((line) => !line.includes(' /__mock/')),
            [],
            `${name} with control routes answering ${control}`,
          )
        }
      } finally {
        await stranger.close()
      }
    }
  })

  it('refuses any environment but the mock, and a missing one, touching nothing', async () => {
    const dead = await refusedUrl()
    const production = { ...environments.production, website: dead, console: dead, legacy: dead, rpc: dead, auth0: dead }
    for (const name of ['j3', 'j9'] as const) {
      assert.equal(await withEnv(quiet, () => main(name, ['--env', 'production', '--results', dir], { lookup: () => production })), 2)
      assert.match(String(error.mock.calls.at(-1)?.arguments[0]), /runs on the mock only/)
      assert.equal(await withEnv(quiet, () => main(name, ['--results', dir])), 2)
      assert.match(String(error.mock.calls.at(-1)?.arguments[0]), /^name the environment/)
    }
    assert.deepEqual(await readdir(dir), [])
  })
})
