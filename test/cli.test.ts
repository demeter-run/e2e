import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import type { Check } from '../src/checks/check.ts'
import { main } from '../src/cli/main.ts'
import type { Result } from '../src/report.ts'

/** Stand-in checks that touch no network. */
const checks: Check[] = [
  { name: 'passes', summary: 'always passes', run: async ({ run }) => void (await run.step('fine', () => 'ok')) },
  {
    name: 'fails',
    summary: 'always fails',
    run: async ({ run }) =>
      void (await run.step('wrong', () => {
        throw new Error('wrong answer')
      })),
  },
  {
    name: 'throws',
    summary: 'throws outside a step',
    run: async () => {
      throw new Error('broke before any step')
    },
  },
]

describe('pnpm check', () => {
  let dir: string
  let log: ReturnType<typeof mock.method>
  let error: ReturnType<typeof mock.method>
  const saved = { webhook: process.env.IRM_E2E_WEBHOOK_URL, summary: process.env.GITHUB_STEP_SUMMARY }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'e2e-cli-'))
    // In CI these would send a real alert and write into this job's summary.
    delete process.env.IRM_E2E_WEBHOOK_URL
    delete process.env.GITHUB_STEP_SUMMARY
    log = mock.method(console, 'log', () => {})
    error = mock.method(console, 'error', () => {})
  })

  afterEach(async () => {
    log.mock.restore()
    error.mock.restore()
    if (saved.webhook !== undefined) process.env.IRM_E2E_WEBHOOK_URL = saved.webhook
    if (saved.summary !== undefined) process.env.GITHUB_STEP_SUMMARY = saved.summary
    await rm(dir, { recursive: true, force: true })
  })

  const run = (...argv: string[]) => main([...argv, '--results', dir], { checks })
  const result = async (name: string): Promise<Result> => JSON.parse(await readFile(join(dir, `${name}.json`), 'utf8'))
  const logged = () => log.mock.calls.map((c) => String(c.arguments[0]))

  it('exits 0 when every check passes, with a result file per check', async () => {
    assert.equal(await run('passes', '--env', 'production'), 0)
    assert.deepEqual(await readdir(dir), ['passes.json'])
    assert.equal((await result('passes')).ok, true)
  })

  it('exits 1 when a check fails', async () => {
    assert.equal(await run('passes,fails', '--env', 'production'), 1)
    assert.equal((await result('fails')).ok, false)
  })

  it('runs every check for all, as the scheduled run calls it', async () => {
    assert.equal(await run('all', '--env', 'production'), 1)
    assert.deepEqual((await readdir(dir)).sort(), ['fails.json', 'passes.json', 'throws.json'])
  })

  it('writes results/ in the working directory by default, which CI uploads', async () => {
    const cwd = process.cwd()
    process.chdir(dir)
    try {
      assert.equal(await main(['passes', '--env', 'production'], { checks }), 0)
    } finally {
      process.chdir(cwd)
    }
    assert.deepEqual(await readdir(join(dir, 'results')), ['passes.json'])
  })

  it('records a check that throws outside a step as a failed run step', async () => {
    assert.equal(await run('throws', '--env', 'production'), 1)
    assert.deepEqual((await result('throws')).steps.map(({ name, ok, detail }) => ({ name, ok, detail })), [
      { name: 'run', ok: false, detail: 'broke before any step' },
    ])
  })

  it('fails on purpose with --force-fail, and logs the skipped alert without a webhook', async () => {
    assert.equal(await run('passes', '--env', 'production', '--force-fail', '--alert'), 1)
    const forced = await result('force-fail')
    assert.equal(forced.ok, false)
    assert.deepEqual(forced.steps.map((s) => [s.name, s.ok]), [['fail on purpose', false]])
    assert.deepEqual(logged().filter((l) => l.startsWith('alert')), ['alert skipped for force-fail: IRM_E2E_WEBHOOK_URL is not set'])
  })

  it('alerts on nothing without --alert', async () => {
    assert.equal(await run('fails', '--env', 'production'), 1)
    assert.deepEqual(logged().filter((l) => l.startsWith('alert')), [])
  })

  it('exits 2 on a usage error, running nothing', async () => {
    assert.equal(await run('nope', '--env', 'production'), 2)
    assert.equal(await run('passes'), 2)
    assert.equal(await run('passes', '--env', 'staging'), 2)
    assert.equal(await run('passes', '--env', 'mock'), 2)
    assert.deepEqual(await readdir(dir), [])
    assert.match(String(error.mock.calls[0]!.arguments[0]), /^unknown check "nope"/)
    assert.match(String(error.mock.calls[3]!.arguments[0]), /^the mock serves only the agent routes/)
  })
})

describe('the pnpm check entry point', () => {
  // The script itself, in a child process, so its exit code is the one CI reads.
  const entry = (...argv: string[]) =>
    spawnSync(process.execPath, ['--import', 'tsx', join('src', 'cli', 'check.ts'), ...argv], {
      cwd: join(import.meta.dirname, '..'),
      encoding: 'utf8',
      env: { ...process.env, IRM_E2E_WEBHOOK_URL: '', GITHUB_STEP_SUMMARY: '' },
    })

  it("exits with main's code", () => {
    const unknown = entry('nope', '--env', 'production')
    assert.equal(unknown.status, 2, unknown.stderr)
    assert.match(unknown.stderr, /unknown check "nope"/)
    const help = entry('--help')
    assert.equal(help.status, 0, help.stderr)
    assert.match(help.stdout, /^usage: pnpm check/)
  })
})
