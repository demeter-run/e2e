import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after } from 'node:test'

/** A path inside the verbatim copies of the three repositories' files. */
export const fixture = (...path: string[]): string => join(import.meta.dirname, 'fixtures', 'main', ...path)

const copies: string[] = []
after(() => Promise.all(copies.map((dir) => rm(dir, { recursive: true, force: true }))))

/** A scratch copy of `fixtures/main`, removed when the test file ends. */
export async function copyFixtures(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'e2e-fixtures-'))
  copies.push(dir)
  await cp(fixture(), dir, { recursive: true })
  return dir
}

/**
 * Replaces the first `from` in a file, after the first `anchor` when one is
 * given; fails when there is nothing to replace, so a fixture refresh that
 * moves the text breaks the test instead of silently testing nothing.
 */
export async function edit(path: string, from: string, to: string, anchor?: string): Promise<void> {
  const text = await readFile(path, 'utf8')
  const start = anchor === undefined ? 0 : text.indexOf(anchor)
  const at = start < 0 ? -1 : text.indexOf(from, start)
  if (at < 0) throw new Error(`${path}: "${from}"${anchor ? ` after "${anchor}"` : ''} not found`)
  await writeFile(path, text.slice(0, at) + to + text.slice(at + from.length))
}
