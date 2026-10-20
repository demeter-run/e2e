import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/** A job's concurrency setting, as `<file> <job>`, its keys as written. */
interface Concurrency {
  owner: string
  keys: Record<string, string>
}

/** A job that can read the test user's password, as `<file> <job>`, and the line that hands it over, as `<file>:<line>`. */
interface SignIn {
  owner: string
  at: string
}

const testUserGroup = 'production-test-user'

/** Whether a job is in production-test-user: GitHub compares group names ignoring case. */
const inGroup = ({ keys }: Concurrency) => keys.group?.toLowerCase() === testUserGroup

/** Whether a group may be production-test-user: it is, or the text around its expressions fits it. */
function mayBe(group: string | undefined): boolean {
  const g = group?.toLowerCase()
  if (!g?.includes('${{')) return g === testUserGroup
  const [open, close] = [g.indexOf('${{'), g.lastIndexOf('}}')]
  if (close < open) return true
  const [head, tail] = [g.slice(0, open), g.slice(close + 2)]
  return head.length + tail.length <= testUserGroup.length && testUserGroup.startsWith(head) && testUserGroup.endsWith(tail)
}

/** A scalar as written: unquoted, and without its trailing comment. */
function scalar(raw: string): string {
  const value = raw.trim()
  const quoted = /^(['"])(.*?)\1\s*(?:#.*)?$/.exec(value)
  return quoted ? quoted[2]! : value.replace(/(?:^|\s+)#.*$/, '')
}

/**
 * The `concurrency:` at `indent` among `lines`, inline (`concurrency: <group>`)
 * or as a block mapping of one-line values; it fails on any other form.
 */
function concurrency(lines: string[], indent: number, owner: string): Record<string, string> | undefined {
  const key = new RegExp(`^ {${indent}}(['"]?)concurrency\\1:`)
  const at = lines.findIndex((l) => key.test(l))
  if (at < 0) return undefined
  const inline = scalar(lines[at]!.replace(key, ''))
  assert.ok(!/^[[{|>]/.test(inline), `${owner} writes concurrency as ${inline}, a form this test does not read`)
  if (inline) return { group: inline }
  const keys: Record<string, string> = {}
  for (const line of lines.slice(at + 1)) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    if (line.search(/\S/) <= indent) break
    const m = /^\s*([\w-]+):\s*(.*)$/.exec(line)
    const value = m ? scalar(m[2]!) : ''
    assert.ok(value && !/^[[{|>]/.test(value), `${owner} writes concurrency's ${line.trim()} in a form this test does not read`)
    keys[m![1]!] = value
  }
  return keys
}

/** An expression's reference to one named secret, as `secrets.<name>` or `secrets['<name>']`. */
const namedSecret = /(?<![\w.-])secrets\s*(?:\.\s*([A-Za-z_][\w-]*)|\[\s*(?:'((?:[^']|'')*)'|"([^"]*)")\s*\])/gi

/** Where the expression whose text starts at `from` ends (its `}}`, outside its quoted strings), or -1. */
function closing(line: string, from: number): number {
  let quoted = false
  for (let k = from; k < line.length; k++) {
    if (line[k] === "'") quoted = !quoted
    else if (!quoted && line.startsWith('}}', k)) return k
  }
  return -1
}

/** Whether a line's `${{ }}` expressions name the password; it fails on one that reaches secrets any other way. */
function namesPassword(at: string, line: string): boolean {
  let names = false
  for (let open = line.indexOf('${{'); open >= 0; ) {
    const close = closing(line, open + 3)
    assert.ok(close >= 0, `${at} continues an expression onto another line, which this test does not read`)
    const rest = line.slice(open + 3, close).replace(namedSecret, (_, dotted?: string, single?: string, double?: string) => {
      names ||= (dotted ?? single?.replaceAll("''", "'") ?? double)!.toLowerCase() === 'e2e_user_password'
      return ' '
    })
    assert.ok(
      !/(?<![\w.-])secrets(?![\w-])/i.test(rest.replace(/'(?:[^']|'')*'/g, "''")),
      `${at} reaches secrets in a form this test does not read: ${line.slice(open, close + 2)}`,
    )
    open = line.indexOf('${{', close + 2)
  }
  return names
}

/**
 * Which lines of a workflow hand a job the test user's password: those whose
 * `${{ }}` expressions name `secrets.E2E_USER_PASSWORD` or
 * `secrets['E2E_USER_PASSWORD']`, in any case. GitHub resolves secrets in
 * expressions only, so words elsewhere and YAML comments are not reads; a
 * block scalar's lines (`run: |`) are read whole, as GitHub interpolates the
 * ones that look like comments too. It reads the text as written, a line at a
 * time, and fails, naming the line, on each shape that can hand the password
 * over in a way it does not read:
 * - any other use of `secrets` in an expression (`secrets.*`, a computed
 *   index, `toJSON(secrets)`), which can reach every secret;
 * - `secrets: inherit`, which hands every secret to a reusable workflow;
 * - a YAML anchor, alias or tag, which can repeat or recast a value elsewhere;
 * - a backslash outside a block scalar, which a double-quoted string decodes;
 * - an expression that does not close on its line, and a YAML comment that
 *   holds one.
 */
function passwordLines(file: string, lines: string[]): boolean[] {
  let block: number | undefined
  return lines.map((line, i) => {
    const at = `${file}:${i + 1}`
    const indent = line.search(/\S/)
    if (block !== undefined && (indent < 0 || indent > block)) return namesPassword(at, line)
    block = undefined
    const text = line.trim()
    if (text.startsWith('#')) {
      assert.ok(!text.includes('${{'), `${at} is a YAML comment that holds an expression, which this test does not read`)
      return false
    }
    const node = text.replace(/^(?:-\s+)*/, '')
    const key = /^(?:[^\s:#'"]+|'[^']*'|"[^"]*")\s*:(?:\s+|$)/.exec(node)
    const value = key ? node.slice(key[0].length) : node
    assert.ok(
      !/^[!&*]\S/.test(value) && !(/^[[{]/.test(value) && /[[{,]\s*[!&*]\S/.test(value)),
      `${at} uses a YAML anchor, alias or tag, which this test does not read`,
    )
    assert.ok(
      !/(?:^|[\s{,])secrets\s*:\s*['"]?inherit\b/i.test(node),
      `${at} hands every secret to a reusable workflow (secrets: inherit), which this test does not follow`,
    )
    assert.ok(!text.includes('\\'), `${at} holds a backslash outside a block scalar, which a double-quoted string decodes and this test does not`)
    // A block scalar holds the lines deeper than its key (`run: |`) or its dash
    // (`- |`), and for a bare `|` those from its own column on.
    const opens = /^(\s*)((?:-\s+)*)([^\s:#'"]+\s*:\s+)?[|>][1-9+-]*\s*(?:#.*)?$/.exec(line)
    if (opens) block = opens[1]!.length + (opens[3] ? opens[2]!.length : opens[2]!.lastIndexOf('-'))
    return namesPassword(at, line)
  })
}

/**
 * Every job's concurrency settings, and the jobs that can read the test
 * user's password: those with a line that names it, and every job of a
 * workflow that names it outside its jobs (a workflow-level `env:`). A job's
 * group is read from its own `concurrency:` only, so it fails on a group that
 * may be production-test-user set any other way: for the whole workflow, on a
 * job that calls a reusable workflow (whose jobs then run in it), or by an
 * expression it cannot rule out. It fails too on a line no deeper than a job
 * header that is not one, and on a `jobs:` with no job.
 */
function read(dir: string): { settings: Concurrency[]; signsIn: SignIn[] } {
  const settings: Concurrency[] = []
  const signsIn: SignIn[] = []
  for (const file of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort()) {
    const lines = readFileSync(join(dir, file), 'utf8').split(/\r?\n/)
    const names = passwordLines(file, lines)
    const reads = (from: number, to: number) => {
      const i = names.slice(from, to).indexOf(true)
      return i < 0 ? undefined : `${file}:${from + i + 1}`
    }
    const start = lines.findIndex((l) => /^jobs:\s*(?:#.*)?$/.test(l))
    assert.ok(start >= 0, `${file} has jobs as a block mapping`)
    const after = lines.findIndex((l, i) => i > start && /^[^\s#]/.test(l))
    const end = after < 0 ? lines.length : after
    const top = concurrency([...lines.slice(0, start), ...lines.slice(end)], 0, file)
    assert.ok(!mayBe(top?.group), `${file} sets the concurrency group ${top?.group} for the whole workflow, which this test does not read`)
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
      const indent = body.find((l) => l.trim() && !l.trim().startsWith('#'))?.search(/\S/)
      const keys = indent === undefined ? undefined : concurrency(body, indent, owner)
      if (keys) {
        assert.ok(
          !keys.group?.includes('${{') || !mayBe(keys.group),
          `${owner} sets the concurrency group ${keys.group}, which this test cannot tell from ${testUserGroup}`,
        )
        const calls = body.findIndex((l) => l.startsWith(`${' '.repeat(indent!)}uses:`))
        assert.ok(
          calls < 0 || !mayBe(keys.group),
          `${owner} calls a reusable workflow (${file}:${at + calls + 2}) in the concurrency group ${keys.group}, which this test does not read`,
        )
        settings.push({ owner, keys })
      }
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
  const group = settings.filter(inGroup)

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
// wrong, or one it fails on rather than read.
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

  it('finds the password named in an expression, in any case', () => {
    for (const form of [
      "secrets['E2E_USER_PASSWORD']",
      'secrets[ "e2e_user_password" ]',
      'secrets.e2e_user_password',
      "format('{0}', secrets . E2E_USER_PASSWORD)",
      "format('}}{0}', secrets.E2E_USER_PASSWORD)",
    ]) {
      assert.deepEqual(owners({ 'w.yml': workflow(...job('x', ...signs(form)), ...job('y')) }), ['w.yml x'], form)
    }
  })

  it('reads no YAML comment or word outside an expression, and every line of a block scalar', () => {
    const words = workflow(
      ...job('x', '    steps:', '      - run: echo secrets.E2E_USER_PASSWORD'),
      '  # No job here reads secrets.E2E_USER_PASSWORD; y does.',
      ...job('y', '    steps:', '      - run: |', '          # ${{ secrets.E2E_USER_PASSWORD }}', '        name: walk'),
    )
    assert.deepEqual(reading({ 'w.yml': words }).signsIn, [{ owner: 'w.yml y', at: 'w.yml:12' }])
  })

  it('fails on every other way to reach a secret', () => {
    for (const form of ['toJSON(secrets)', "join(secrets.*, ' ')", 'secrets[matrix.secret]', "secrets[format('E2E_{0}', 'USER_PASSWORD')]"]) {
      assert.throws(() => reading({ 'w.yml': workflow(...job('x', ...signs(form))) }), /w\.yml:6 reaches secrets in a form this test does not read/, form)
    }
    const inherit = workflow('  x:', '    uses: other/repo/.github/workflows/walk.yml@main', '    secrets: inherit')
    assert.throws(() => reading({ 'w.yml': inherit }), /w\.yml:5 hands every secret to a reusable workflow/)
    const split = workflow(...job('x', '    env:', '      P: ${{', '        secrets.E2E_USER_PASSWORD }}'))
    assert.throws(() => reading({ 'w.yml': split }), /w\.yml:6 continues an expression onto another line/)
    const comment = workflow(...job('x', '    # ${{ secrets.E2E_USER_PASSWORD }}'))
    assert.throws(() => reading({ 'w.yml': comment }), /w\.yml:5 is a YAML comment that holds an expression/)
    const escaped = workflow(...job('x', '    env:', '      P: "\\x24{{ secrets.E2E_USER_PASSWORD }}"'))
    assert.throws(() => reading({ 'w.yml': escaped }), /w\.yml:6 holds a backslash outside a block scalar/)
  })

  it('fails on a YAML anchor, alias or tag, and reads a script as text', () => {
    for (const body of [
      ['    env: &creds', '      P: ${{ secrets.E2E_USER_PASSWORD }}'],
      ['    env: *creds'],
      ['    <<: *base'],
      ['    steps:', '      - *checkout'],
      ['    concurrency: !!str production-test-user'],
      ['    needs: [a, *b]'],
      // A step's key after its script ends the script.
      ['    steps:', '      - run: |', '          echo', '        env: *creds'],
    ]) {
      const line = 5 + body.findIndex((l) => /[!&*]/.test(l))
      assert.throws(() => reading({ 'w.yml': workflow(...job('x', ...body)) }), new RegExp(`w\\.yml:${line} uses a YAML anchor, alias or tag`), body.join(' '))
    }
    const script = [
      'on:',
      '  schedule:',
      "    - cron: '0 6 * * *'",
      'jobs:',
      ...job(
        'x',
        '    if: >-',
        '      !cancelled()',
        '      && true',
        '    steps:',
        '      - run: |',
        '          case "$a" in',
        '            *) echo "\\$a" && exit 0 ;;',
        '          esac',
        '      - uses: ./walk',
        '        with:',
        '          args:',
        '            - |',
        '             *.ts',
      ),
    ].join('\n')
    assert.deepEqual(reading({ 'w.yml': script }), { settings: [], signsIn: [] })
  })

  it('compares group names ignoring case, as GitHub does', () => {
    const { settings } = reading({
      'w.yml': workflow(...job('x', '    concurrency: Production-Test-User'), ...job('y', '    concurrency:', '      group: PRODUCTION-TEST-USER')),
    })
    assert.deepEqual(settings.filter(inGroup).map((s) => s.owner), ['w.yml x', 'w.yml y'])
  })

  it('fails on a group that may be production-test-user, set other than on a job of its own', () => {
    const before = ['on: push', 'concurrency: production-test-user', 'jobs:', ...job('x')].join('\n')
    assert.throws(() => reading({ 'w.yml': before }), /w\.yml sets the concurrency group production-test-user for the whole workflow/)
    const after = ['on: push', 'jobs:', ...job('x'), 'concurrency:', '  group: Production-Test-User'].join('\n')
    assert.throws(() => reading({ 'w.yml': after }), /w\.yml sets the concurrency group Production-Test-User for the whole workflow/)
    // A calling job's group holds the jobs of the workflow it calls.
    const calls = workflow('  walk:', '    uses: ./.github/workflows/walk.yml', ...grouped)
    assert.throws(() => reading({ 'w.yml': calls }), /w\.yml walk calls a reusable workflow \(w\.yml:4\) in the concurrency group production-test-user/)
    for (const group of ["${{ 'production-test-user' }}", '${{ inputs.who }}-user', 'production-${{ inputs.who }}']) {
      assert.throws(() => reading({ 'w.yml': workflow(...job('x', `    concurrency: ${group}`)) }), /w\.yml x sets the concurrency group .+, which this test cannot tell/, group)
    }
    // Text around an expression that rules production-test-user out reads as another group.
    const other = ['on: push', 'concurrency:', '  group: j2-${{ github.run_id }}', 'jobs:', '  walk:', '    uses: ./.github/workflows/walk.yml', '    concurrency: ${{ github.workflow }}-walk'].join('\n')
    assert.deepEqual(reading({ 'w.yml': other }).settings, [{ owner: 'w.yml walk', keys: { group: '${{ github.workflow }}-walk' } }])
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

  it('reads on past a comment at column 0 inside jobs', () => {
    const text = workflow(...job('x'), '# y signs in', ...job('y', ...signs()))
    assert.deepEqual(reading({ 'w.yml': text }).signsIn, [{ owner: 'w.yml y', at: 'w.yml:9' }])
  })

  it('reads a job whose header has a trailing comment or space, or a deeper indent', () => {
    const { settings, signsIn } = reading({
      'w.yml': workflow(...job('probe', ...grouped, ...signs()), '  probe2: # one more', '    concurrency: production-test-user', '  edge: ', ...signs()),
    })
    assert.deepEqual(
      settings.map((s) => [s.owner, s.keys]),
      [
        ['w.yml probe', { group: 'production-test-user', 'cancel-in-progress': 'false', queue: 'max' }],
        ['w.yml probe2', { group: 'production-test-user' }],
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
    assert.throws(() => reading({ 'w.yml': workflow(...job('x'), '  y: 1', ...signs()) }), /w\.yml:5 is no deeper than a job header/)
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
    const quoted = workflow(...job('x', "    'concurrency': production-test-user"))
    assert.deepEqual(reading({ 'w.yml': quoted }).settings, [{ owner: 'w.yml x', keys: { group: 'production-test-user' } }])
  })

  it('fails on concurrency in a form it does not read', () => {
    for (const body of [
      ['    concurrency: { group: production-test-user, queue: max }'],
      ['    concurrency: >-', '      production-test-user'],
      ['    concurrency:', '      group:', '        production-test-user'],
    ]) {
      assert.throws(() => reading({ 'w.yml': workflow(...job('x', ...body)) }), /w\.yml x writes concurrency.* a form this test does not read/, body.join(' '))
    }
  })
})
