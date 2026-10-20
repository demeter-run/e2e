import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { Secrets } from '../../src/agent/client.ts'
import { j0, type J0Waits } from '../../src/agent/j0.ts'
import type { Result } from '../../src/report.ts'
import { Run } from '../../src/report.ts'
import { type Breaks, type StandIn, standIn } from './standin.ts'

/**
 * J0 in Chromium against a stand-in Console (`standin.ts`): the claim, the
 * check that follows it and the delete, as on production, with one thing
 * broken at a time. Needs Chromium (`pnpm exec playwright install chromium`);
 * `j0-mock.yml` runs these.
 */

const PASSWORD = 'stand-in-password-0123456789'
const fast: Partial<J0Waits> = { firstRequestMs: 2_000, requestEveryMs: 10, browserMs: 3_000, landingMs: 300, deleteEveryMs: 10, goneMs: 300, pageEveryMs: 10 }

async function j0On(breaks: Breaks): Promise<{ result: Result; console: StandIn; namespace: string }> {
  const console = await standIn(breaks)
  try {
    const url = console.url
    const run = new Run('j0', 'standin')
    await j0({ env: { name: 'standin', website: url, console: url, legacy: url, rpc: url, auth0: url }, run, secrets: new Secrets(), user: 'e2e@txpipe.io', password: PASSWORD, waits: fast })
    const result = run.finish()
    const namespace = /namespace (\S+),/.exec(result.steps[0]!.detail)?.[1] ?? ''
    return { result, console, namespace }
  } finally {
    await console.close()
  }
}

const step = (result: Result, prefix: string) => result.steps.find((s) => s.name.startsWith(prefix)) ?? assert.fail(`no step starts with ${prefix}`)
const outcome = (result: Result) => result.steps.map((s) => `${s.ok ? 'ok' : 'FAIL'} ${s.name.split(' ').slice(0, 3).join(' ')}`)

describe('J0 in the browser against a stand-in Console', () => {
  it('claims, requests again and deletes what it claimed', async () => {
    const { result, console, namespace } = await j0On({})
    assert.ok(result.ok, JSON.stringify(result.steps, null, 1))
    assert.match(step(result, 'claim in the browser').detail, new RegExp(`^claimed ${namespace} and landed on /${namespace}/ports, which answers e2e@txpipe.io 200, in`))
    assert.match(step(result, 'delete').detail, /^deleted \(302 to \/\); /)
    assert.deepEqual(console.log, ['POST /<ns>/settings intent=DELETE_PROJECT'])
  })

  it('fails a claim that lands on the project page without owning it, and posts no delete', async () => {
    const { result, console, namespace } = await j0On({ claimLost: true })
    assert.deepEqual(step(result, 'claim in the browser').detail, `landed on /${namespace}/ports, but it answered 500 to e2e@txpipe.io's session, wanted 200: the claim is unconfirmed`)
    assert.equal(step(result, 'after the claim').detail, 'not run: the claim did not land, so no request comes after it')
    assert.match(step(result, 'delete').detail, new RegExp(`^the claim was sent, but /${namespace}/ports answered 500 for the next 0\\.3 s: if the claim went through`))
    assert.deepEqual(console.log, [])
  })

  it('fails a claim page that answers 500 on its status, and says the project expires unclaimed', async () => {
    const { result } = await j0On({ claimPage: 'first' })
    assert.equal(step(result, 'claim in the browser').detail, 'the claim page answered 500, wanted 200')
    assert.equal(step(result, 'the claim page offered').detail, 'not run: the claim form never showed')
    assert.match(step(result, 'delete').detail, /^\S+ was never claimed: it expires unclaimed at \d{4}-/)
  })

  it('names where the browser was, without the token, and how that page answered, when a wait runs out', async () => {
    const { result } = await j0On({ claimPage: 'signed-in' })
    assert.match(
      step(result, 'claim in the browser').detail,
      /^locator\.waitFor: Timeout 3000ms exceeded\.? \(the browser was at http:\/\/127\.0\.0\.1:\d+\/claim\/<token>, where the last page it loaded answered 500\)$/,
    )
  })

  it('fails the default-name step alone when the claim page offers an empty name', async () => {
    const { result, namespace } = await j0On({ emptyName: true })
    assert.deepEqual(outcome(result).filter((s) => s.startsWith('FAIL')), ['FAIL the claim page'])
    assert.equal(step(result, 'the claim page offered').detail, `the project name defaulted to "", wanted the namespace ${namespace}`)
  })

  it('keeps one scrubbed line of a request error in the claim step, then deletes once the page loads', async () => {
    const { result, console, namespace } = await j0On({ resetFirstCheck: true })
    const detail = step(result, 'claim in the browser').detail
    assert.match(detail, new RegExp(`^landed on /${namespace}/ports, but it answered no answer \\(apiRequestContext\\.get: .+\\) to e2e@txpipe.io's session, wanted 200: the claim is unconfirmed$`))
    assert.ok(console.sessionCookie.length >= 16, 'no session cookie was seen')
    assert.ok(!JSON.stringify(result).includes(console.sessionCookie), 'the result carries the session cookie')
    assert.ok(!JSON.stringify(result).includes(PASSWORD), 'the result carries the password')
    assert.ok(step(result, 'delete').ok, step(result, 'delete').detail)
  })

  it('ends at once on SIGTERM while Chromium runs, with the .env.demeter removed', async () => {
    const console = await standIn({ hangClaimPage: true })
    const tmp = await mkdtemp(join(tmpdir(), 'e2e-j0-signal-'))
    try {
      const root = join(import.meta.dirname, '..', '..')
      const child = spawn(join(root, 'node_modules', '.bin', 'tsx'), ['src/cli/j0.ts', '--env', 'mock', '--results', join(tmp, 'results')], {
        cwd: root,
        env: { ...process.env, E2E_MOCK_URL: console.url, TMPDIR: tmp, GITHUB_ACTIONS: '', GITHUB_STEP_SUMMARY: '', IRM_E2E_WEBHOOK_URL: '' },
        stdio: 'ignore',
      })
      const exited = once(child, 'exit')
      const t0 = Date.now()
      while (!console.log.includes('GET /claim held')) {
        assert.ok(Date.now() - t0 < 60_000, 'Chromium never asked for the claim page')
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      const env = async () => (await readdir(tmp)).filter((name) => name.startsWith('e2e-j0-'))
      assert.equal((await env()).length, 1, 'no .env.demeter directory while J0 runs')
      const killed = Date.now()
      child.kill('SIGTERM')
      const [code, signal] = await exited
      assert.ok(Date.now() - killed < 10_000, `J0 took ${Date.now() - killed} ms to end`)
      assert.deepEqual([code, signal], [143, null])
      assert.deepEqual(await env(), [])
      assert.deepEqual(await readdir(tmp).then((names) => names.filter((n) => n === 'results')), [], 'J0 went on to write results')
    } finally {
      await console.close()
      await rm(tmp, { recursive: true, force: true })
    }
  })
})
