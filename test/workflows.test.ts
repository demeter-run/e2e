import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const dir = join(import.meta.dirname, '..', '.github', 'workflows')

/** A concurrency setting, as `<file>` for a workflow's or `<file> <job>` for a job's, its keys as written. */
interface Concurrency {
  owner: string
  keys: Record<string, string>
}

const unquote = (value: string) => value.trim().replace(/^(['"])(.*)\1$/, '$2')

/** The `concurrency:` at `indent` among `lines`, inline (`concurrency: <group>`) or as a mapping. */
function concurrency(lines: string[], indent: number): Record<string, string> | undefined {
  const at = lines.findIndex((l) => l.startsWith(`${' '.repeat(indent)}concurrency:`))
  if (at < 0) return undefined
  const inline = lines[at]!.slice(indent + 'concurrency:'.length).trim()
  if (inline) return { group: unquote(inline) }
  const keys: Record<string, string> = {}
  for (const line of lines.slice(at + 1)) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    if (line.search(/\S/) <= indent) break
    const m = /^\s*([\w-]+):\s*(.*)$/.exec(line)
    if (m) keys[m[1]!] = unquote(m[2]!)
  }
  return keys
}

/** Every workflow's concurrency settings, and the jobs that hold the test user's password. */
function read(): { settings: Concurrency[]; signsIn: string[] } {
  const settings: Concurrency[] = []
  const signsIn: string[] = []
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.yml')).sort()) {
    const lines = readFileSync(join(dir, file), 'utf8').split('\n')
    const start = lines.indexOf('jobs:')
    assert.ok(start >= 0, `${file} has jobs`)
    const top = concurrency(lines.slice(0, start), 0)
    if (top) settings.push({ owner: file, keys: top })
    const after = lines.findIndex((l, i) => i > start && /^[^\s#]/.test(l))
    const end = after < 0 ? lines.length : after
    const heads = lines.flatMap((l, i) => (i > start && i < end && /^ {2}[\w-]+:$/.test(l) ? [i] : []))
    heads.push(end)
    heads.slice(0, -1).forEach((head, n) => {
      const owner = `${file} ${lines[head]!.trim().slice(0, -1)}`
      const body = lines.slice(head + 1, heads[n + 1])
      const keys = concurrency(body, 4)
      if (keys) settings.push({ owner, keys })
      if (body.some((l) => l.includes('secrets.E2E_USER_PASSWORD'))) signsIn.push(owner)
    })
  }
  return { settings, signsIn }
}

// GitHub keeps one pending job in a concurrency group by default, and a newer
// one cancels it without failing it: no alert says that run was lost. Every
// job of production-test-user setting `queue: max` keeps them all, and one
// that does not still cancels every pending one when it comes up (a J2 run
// did so to the agent probe on 2026-10-20). actionlint does not know the key,
// so nothing else would notice it dropped.
describe('the production-test-user concurrency group', () => {
  const { settings, signsIn } = read()
  const group = settings.filter((s) => s.keys.group === 'production-test-user')

  it('holds every job that signs in as the test user, and nothing else', () => {
    assert.deepEqual(
      group.map((s) => s.owner),
      ['agent-j0-probe.yml probe', 'j2.yml sign-in', 'j2.yml j2', 'ports.yml ports'],
    )
    assert.deepEqual(signsIn, group.map((s) => s.owner))
  })

  it('keeps every waiting job, and cancels none in progress', () => {
    for (const { owner, keys } of group) {
      assert.equal(keys['cancel-in-progress'], 'false', `${owner} sets cancel-in-progress: false`)
      assert.equal(keys.queue, 'max', `${owner} sets queue: max`)
    }
  })
})
