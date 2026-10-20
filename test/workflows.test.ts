import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/** A concurrency setting, as `<file>` for a workflow's or `<file> <job>` for a job's, its keys as written. */
interface Concurrency {
  owner: string
  keys: Record<string, string>
}

/** A job that can read the test user's password, as `<file> <job>`, and the line that hands it over, as `<file>:<line>`. */
interface SignIn {
  owner: string
  at: string
}

/**
 * The password's secret in any form GitHub resolves, whatever its case, or
 * every secret at once. A reusable workflow called with `secrets: inherit` is
 * a file here too, and its own jobs are read.
 */
const password = /secrets\s*(?:\.\s*e2e_user_password\b|\[\s*(['"])e2e_user_password\1\s*\])|tojson\(\s*secrets\s*\)/i

/** A scalar as written: unquoted, and without its trailing comment. */
function scalar(raw: string): string {
  const value = raw.trim()
  const quoted = /^(['"])(.*?)\1\s*(?:#.*)?$/.exec(value)
  return quoted ? quoted[2]! : value.replace(/(?:^|\s+)#.*$/, '')
}

/** The `concurrency:` at `indent` among `lines`, inline (`concurrency: <group>`) or as a block mapping. */
function concurrency(lines: string[], indent: number, owner: string): Record<string, string> | undefined {
  const at = lines.findIndex((l) => l.startsWith(`${' '.repeat(indent)}concurrency:`))
  if (at < 0) return undefined
  const inline = scalar(lines[at]!.slice(indent + 'concurrency:'.length))
  assert.ok(!inline.startsWith('{'), `${owner} writes concurrency in flow form ({ … }), which this test does not read`)
  if (inline) return { group: inline }
  const keys: Record<string, string> = {}
  for (const line of lines.slice(at + 1)) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    if (line.search(/\S/) <= indent) break
    const m = /^\s*([\w-]+):\s*(.*)$/.exec(line)
    if (m) keys[m[1]!] = scalar(m[2]!)
  }
  return keys
}

/**
 * Every workflow's concurrency settings, and the jobs that can read the test
 * user's password: those that name it, and every job of a workflow that names
 * it outside its jobs (a workflow-level `env:`). It fails on what it cannot
 * read rather than skip it: a line no deeper than a job header that is not
 * one, and a `jobs:` with no job.
 */
function read(dir: string): { settings: Concurrency[]; signsIn: SignIn[] } {
  const settings: Concurrency[] = []
  const signsIn: SignIn[] = []
  for (const file of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort()) {
    const lines = readFileSync(join(dir, file), 'utf8').split(/\r?\n/)
    const reads = (from: number, to: number) => {
      const i = lines.slice(from, to).findIndex((l) => password.test(l))
      return i < 0 ? undefined : `${file}:${from + i + 1}`
    }
    const start = lines.findIndex((l) => /^jobs:\s*(?:#.*)?$/.test(l))
    assert.ok(start >= 0, `${file} has jobs as a block mapping`)
    const after = lines.findIndex((l, i) => i > start && /^[^\s#]/.test(l))
    const end = after < 0 ? lines.length : after
    const top = concurrency([...lines.slice(0, start), ...lines.slice(end)], 0, file)
    if (top) settings.push({ owner: file, keys: top })
    const everyJob = reads(0, start) ?? reads(end, lines.length)

    const first = lines.findIndex((l, i) => i > start && i < end && l.trim() && !l.trim().startsWith('#'))
    assert.ok(first >= 0, `${file}'s jobs holds a job`)
    const depth = lines[first]!.search(/\S/)
    const header = new RegExp(`^ {${depth}}(['"]?)([A-Za-z_][\\w-]*)\\1:\\s*(?:#.*)?$`)
    const jobs: { id: string; at: number }[] = []
    for (let i = first; i < end; i++) {
      const line = lines[i]!
      if (!line.trim() || line.trim().startsWith('#') || line.search(/\S/) > depth) continue
      const m = header.exec(line)
      assert.ok(m, `${file}:${i + 1} is no deeper than a job header, but is not one`)
      jobs.push({ id: m[2]!, at: i })
    }
    jobs.forEach(({ id, at }, n) => {
      const owner = `${file} ${id}`
      const to = jobs[n + 1]?.at ?? end
      const body = lines.slice(at + 1, to)
      const key = body.find((l) => l.trim() && !l.trim().startsWith('#'))
      const keys = key === undefined ? undefined : concurrency(body, key.search(/\S/), owner)
      if (keys) settings.push({ owner, keys })
      const where = reads(at, to) ?? everyJob
      if (where) signsIn.push({ owner, at: where })
    })
  }
  return { settings, signsIn }
}

// GitHub keeps one pending job in a concurrency group by default, and a newer
// one cancels it without failing it, losing that run. J2's and the agent
// probe's alerting runs (scheduled or dispatched, of main) post an alert on
// such a cancel (`e2e-j2-cancelled`, `e2e-agent-j0-cancelled`); the port
// suite's alert is a step of the job that was cancelled, and a pull request's
// run has no webhook, so those go unannounced. Every job of
// production-test-user setting `queue: max` keeps them all, and one that does
// not still cancels every pending one when it comes up (a J2 run did so to the
// agent probe on 2026-10-20). actionlint does not know the key; this test
// fails when a job drops it, before a run is lost.
describe('the production-test-user concurrency group', () => {
  const { settings, signsIn } = read(join(import.meta.dirname, '..', '.github', 'workflows'))
  const group = settings.filter((s) => s.keys.group === 'production-test-user')

  it('holds every job that signs in as the test user, and nothing else', () => {
    assert.deepEqual(
      group.map((s) => s.owner),
      ['agent-j0-probe.yml probe', 'j2.yml sign-in', 'j2.yml j2', 'ports.yml ports'],
    )
    for (const { owner, at } of signsIn) {
      assert.ok(
        group.some((s) => s.owner === owner),
        `${owner} can read the password (${at}) outside production-test-user`,
      )
    }
    for (const { owner } of group) {
      assert.ok(
        signsIn.some((s) => s.owner === owner),
        `${owner} is in production-test-user but never reads the password`,
      )
    }
  })

  it('keeps every waiting job, and cancels none in progress', () => {
    for (const { owner, keys } of group) {
      assert.equal(keys['cancel-in-progress'], 'false', `${owner} sets cancel-in-progress: false`)
      assert.equal(keys.queue, 'max', `${owner} sets queue: max`)
    }
  })
})

// The reader above lets a job escape the group if it misses one, and fails a
// workflow GitHub accepts if it misreads one. Each case is a form it once got
// wrong.
describe('reading the workflows', () => {
  const grouped = ['    concurrency:', '      group: production-test-user', '      cancel-in-progress: false', '      queue: max']
  const job = (id: string, ...body: string[]) => [`  ${id}:`, '    runs-on: ubuntu-latest', ...body]
  const signs = (form = 'secrets.E2E_USER_PASSWORD') => ['    env:', `      E2E_USER_PASSWORD: \${{ ${form} }}`]
  const workflow = (...lines: string[]) => ['on: push', 'jobs:', ...lines].join('\n')

  function reading(files: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), 'e2e-workflows-'))
    try {
      for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
      return read(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  const owners = (files: Record<string, string>) => reading(files).signsIn.map((s) => s.owner)

  it('reads .yaml files as well as .yml', () => {
    assert.deepEqual(owners({ 'a.yaml': workflow(...job('x', ...signs())), 'b.yml': workflow(...job('y', ...signs())) }), [
      'a.yaml x',
      'b.yml y',
    ])
  })

  it('finds the password in any form and case', () => {
    for (const form of [
      "secrets['E2E_USER_PASSWORD']",
      'secrets[ "e2e_user_password" ]',
      'secrets.e2e_user_password',
      'toJSON(secrets)',
    ]) {
      assert.deepEqual(owners({ 'w.yml': workflow(...job('x', ...signs(form)), ...job('y')) }), ['w.yml x'], form)
    }
  })

  it('counts a password named outside the jobs for every job of that workflow', () => {
    const text = ['on: push', 'env:', '  P: ${{ secrets.E2E_USER_PASSWORD }}', 'jobs:', ...job('x'), ...job('y')].join('\n')
    assert.deepEqual(reading({ 'w.yml': text }).signsIn, [
      { owner: 'w.yml x', at: 'w.yml:3' },
      { owner: 'w.yml y', at: 'w.yml:3' },
    ])
    const after = ['on: push', 'jobs:', ...job('x'), 'env:', '  P: ${{ secrets.E2E_USER_PASSWORD }}'].join('\n')
    assert.deepEqual(owners({ 'w.yml': after }), ['w.yml x'])
  })

  it('reads a job whose header has a trailing comment or space, or a deeper indent', () => {
    const { settings, signsIn } = reading({
      'w.yml': workflow(...job('probe', ...grouped, ...signs()), '  probe2: # one more', '    concurrency: production-test-user', '  edge: ', ...signs()),
    })
    assert.deepEqual(
      settings.map((s) => [s.owner, s.keys.queue]),
      [
        ['w.yml probe', 'max'],
        ['w.yml probe2', undefined],
      ],
    )
    assert.deepEqual(
      signsIn.map((s) => s.owner),
      ['w.yml probe', 'w.yml edge'],
    )
    const deeper = workflow(...[...job('x', ...grouped), ...job('y', ...signs())].map((l) => `  ${l}`))
    assert.deepEqual(reading({ 'w.yml': deeper }).settings.map((s) => s.owner), ['w.yml x'])
    assert.deepEqual(owners({ 'w.yml': deeper }), ['w.yml y'])
  })

  it('fails on a line no deeper than a job header that is not one, and on jobs with none', () => {
    assert.throws(() => reading({ 'w.yml': workflow(...job('x'), '  y: &anchor', ...signs()) }), /w\.yml:5 is no deeper than a job header/)
    assert.throws(() => reading({ 'w.yml': workflow(...job('x'), ' y:', ...signs()) }), /w\.yml:5 is no deeper than a job header/)
    assert.throws(() => reading({ 'w.yml': workflow('  # none yet') }), /w\.yml's jobs holds a job/)
    assert.throws(() => reading({ 'w.yml': 'on: push\njobs: {}\n' }), /w\.yml has jobs as a block mapping/)
  })

  it('reads trailing comments, quoted values and CRLF line endings', () => {
    const lines = [
      'on: push # every push',
      'jobs: # one',
      '  x:',
      '    concurrency: # the test user',
      "      group: 'production-test-user' # shared",
      '      cancel-in-progress: false',
      '      queue: max # keep them all',
    ]
    for (const text of [lines.join('\n'), lines.join('\r\n')]) {
      assert.deepEqual(reading({ 'w.yml': text }).settings, [
        { owner: 'w.yml x', keys: { group: 'production-test-user', 'cancel-in-progress': 'false', queue: 'max' } },
      ])
    }
  })

  it('fails naming the flow form of concurrency, which it does not read', () => {
    const text = workflow(...job('x', '    concurrency: { group: production-test-user, queue: max }'))
    assert.throws(() => reading({ 'w.yml': text }), /w\.yml x writes concurrency in flow form/)
  })
})
