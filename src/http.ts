/** What one request answered, without following a redirect. */
export interface Answer {
  /** The HTTP status, or null when nothing answered (curl's `000`). */
  status: number | null
  location: string | null
  body: string
  /** Why nothing answered: a timeout, or the connection's error code. */
  error?: string
}

/**
 * One request that never follows a redirect, as `curl -s` without `-L` does:
 * the answer is the first response, and its `Location` is reported, not
 * visited. A timeout or a connection error is an answer with no status, and
 * `error` says which.
 */
export async function probe(url: string, { timeoutMs = 15_000, readBody = false } = {}): Promise<Answer> {
  try {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) })
    const location = response.headers.get('location')
    const body = readBody ? await response.text() : ''
    if (!readBody) await response.body?.cancel()
    return {
      status: response.status,
      location: location === null ? null : new URL(location, url).toString(),
      body,
    }
  } catch (error) {
    const cause = (error as { cause?: { code?: string; message?: string } }).cause
    const why =
      error instanceof Error && error.name === 'TimeoutError'
        ? `no answer within ${timeoutMs / 1000} s`
        : `no answer: ${cause?.code ?? (error as Error).name}${cause?.message ? ` (${cause.message})` : ''}`
    return { status: null, location: null, body: '', error: why }
  }
}

/**
 * A URL fit for a result file: origin and path, plus only the query
 * parameters named in `keep`. An authorize URL's `state` and a callback's
 * `code` never make it into a log this way.
 */
export function safeUrl(url: string | null, keep: string[] = []): string {
  if (url === null) return '(none)'
  const u = new URL(url)
  const kept = keep.filter((k) => u.searchParams.has(k)).map((k) => `${k}=${u.searchParams.get(k)}`)
  return `${u.origin}${u.pathname}${kept.length ? `?${kept.join('&')}` : ''}`
}
