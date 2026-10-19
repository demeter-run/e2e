import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * What every check and journey reports: one result file per run, a GitHub job
 * summary, and an IRM alert when a scheduled run fails.
 *
 * Nothing secret goes in a step's detail. A detail is written to the result
 * file, the job summary and the alert as-is, so the code producing it is where
 * a URL loses its query string (see `safeUrl` in `http.ts`).
 */

export interface Step {
  name: string
  ok: boolean
  ms: number
  detail: string
}

export interface Result {
  name: string
  /** The environment a live run targeted; null for a static run. */
  env: string | null
  started_at: string
  finished_at: string
  ok: boolean
  steps: Step[]
}

/** Thrown inside a step to fail it; its message becomes the step's detail. */
export class Failure extends Error {}

/** Collects the steps of one check or journey run. */
export class Run {
  readonly #steps: Step[] = []
  readonly #started = new Date()

  constructor(
    readonly name: string,
    readonly env: string | null,
  ) {}

  /**
   * Runs `fn` as one step. It passes when `fn` returns, with the returned text
   * as its detail, and fails when `fn` throws. A failed step does not stop the
   * run; the return value says whether it passed.
   */
  async step(name: string, fn: () => string | void | Promise<string | void>): Promise<boolean> {
    const t0 = performance.now()
    let ok = true
    let detail: string
    try {
      detail = (await fn()) ?? ''
    } catch (error) {
      ok = false
      detail = error instanceof Error ? error.message : String(error)
    }
    this.#steps.push({ name, ok, ms: Math.round(performance.now() - t0), detail })
    return ok
  }

  finish(): Result {
    return {
      name: this.name,
      env: this.env,
      started_at: this.#started.toISOString(),
      finished_at: new Date().toISOString(),
      ok: this.#steps.length > 0 && this.#steps.every((s) => s.ok),
      steps: this.#steps,
    }
  }
}

export async function writeResult(result: Result, dir = 'results'): Promise<string> {
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${result.name}.json`)
  await writeFile(path, `${JSON.stringify(result, null, 2)}\n`)
  return path
}

/** The run as plain text, for the terminal and the job log. */
export function formatText(results: Result[]): string {
  const lines: string[] = []
  for (const r of results) {
    const passed = r.steps.filter((s) => s.ok).length
    lines.push(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.env ? ` (${r.env})` : ''}: ${passed}/${r.steps.length} steps`)
    for (const s of r.steps) {
      const [first = '', ...rest] = s.detail.split('\n')
      lines.push(`  ${s.ok ? 'ok  ' : 'FAIL'}  ${s.name} (${s.ms} ms)${first ? `: ${first}` : ''}`)
      for (const line of rest) lines.push(`          ${line}`)
    }
  }
  return lines.join('\n')
}

/** The run as Markdown, for the GitHub job summary. */
export function formatMarkdown(results: Result[]): string {
  const lines = ['| Check | Result | Steps |', '| --- | --- | --- |']
  for (const r of results) {
    const passed = r.steps.filter((s) => s.ok).length
    lines.push(`| \`${r.name}\`${r.env ? ` (${r.env})` : ''} | ${r.ok ? '✅ pass' : '❌ fail'} | ${passed}/${r.steps.length} |`)
  }
  for (const r of results) {
    lines.push('', `### \`${r.name}\``, '')
    for (const s of r.steps) {
      lines.push(`- ${s.ok ? '✅' : '❌'} ${s.name} (${s.ms} ms)`)
      if (s.detail) lines.push('', '  ```', ...s.detail.split('\n').map((l) => `  ${l}`), '  ```', '')
    }
  }
  return `${lines.join('\n')}\n`
}

/** Appends the run to the GitHub job summary, when there is one. */
export async function writeJobSummary(results: Result[], title: string): Promise<void> {
  const path = process.env.GITHUB_STEP_SUMMARY
  if (!path) return
  await appendFile(path, `## ${title}\n\n${formatMarkdown(results)}\n`)
}

/** The Actions run this process belongs to, when it runs in one. */
function runUrl(): string {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env
  return GITHUB_SERVER_URL && GITHUB_REPOSITORY && GITHUB_RUN_ID
    ? `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`
    : ''
}

/** The body IRM's webhook integration takes, as fabric's `send_irm_alert` sends it. */
export function alertPayload(result: Result) {
  const failed = result.steps.filter((s) => !s.ok)
  const message = failed.map((s) => `${s.name}: ${s.detail}`).join('\n\n')
  return {
    alert_uid: `e2e-${result.name}`,
    title: `e2e ${result.name} failed${result.env ? ` (${result.env})` : ''}`,
    message: message.length > 4000 ? `${message.slice(0, 4000)}\n…` : message,
    state: 'alerting',
    link_to_upstream_details: runUrl(),
  }
}

/**
 * Posts one IRM alert per failed result. Without `IRM_E2E_WEBHOOK_URL` it says
 * so and sends nothing, which is what a branch run without the secret logs.
 * The webhook URL is a credential: it is never printed, not even on an error.
 */
export async function alertFailures(results: Result[]): Promise<void> {
  const webhook = process.env.IRM_E2E_WEBHOOK_URL
  for (const result of results.filter((r) => !r.ok)) {
    if (!webhook) {
      console.log(`alert skipped for ${result.name}: IRM_E2E_WEBHOOK_URL is not set`)
      continue
    }
    try {
      const response = await fetch(webhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(alertPayload(result)),
        signal: AbortSignal.timeout(15_000),
      })
      console.log(`alert ${response.ok ? 'sent' : `failed with HTTP ${response.status}`} for ${result.name}`)
    } catch (error) {
      console.log(`alert failed for ${result.name}: ${error instanceof Error ? error.name : 'error'}`)
    }
  }
}
