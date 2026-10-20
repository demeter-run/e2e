import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, normalize } from 'node:path'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import { request } from '@playwright/test'
import { type Journey, journeys, main, type Playwright } from '../src/cli/journeys.ts'
import { deleteProjects, keyShape } from '../src/journeys/console.ts'
import { burst, describeTally, portGet, tally, untilSuccess } from '../src/journeys/port.ts'
import { browserSteps, ended, NotRun, poll, within } from '../src/journeys/spec.ts'
import { Failure, formatMarkdown, formatText, type Result, Run } from '../src/report.ts'
import { forgetSecrets, keepSecret, redact } from '../src/secrets.ts'
import { refusedUrl, serve, withEnv } from './helpers.ts'

const root = join(import.meta.dirname, '..')

describe('secrets', () => {
  afterEach(forgetSecrets)

  it('are redacted as written, URL-encoded and JSON-escaped', () => {
    keepSecret('p@ss "word"/1')
    assert.equal(
      redact('typed p@ss "word"/1, posted p%40ss%20%22word%22%2F1, sent {"password":"p@ss \\"word\\"/1"}'),
      'typed [redacted], posted [redacted], sent {"password":"[redacted]"}',
    )
  })

  it('are redacted from every step a run records, its name and its detail', async () => {
    const key = keepSecret('dmtr_blockfrost1secretkey')
    const run = new Run('j2', 'production')
    await run.step(`GET with ${key}`, () => `answered for ${key}`)
    await run.step('fails', () => {
      throw new Error(`https://${key}.cardano-preprod.blockfrost-m1.demeter.run refused`)
    })
    const text = JSON.stringify(run.finish())
    assert.doesNotMatch(text, /secretkey/)
    assert.match(text, /GET with \[redacted\]/)
    assert.match(text, /https:\/\/\[redacted\]\.cardano-preprod/)
  })

  it('shorter than four characters are not kept, or they would redact everything', () => {
    keepSecret('a')
    assert.equal(redact('a cat'), 'a cat')
  })
})

describe('the stopwatch', () => {
  it('writes elapsed_seconds into the result, its text and its summary', async () => {
    const run = new Run('j2', 'production')
    await run.step('first request', () => '200')
    run.elapsedSeconds = 93.4
    const result = run.finish()
    assert.equal(result.elapsed_seconds, 93.4)
    assert.match(formatText([result]), /elapsed: 93\.4 s/)
    assert.match(formatMarkdown([result]), /\*\*Elapsed:\*\* 93\.4 s/)
  })

  it('is left out of a result whose journey has none', () => {
    assert.equal('elapsed_seconds' in new Run('apex', 'production').finish(), false)
  })
})

