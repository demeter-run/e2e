import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** The repositories whose seams the contract checks read. */
export const repositories = {
  fabric: 'demeter-run/fabric',
  webui: 'demeter-run/webui',
  website2: 'demeter-run/website2',
} as const

export type SourceName = keyof typeof repositories

/**
 * The working trees a check reads. Each defaults to a fresh shallow clone of
 * the repository's `main`, made the first time a check asks for it; an
 * override points at a directory instead (a pull request's head in CI, or a
 * local checkout).
 *
 * `webui` and `website2` are private. A clone authenticates with
 * `E2E_SOURCES_TOKEN` when it is set, and otherwise with whatever git
 * credentials the machine has. The token travels in git's environment, never
 * on a command line, so no error message can print it.
 */
export class Sources {
  readonly #overrides: Partial<Record<SourceName, string>>
  readonly #clones = new Map<SourceName, Promise<string>>()
  #scratch: Promise<string> | undefined

  constructor(overrides: Partial<Record<SourceName, string | undefined>> = {}) {
    this.#overrides = {}
    for (const [name, dir] of Object.entries(overrides) as [SourceName, string | undefined][]) {
      if (dir === undefined) continue
      const path = resolve(dir)
      if (!existsSync(path)) throw new Error(`--${name} ${dir}: no such directory`)
      this.#overrides[name] = path
    }
  }

  /** The working tree for `name`, cloning it on first use. */
  dir(name: SourceName): Promise<string> {
    const override = this.#overrides[name]
    if (override) return Promise.resolve(override)
    let clone = this.#clones.get(name)
    if (!clone) {
      clone = this.#clone(name)
      this.#clones.set(name, clone)
    }
    return clone
  }

  /** Where `name` came from and at which commit, for a step's detail. */
  async describe(name: SourceName): Promise<string> {
    const dir = await this.dir(name)
    const head = await run('git', ['-C', dir, 'rev-parse', '--short=12', 'HEAD']).then(
      (r) => r.stdout.trim(),
      () => 'not a git checkout',
    )
    return this.#overrides[name] ? `${name} ${dir} @ ${head}` : `${name} main @ ${head}`
  }

  async cleanup(): Promise<void> {
    if (this.#scratch) await rm(await this.#scratch, { recursive: true, force: true })
  }

  async #clone(name: SourceName): Promise<string> {
    this.#scratch ??= mkdtemp(join(tmpdir(), 'e2e-sources-'))
    const dir = join(await this.#scratch, name)
    const url = `https://github.com/${repositories[name]}.git`
    try {
      await run('git', ['clone', '--quiet', '--depth=1', '--single-branch', '--branch=main', url, dir], {
        env: { ...process.env, ...gitAuth() },
      })
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr?.trim() ?? ''
      throw new Error(`could not clone ${repositories[name]} at main: ${stderr || 'git clone failed'}`)
    }
    return dir
  }
}

/**
 * git config for a clone, passed through the environment. A clone never asks
 * for a password: without credentials it fails instead of hanging a CI job.
 */
function gitAuth(): Record<string, string> {
  const token = process.env.E2E_SOURCES_TOKEN
  if (!token) return { GIT_TERMINAL_PROMPT: '0' }
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64')
  return {
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  }
}
