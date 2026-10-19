import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, mock } from 'node:test'
import { safeUrl } from '../src/http.ts'
import { alertFailures, alertPayload, formatMarkdown, Run, writeResult } from '../src/report.ts'

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
})

describe('URLs in results', () => {
  it('keeps the origin, the path and only the named parameters', () => {
    const authorize = 'https://tenant.example/authorize?client_id=abc&state=xyz&screen_hint=signup'
    assert.equal(safeUrl(authorize), 'https://tenant.example/authorize')
    assert.equal(safeUrl(authorize, ['screen_hint']), 'https://tenant.example/authorize?screen_hint=signup')
    assert.equal(safeUrl(null), '(none)')
  })
})