describe('pnpm journey', () => {
  let dir: string
  let log: ReturnType<typeof mock.method>
  let error: ReturnType<typeof mock.method>
  const saved = { webhook: process.env.IRM_E2E_WEBHOOK_URL, summary: process.env.GITHUB_STEP_SUMMARY }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'e2e-journey-'))
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

  const journey: Journey = { name: 'walk', summary: 'a stand-in', spec: 'journeys/walk.spec.ts', results: ['walk', 'walk-edge'] }
  const result = (name: string, ok: boolean): Result => ({
    name,
    env: 'production',
    started_at: '2026-10-19T00:00:00.000Z',
    finished_at: '2026-10-19T00:00:01.000Z',
    ok,
    steps: [{ name: 'step', ok, ms: 1, detail: ok ? 'fine' : 'wrong' }],
  })
  /** A stand-in Playwright that writes the given results, records what it was started with, and exits `code`. */
  const playwright = (results: Result[], code = 0) => {
    const calls: { spec: string; env: NodeJS.ProcessEnv }[] = []
    const run: Playwright = async (spec, env) => {
      calls.push({ spec, env })
      for (const r of results) await writeFile(join(env.E2E_RESULTS!, `${r.name}.json`), JSON.stringify(r))
      return code
    }
    return { run, calls }
  }
  const cli = (argv: string[], pw: Playwright) =>
    withEnv({ E2E_USER_PASSWORD: 'stand-in' }, () => main([...argv, '--results', dir], { all: [journey], playwright: pw }))
  const written = async (name: string): Promise<Result> => JSON.parse(await readFile(join(dir, `${name}.json`), 'utf8'))

  it('runs the spec with the environment and results directory, and exits 0 when every result passes', async () => {
    const pw = playwright([result('walk', true), result('walk-edge', true)])
    assert.equal(await cli(['walk', '--env', 'production'], pw.run), 0)
    assert.equal(pw.calls[0]!.spec, 'journeys/walk.spec.ts')
    assert.equal(pw.calls[0]!.env.E2E_ENV, 'production')
    assert.equal(pw.calls[0]!.env.E2E_RESULTS, dir)
  })

  it('exits 1 when a result fails, whatever Playwright exited', async () => {
    assert.equal(await cli(['walk', '--env', 'production'], playwright([result('walk', true), result('walk-edge', false)], 0).run), 1)
  })

  it('fails a result the spec did not write, and never reads one an earlier run left, nor keeps its screenshots', async () => {
    await writeFile(join(dir, 'walk-edge.json'), JSON.stringify(result('walk-edge', true)))
    for (const shot of ['walk-01.png', 'walk-clean-up-worker-0-01-2.png', 'walk-edge-01.png', 'other-01.png']) await writeFile(join(dir, shot), '')
    assert.equal(await cli(['walk', '--env', 'production'], playwright([result('walk', true)], 1).run), 1)
    const edge = await readFile(join(dir, 'walk-edge.json'), 'utf8').catch(() => null)
    assert.equal(edge, null)
    assert.deepEqual((await readdir(dir)).sort(), ['other-01.png', 'walk.json'])
    assert.match(String(log.mock.calls.at(-1)?.arguments[0]), /FAIL {2}walk-edge \(production\): 0\/1 steps\n {2}FAIL {2}report \(0 ms\): the journey wrote no result for walk-edge: Playwright exited 1/)
  })

  it('appends the results to the job summary, with the elapsed time', async () => {
    const summary = join(dir, 'summary.md')
    const timed = { ...result('walk', true), elapsed_seconds: 7.6 }
    await withEnv({ GITHUB_STEP_SUMMARY: summary }, () => cli(['walk', '--env', 'production'], playwright([timed, result('walk-edge', false)]).run))
    const written = await readFile(summary, 'utf8')
    assert.match(written, /^## Journey walk against production\n/)
    assert.match(written, /\| `walk-edge` \(production\) \| ❌ fail \| 0\/1 \|/)
    assert.match(written, /\*\*Elapsed:\*\* 7\.6 s/)
  })

  it('adds a failing result with --force-fail, and posts nothing without the webhook', async () => {
    const pw = playwright([result('walk', true), result('walk-edge', true)])
    assert.equal(await cli(['walk', '--env', 'production', '--force-fail', '--alert'], pw.run), 1)
    assert.equal((await written('force-fail')).ok, false)
    assert.ok(log.mock.calls.some((c) => c.arguments[0] === 'alert skipped for force-fail: IRM_E2E_WEBHOOK_URL is not set'))
  })

  it('refuses a missing environment, an unknown journey or a missing password, before starting Playwright', async () => {
    const pw = playwright([])
    assert.equal(await cli(['walk'], pw.run), 2)
    assert.equal(await cli(['fly', '--env', 'production'], pw.run), 2)
    assert.equal(await cli(['walk', '--env', 'staging'], pw.run), 2)
    assert.equal(await withEnv({ E2E_USER_PASSWORD: undefined }, () => main(['walk', '--env', 'production', '--results', dir], { all: [journey], playwright: pw.run })), 2)
    assert.equal(pw.calls.length, 0)
    assert.match(String(error.mock.calls.at(-1)?.arguments[0]), /^set E2E_USER_PASSWORD to e2e@txpipe\.io's password/)
    assert.deepEqual(await readdir(dir), [])
  })
})

