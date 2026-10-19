import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { type AddressInfo, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, mock } from 'node:test'
import { describeAnswer, probe, readPage, safeUrl } from '../src/http.ts'
import { alertFailures, alertPayload, formatMarkdown, type Result, Run, writeResult } from '../src/report.ts'
import { serve } from './helpers.ts'

async function sample() {
  const run = new Run('sample', 'production')
  await run.step('passes', () => 'fine')
  await run.step('fails', () => {
    throw new Error('wrong answer')
  })
  return run.finish()
}

describe('results', () => {
  it('records each step, and fails the run on a failed step', async () => {
    const result = await sample()
    assert.equal(result.ok, false)
    assert.deepEqual(
      result.steps.map(({ name, ok, detail }) => ({ name, ok, detail })),
      [
        { name: 'passes', ok: true, detail: 'fine' },
        { name: 'fails', ok: false, detail: 'wrong answer' },
      ],
    )
  })

  it('does not pass a run with no steps', () => {
    assert.equal(new Run('empty', 'production').finish().ok, false)
  })

  it('writes results/<name>.json in the agreed shape', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'e2e-results-'))
    try {
      const path = await writeResult(await sample(), dir)
      assert.equal(path, join(dir, 'sample.json'))
      const written = JSON.parse(await readFile(path, 'utf8'))
      assert.deepEqual(Object.keys(written), ['name', 'env', 'started_at', 'finished_at', 'ok', 'steps'])
      assert.deepEqual(Object.keys(written.steps[0]), ['name', 'ok', 'ms', 'detail'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('summarises as a Markdown table', async () => {
    assert.match(formatMarkdown([await sample()]), /\| `sample` \(production\) \| ❌ fail \| 1\/2 \|/)
  })
})

describe('alerts', () => {
  it('builds the payload fabric sends to IRM, keyed e2e-<name>', async () => {
    const payload = alertPayload(await sample())
    assert.equal(payload.alert_uid, 'e2e-sample')
    assert.equal(payload.state, 'alerting')
    assert.equal(payload.message, 'fails: wrong answer')
    assert.deepEqual(Object.keys(payload), ['alert_uid', 'title', 'message', 'state', 'link_to_upstream_details'])
  })

  it('logs that it skipped the alert when no webhook is set', async () => {
    const saved = process.env.IRM_E2E_WEBHOOK_URL
    delete process.env.IRM_E2E_WEBHOOK_URL
    const log = mock.method(console, 'log', () => {})
    try {
      await alertFailures([await sample()])
      assert.deepEqual(log.mock.calls.map((c) => c.arguments[0]), ['alert skipped for sample: IRM_E2E_WEBHOOK_URL is not set'])
    } finally {
      log.mock.restore()
      if (saved !== undefined) process.env.IRM_E2E_WEBHOOK_URL = saved
    }
  })

  /** Runs `alertFailures` against a local webhook answering `status`; returns what it received and logged. */
  async function alertTo(status: number, results: Result[]) {
    const received: { contentType: string | undefined; body: unknown }[] = []
    const webhook = await serve(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(chunk as Buffer)
      received.push({ contentType: request.headers['content-type'], body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
      response.writeHead(status).end()
    })
    const saved = process.env.IRM_E2E_WEBHOOK_URL
    process.env.IRM_E2E_WEBHOOK_URL = `${webhook.url}/integrations/v1/webhook/secret-token/`
    const log = mock.method(console, 'log', () => {})
    try {
      await alertFailures(results)
      return { received, logged: log.mock.calls.map((c) => String(c.arguments[0])) }
    } finally {
      log.mock.restore()
      if (saved === undefined) delete process.env.IRM_E2E_WEBHOOK_URL
      else process.env.IRM_E2E_WEBHOOK_URL = saved
      await webhook.close()
    }
  }

  it('posts the IRM payload for each failed result only', async () => {
    const passed = new Run('passed', 'production')
    await passed.step('fine', () => 'ok')
    const failed = await sample()
    const { received, logged } = await alertTo(200, [passed.finish(), failed])
    assert.deepEqual(received, [{ contentType: 'application/json', body: alertPayload(failed) }])
    assert.deepEqual(logged, ['alert sent for sample'])
  })

  it('logs a refused alert without printing the webhook', async () => {
    const { received, logged } = await alertTo(500, [await sample()])
    assert.equal(received.length, 1)
    assert.deepEqual(logged, ['alert failed with HTTP 500 for sample'])
    assert.ok(logged.every((l) => !l.includes('secret-token') && !l.includes('127.0.0.1')))
  })
})

describe('requests', () => {
  it('say why nothing answered', async () => {
    // A port that was free a moment ago, so nothing listens on it.
    const server = createServer().listen(0, '127.0.0.1')
    await once(server, 'listening')
    const { port } = server.address() as AddressInfo
    await new Promise((resolve) => server.close(resolve))
    const answer = await probe(`http://127.0.0.1:${port}/`, { timeoutMs: 5_000 })
    assert.equal(answer.status, null)
    assert.match(answer.error ?? '', /^no answer: ECONNREFUSED/)
  })

  it('fail only the probe whose Location is not a URL, and keep its query out of the error', async () => {
    const server = await serve((_, response) => response.writeHead(302, { location: 'https://?code=leaked' }).end())
    try {
      const answer = await probe(`${server.url}/faq`)
      assert.deepEqual(answer, { status: 302, location: null, body: '', error: 'Location "https://" is not a URL' })
      assert.equal(describeAnswer(answer), '302, but Location "https://" is not a URL')
    } finally {
      await server.close()
    }
  })

  it('keep the status when the body stalls, and fail only a read that needs the body', async () => {
    // Headers and half a page, then nothing: a hung render, not an unreachable host.
    const server = await serve((_, response) => {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.write('<html>')
    })
    try {
      assert.deepEqual(await probe(`${server.url}/pricing`, { timeoutMs: 2_000 }), { status: 200, location: null, body: '' })
      const answer = await probe(`${server.url}/pricing`, { timeoutMs: 300, readBody: true })
      assert.deepEqual(answer, { status: 200, location: null, body: '', error: 'the body did not finish within 0.3 s' })
      await assert.rejects(readPage(`${server.url}/pricing`, 300), { message: '200, but the body did not finish within 0.3 s' })
    } finally {
      await server.close()
    }
  })

  it('keep the status when the connection drops mid-body', async () => {
    const server = await serve((_, response) => {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.write('<html>', () => response.socket?.destroy())
    })
    try {
      const answer = await probe(`${server.url}/`, { timeoutMs: 5_000, readBody: true })
      assert.equal(answer.status, 200)
      assert.match(answer.error ?? '', /^the body did not finish: ECONNRESET/)
    } finally {
      await server.close()
    }
  })

  it('read a page only from a 200, naming what came instead', async () => {
    const server = await serve((request, response) => {
      if (request.url === '/') response.writeHead(200).end('<p>home</p>')
      else response.writeHead(301, { location: '/elsewhere?token=x' }).end()
    })
    try {
      assert.equal(await readPage(`${server.url}/`), '<p>home</p>')
      await assert.rejects(readPage(`${server.url}/moved`), { message: `301 → ${server.url}/elsewhere, wanted 200` })
    } finally {
      await server.close()
    }
  })
})

describe('URLs in results', () => {
  it('keeps the origin, the path and only the named parameters', () => {
    const authorize = 'https://tenant.example/authorize?client_id=abc&state=xyz&screen_hint=signup'
    assert.equal(safeUrl(authorize), 'https://tenant.example/authorize')
    assert.equal(safeUrl(authorize, ['screen_hint']), 'https://tenant.example/authorize?screen_hint=signup')
    assert.equal(safeUrl(null), '(none)')
  })
})
