import { safeUrl } from '../http.ts'
import { Failure } from '../report.ts'

/**
 * Requests to a port, as a developer makes them with the key the Console
 * shows. The key goes in the `dmtr-api-key` header, never in a URL, so no
 * error message, log line or result can carry it; the port's URL is reported
 * by origin and path.
 */

/** What one request answered: its status, or why there was none. */
export interface PortAnswer {
  status: number | null
  error?: string
  /** The parsed JSON body of a 2xx, when it is JSON. */
  body?: unknown
}

export async function portGet(url: string, key: string, timeoutMs = 15_000): Promise<PortAnswer> {
  try {
    const response = await fetch(url, { headers: { 'dmtr-api-key': key }, signal: AbortSignal.timeout(timeoutMs) })
    const text = await response.text()
    if (!response.ok) return { status: response.status }
    try {
      return { status: response.status, body: JSON.parse(text) as unknown }
    } catch {
      return { status: response.status }
    }
  } catch (error) {
    const cause = (error as { cause?: { code?: string } }).cause
    return { status: null, error: cause?.code ?? (error as Error).name }
  }
}

export const describePortAnswer = (a: PortAnswer): string => (a.status === null ? `no answer (${a.error})` : String(a.status))

/**
 * GETs `url` every `everyMs` until it answers 2xx or `timeoutMs` passes. A new
 * port answers 401 until the proxies have loaded its key. Returns the 2xx
 * answer and how many requests it took.
 */
export async function untilSuccess(
  url: string,
  key: string,
  { timeoutMs = 180_000, everyMs = 5_000 } = {},
): Promise<{ answer: PortAnswer; tries: number; at: number }> {
  const deadline = performance.now() + timeoutMs
  const seen = new Map<string, number>()
  for (let tries = 1; ; tries += 1) {
    const answer = await portGet(url, key)
    if (answer.status !== null && answer.status >= 200 && answer.status < 300) return { answer, tries, at: performance.now() }
    const said = describePortAnswer(answer)
    seen.set(said, (seen.get(said) ?? 0) + 1)
    if (performance.now() + everyMs > deadline) {
      const answers = [...seen].map(([s, n]) => `${n}× ${s}`).join(', ')
      throw new Failure(`${safeUrl(url)} answered no 2xx in ${Math.round(timeoutMs / 1000)} s: ${answers}`)
    }
    await new Promise((resolve) => setTimeout(resolve, everyMs))
  }
}

/** How many requests answered each status, as `200×28, 429×2`; no answer counts as `none`. */
export function tally(answers: PortAnswer[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const a of answers) {
    const key = a.status === null ? 'none' : String(a.status)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return new Map([...counts].sort(([a], [b]) => a.localeCompare(b)))
}

export const describeTally = (counts: Map<string, number>): string => [...counts].map(([s, n]) => `${s}×${n}`).join(', ')

/** `size` concurrent GETs of `url`, each on its own connection's schedule. */
export const burst = (url: string, key: string, size: number): Promise<PortAnswer[]> =>
  Promise.all(Array.from({ length: size }, () => portGet(url, key)))