describe('the pnpm journey entry point', () => {
  // The script itself, in a child process, so its exit code is the one CI reads.
  const entry = (env: NodeJS.ProcessEnv, ...argv: string[]) =>
    spawnSync(process.execPath, ['--import', 'tsx', join('src', 'cli', 'journey.ts'), ...argv], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, IRM_E2E_WEBHOOK_URL: '', GITHUB_STEP_SUMMARY: '', ...env },
    })

  it('exits 2 on a usage error and 3 on a break before the journey reported, never the 1 of a reported failure', async () => {
    const usage = entry({ E2E_USER_PASSWORD: '' }, 'sign-in', '--env', 'production')
    assert.equal(usage.status, 2, usage.stderr)
    // A results directory that is a file: clearing the old results breaks before Playwright starts.
    const tmp = await mkdtemp(join(tmpdir(), 'e2e-entry-'))
    try {
      const file = join(tmp, 'not-a-directory')
      await writeFile(file, '')
      const broke = entry({ E2E_USER_PASSWORD: 'stand-in' }, 'sign-in', '--env', 'production', '--results', file)
      assert.equal(broke.status, 3, broke.stderr)
      assert.match(broke.stderr, /^the journey broke before it reported: /)
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })
})

describe('the journey registry', () => {
  // A result the registry leaves out is never read, so a test that fails it would not fail the run.
  it("names one result per test each spec declares, as the spec's tests name their runs", () => {
    for (const journey of journeys) {
      const spec = readFileSync(join(root, journey.spec), 'utf8')
      const tests = [...spec.matchAll(/^test\('([^']+)'/gm)].map((m) => m[1])
      assert.deepEqual([...journey.results].sort(), tests.sort(), journey.spec)
    }
  })
})

describe('the j2 workflow', () => {
  /** The relative imports of `file`, and theirs, as paths from the repository root. */
  const imports = (files: string[]): Set<string> => {
    const seen = new Set<string>()
    const queue = [...files]
    while (queue.length) {
      const file = queue.pop()!
      if (seen.has(file)) continue
      seen.add(file)
      for (const m of readFileSync(join(root, file), 'utf8').matchAll(/(?:from|import)\s+'(\.[^']+)'/g)) queue.push(normalize(join(dirname(file), m[1]!)))
    }
    return seen
  }
  const glob = (pattern: string) =>
    new RegExp(`^${pattern.split('**').map((part) => part.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*')}$`)

  it('runs on a pull request that changes any file J2 runs, the toolchain or the dependencies', () => {
    const workflow = readFileSync(join(root, '.github', 'workflows', 'j2.yml'), 'utf8')
    const block = /\n {2}pull_request:\n {4}paths:\n((?: {6}- .+\n)+)/.exec(workflow)?.[1]
    assert.ok(block, 'j2.yml has a pull_request paths filter')
    const paths = [...block.matchAll(/- (.+)/g)].map((m) => glob(m[1]!.trim()))
    const specs = journeys.map((j) => j.spec)
    const needed = [...imports([...specs, 'src/cli/journey.ts']), 'playwright.config.ts', '.nvmrc', 'package.json', 'pnpm-lock.yaml', '.github/workflows/j2.yml']
    assert.deepEqual(needed.filter((file) => !paths.some((p) => p.test(file))), [])
  })
})

describe('requests to a port', () => {
  afterEach(forgetSecrets)

  it('send the key in the dmtr-api-key header, and read a JSON body', async () => {
    let seen: string | undefined
    const server = await serve((req, res) => {
      seen = req.headers['dmtr-api-key'] as string
      res.setHeader('content-type', 'application/json')
      res.end('{"epoch":245}')
    })
    try {
      assert.deepEqual(await portGet(`${server.url}/epochs/latest`, 'the-key'), { status: 200, body: { epoch: 245 } })
      assert.equal(seen, 'the-key')
    } finally {
      await server.close()
    }
  })

  it('answer no status, saying why, when nothing answers in time or nothing listens', async () => {
    const server = await serve(() => {})
    // Should the request not time out, closing the server ends it, and the assertion says so.
    const stop = setTimeout(() => void server.close(), 2_000)
    try {
      assert.deepEqual(await portGet(`${server.url}/epochs/latest`, 'k', 50), { status: null, error: 'TimeoutError' })
    } finally {
      clearTimeout(stop)
      await server.close()
    }
    assert.deepEqual(await portGet(`${await refusedUrl()}/epochs/latest`, 'k'), { status: null, error: 'ECONNREFUSED' })
  })

  it('poll until the first 2xx, as a new key reaches the proxies, and stop the stopwatch at it', async () => {
    let n = 0
    const server = await serve((_req, res) => {
      res.statusCode = (n += 1) < 3 ? 401 : 200
      res.end('{}')
    })
    try {
      const t0 = performance.now()
      const { answer, tries, at } = await untilSuccess(`${server.url}/epochs/latest`, 'k', { timeoutMs: 5_000, everyMs: 40 })
      assert.equal(answer.status, 200)
      assert.equal(tries, 3)
      // Two waits of 40 ms come before the 2xx.
      assert.ok(at - t0 >= 80, `stopped ${at - t0} ms in`)
      assert.ok(at <= performance.now())
    } finally {
      await server.close()
    }
  })

  it('give up after the deadline, saying what answered how often, without the key', async () => {
    const key = keepSecret('dmtr_blockfrost1secretkey')
    let hits = 0
    const server = await serve((_req, res) => {
      hits += 1
      res.statusCode = 401
      res.end()
    })
    try {
      await assert.rejects(untilSuccess(`${server.url}/epochs/latest?x=1`, key, { timeoutMs: 50, everyMs: 10 }), (error: Error) => {
        assert.ok(error instanceof Failure)
        assert.ok(hits > 1, `${hits} requests`)
        assert.match(error.message, new RegExp(`^http://127\\.0\\.0\\.1:\\d+/epochs/latest answered no 2xx in 0 s: ${hits}× 401$`))
        assert.doesNotMatch(error.message, /secretkey/)
        return true
      })
    } finally {
      await server.close()
    }
  })

  it('send a burst at once', async () => {
    let open = 0
    let most = 0
    const server = await serve((_req, res) => {
      most = Math.max(most, (open += 1))
      setTimeout(() => {
        open -= 1
        res.end()
      }, 100)
    })
    try {
      assert.equal((await burst(`${server.url}/epochs/latest`, 'k', 8)).length, 8)
      assert.equal(most, 8)
    } finally {
      await server.close()
    }
  })

  it('tally a burst by status, with no answer counted as none', async () => {
    let n = 0
    const server = await serve((_req, res) => {
      res.statusCode = (n += 1) > 3 ? 429 : 200
      res.end()
    })
    try {
      const answers = await burst(`${server.url}/epochs/latest`, 'k', 5)
      assert.equal(describeTally(tally(answers)), '200×3, 429×2')
      assert.equal(describeTally(tally([{ status: null, error: 'ECONNRESET' }, { status: 503 }])), '503×1, none×1')
    } finally {
      await server.close()
    }
  })
})

describe('waiting in a spec', () => {
  it('polls until a read returns a value, retrying a read that fails', async () => {
    let n = 0
    const found = await poll(5_000, 5, async () => {
      if ((n += 1) === 1) throw new Error('the page was busy')
      return n === 3 ? 'listed' : null
    })
    assert.deepEqual([found.value, found.error, n], ['listed', undefined, 3])
  })

  it('gives up at the deadline with the last read failure only, never an earlier one', async () => {
    let n = 0
    const recovered = await poll(40, 5, async () => {
      if ((n += 1) === 1) throw new Failure('no "Project Usage" card on the billing page')
      return null
    })
    assert.equal(recovered.value, null)
    assert.equal(recovered.error, undefined)
    const failing = await poll(40, 5, async () => {
      throw new Error('page.goto: net::ERR_CONNECTION_RESET\nCall log: the page')
    })
    assert.equal(failing.value, null)
    assert.equal(failing.error, 'page.goto: net::ERR_CONNECTION_RESET')
  })

  it('cuts off what runs past its time with a Failure naming it', async () => {
    assert.equal(await within(1_000, 'the clean-up', async () => 'done'), 'done')
    await assert.rejects(
      within(20, 'the clean-up', () => new Promise(() => {})),
      (error: Error) => error instanceof Failure && error.message === 'the clean-up did not finish within 0 s',
    )
  })

  it('records a test Playwright ended as a failed step, and nothing for one that passed', async () => {
    const run = new Run('j2', 'production')
    await ended(run, { status: 'passed', expectedStatus: 'passed', timeout: 6_000_000, error: undefined })
    await ended(run, { status: 'timedOut', expectedStatus: 'passed', timeout: 6_000_000, error: undefined })
    await ended(run, { status: 'failed', expectedStatus: 'passed', timeout: 1, error: { message: 'browser.newContext: closed\nCall log: …' } })
    assert.deepEqual(
      run.finish().steps.map(({ name, ok, detail }) => [name, ok, detail]),
      [
        ['the test ran to its end', false, 'Playwright ended the test: it timed out after 6000 s'],
        ['the test ran to its end', false, 'Playwright ended the test: it failed: browser.newContext: closed'],
      ],
    )
  })
})

describe('the key shape', () => {
  it("matches a port's key as fabric writes it, alone or in a URL, and a legacy key", () => {
    assert.match('blockfrost1qpzry9x8gf2tvdw0s3jn5', keyShape)
    assert.match('https://ogmios1qpzry9x8gf2tvdw0s3jn5.cardano-preprod.ogmios-m1.demeter.run', keyShape)
    assert.match('dmtr_blockfrost1qpzry9x8gf2tvdw0s3jn54khce6', keyShape)
    assert.doesNotMatch('https://cardano-preprod.blockfrost-m1.demeter.run', keyShape)
    assert.doesNotMatch('blockfrost-preprod-1a2b3c', keyShape)
  })
})

describe('deleting the projects', () => {
  /** A stand-in Console: the settings action deletes a project and redirects as webui's does. */
  async function consoleWith(projects: string[], answer?: (ns: string) => { status: number; location?: string }) {
    const left = [...projects]
    const posted: string[] = []
    const server = await serve((req, res) => {
      const ns = /^\/([^/]+)\/settings$/.exec(req.url ?? '')?.[1]
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        if (req.method !== 'POST' || !ns || body !== 'intent=DELETE_PROJECT') {
          res.statusCode = 400
          return res.end()
        }
        posted.push(ns)
        const custom = answer?.(ns)
        if (custom) {
          res.statusCode = custom.status
          if (custom.location) res.setHeader('location', custom.location)
          return res.end()
        }
        left.splice(left.indexOf(ns), 1)
        res.statusCode = 302
        res.setHeader('location', left.length ? `/${left[0]}/ports` : '/')
        res.end()
      })
    })
    return { server, posted, left }
  }

  const withRequest = async <T>(fn: (ctx: { request: Awaited<ReturnType<typeof request.newContext>> }) => Promise<T>) => {
    const ctx = await request.newContext()
    try {
      return await fn({ request: ctx })
    } finally {
      await ctx.dispose()
    }
  }

  it('posts the settings action for each project in turn, and stops at the redirect to /', async () => {
    const { server, posted, left } = await consoleWith(['prj-one', 'prj-two', 'prj-three'])
    try {
      assert.deepEqual(await withRequest((ctx) => deleteProjects(ctx, { console: server.url }, 'prj-one')), ['prj-one', 'prj-two', 'prj-three'])
      assert.deepEqual(posted, ['prj-one', 'prj-two', 'prj-three'])
      assert.deepEqual(left, [])
    } finally {
      await server.close()
    }
  })

  it('fails on an answer that is not a redirect, a redirect to sign in, or a project named twice', async () => {
    for (const [answer, message] of [
      [() => ({ status: 500 }), /^deleting prj-one: the Console answered 500, wanted a redirect$/],
      [() => ({ status: 302, location: '/login' }), /^deleting prj-one: the Console sent the browser to sign in/],
      [() => ({ status: 302, location: '/prj-one/ports' }), /^the Console still names prj-one after deleting it/],
      [() => ({ status: 302, location: '/prj-one/settings?x=1' }), /redirected to http:\/\/127\.0\.0\.1:\d+\/prj-one\/settings, which names no next project/],
    ] as const) {
      const { server } = await consoleWith(['prj-one'], answer)
      try {
        await assert.rejects(
          withRequest((ctx) => deleteProjects(ctx, { console: server.url }, 'prj-one')),
          (error: Error) => error instanceof Failure && message.test(error.message),
        )
      } finally {
        await server.close()
      }
    }
  })
})

describe('browser steps', () => {
  const dir = () => process.env.E2E_RESULTS!
  /** A stand-in page that records the screenshots it is asked for. */
  const stand = () => {
    const shots: { path: string; masks: number }[] = []
    const page = {
      screenshot: async ({ path, mask }: { path: string; mask: unknown[] }) => {
        shots.push({ path, masks: mask.length })
        await writeFile(path, '')
      },
    }
    return { page: page as never, shots }
  }

  it("keep a Failure's message whole, cut any other error to its first line, and name the masked screenshot", async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'e2e-steps-'))
    try {
      await withEnv({ E2E_RESULTS: tmp }, async () => {
        const { page, shots } = stand()
        const run = new Run('walk', 'production')
        const step = browserSteps(run, () => page, () => ['password', 'key'] as never)
        await step('ours', () => {
          throw new Failure('2 divergences:\nBlockfrost Flexible per 100k: fabric $0.30 · console $0.35\nBlockfrost Pro I minimum: fabric $50 · console $60')
        })
        await step('playwright', () => {
          throw new Error('\x1b[31mlocator.click: Timeout 30000ms exceeded.\x1b[39m\nCall log:\n  - locator resolved to <div>dmtr_secret</div>')
        })
        await step('skipped', () => {
          throw new NotRun('no port')
        })
        const [ours, playwright, skipped] = run.finish().steps
        assert.equal(ours!.detail, `2 divergences:\nBlockfrost Flexible per 100k: fabric $0.30 · console $0.35\nBlockfrost Pro I minimum: fabric $50 · console $60\nscreenshot: ${join(dir(), 'walk-01.png')}`)
        assert.equal(playwright!.detail, `locator.click: Timeout 30000ms exceeded.\nscreenshot: ${join(dir(), 'walk-02.png')}`)
        assert.equal(skipped!.detail, 'not run: no port')
        assert.deepEqual(shots, [
          { path: join(tmp, 'walk-01.png'), masks: 2 },
          { path: join(tmp, 'walk-02.png'), masks: 2 },
        ])
      })
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })

  // J2's clean-up runs in its own runner, and again in a new worker when J2
  // times out: neither may replace the screenshot a reported result names.
  it('name their screenshots as asked, and never replace one an earlier runner took', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'e2e-steps-'))
    try {
      await withEnv({ E2E_RESULTS: tmp }, async () => {
        const { page, shots } = stand()
        const fail = () => {
          throw new Failure('wrong')
        }
        const run = new Run('walk', 'production')
        await browserSteps(run, () => page, () => [])('first', fail)
        await browserSteps(run, () => page, () => [], 'walk-clean-up-worker-0')('clean up', fail)
        await browserSteps(run, () => page, () => [])('first again', fail)
        await browserSteps(run, () => page, () => [], 'walk-clean-up-worker-0')('clean up again', fail)
        const named = ['walk-01.png', 'walk-clean-up-worker-0-01.png', 'walk-01-2.png', 'walk-clean-up-worker-0-01-2.png'].map((f) => join(tmp, f))
        assert.deepEqual(shots.map((s) => s.path), named)
        assert.deepEqual(run.finish().steps.map((s) => s.detail), named.map((path) => `wrong\nscreenshot: ${path}`))
        assert.deepEqual((await readdir(tmp)).sort(), ['walk-01-2.png', 'walk-01.png', 'walk-clean-up-worker-0-01-2.png', 'walk-clean-up-worker-0-01.png'])
      })
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })

  it('leave no file behind for a screenshot that failed', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'e2e-steps-'))
    try {
      await withEnv({ E2E_RESULTS: tmp }, async () => {
        const page = { screenshot: async () => Promise.reject(new Error('Target page, context or browser has been closed\nCall log: …')) } as never
        const run = new Run('walk', 'production')
        await browserSteps(run, () => page, () => [])('first', () => {
          throw new Failure('wrong')
        })
        assert.equal(run.finish().steps[0]!.detail, 'wrong\nscreenshot: no screenshot: Target page, context or browser has been closed')
        assert.deepEqual(await readdir(tmp), [])
      })
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })
})
