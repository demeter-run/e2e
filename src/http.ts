import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

/** What one request answered, without following a redirect. */
export interface Answer {
  /** The HTTP status, or null when nothing answered (curl's `000`). */
  status: number | null
  /** The `Location`, resolved against the request; null when there is none or it is not a URL. */
  location: string | null
  /** The body, when it was asked for and arrived whole; otherwise empty. */
  body: string
  /**
   * What went wrong, if anything: nothing answered (no status), or the status
   * arrived but the body did not finish, or the `Location` is not a URL. An
   * answer with an error passes no assertion.
   */
  error?: string
}

/** A `Location` as an answer carries it. One that is not a URL is reported up to its query, as `safeUrl` would. */
function locationOf(location: string | undefined, base: string): Pick<Answer, 'location' | 'error'> {
  if (location === undefined) return { location: null }
  try {
    return { location: new URL(location, base).toString() }
  } catch {
    return { location: null, error: `Location "${location.split(/[?#]/)[0]}" is not a URL` }
  }
}

/**
 * One GET that never follows a redirect, as `curl -s` without `-L` does: the
 * answer is the first response, and its `Location` is reported, not visited.
 * Like one curl per probe, each request opens its own connection and closes
 * it: a CI runner had a reused keep-alive connection to the apex reset
 * (ECONNRESET), which says nothing about the contract under test.
 *
 * As curl prints the status it received even when the body then stalls, a
 * status is kept once it arrives. Without `readBody` the answer is complete
 * at the headers; with it, a body that does not finish in time is the
 * answer's `error`. A timeout or a connection error before any status is an
 * answer with no status, and `error` says which.
 */
export function probe(url: string, { timeoutMs = 15_000, readBody = false } = {}): Promise<Answer> {
  const target = new URL(url)
  const send = target.protocol === 'http:' ? httpRequest : httpsRequest
  return new Promise((resolve) => {
    let head: Omit<Answer, 'body'> | undefined
    const settle = (answer: Answer) => {
      clearTimeout(timer)
      request.destroy()
      resolve(answer)
    }
    const broke = (why: string) =>
      settle(
        head
          ? { ...head, body: '', error: head.error ?? `the body did not finish${why}` }
          : { status: null, location: null, body: '', error: `no answer${why}` },
      )
    const request = send(target, { agent: false, headers: { connection: 'close', 'user-agent': 'demeter-run-e2e' } }, (response) => {
      head = { status: response.statusCode ?? null, ...locationOf(response.headers.location, url) }
      response.on('error', (error: NodeJS.ErrnoException) => broke(`: ${error.code ?? error.name} (${error.message})`))
      if (!readBody) return settle({ ...head, body: '' })
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => settle({ ...head!, body: Buffer.concat(chunks).toString('utf8') }))
    })
    const timer = setTimeout(() => broke(` within ${timeoutMs / 1000} s`), timeoutMs)
    request.on('error', (error: NodeJS.ErrnoException) => broke(`: ${error.code ?? error.name} (${error.message})`))
    request.end()
  })
}

/** An answer as a step reports it: the status and where it points, or what went wrong. */
export function describeAnswer(answer: Answer): string {
  if (answer.status === null) return answer.error ?? 'no answer'
  const where = answer.location ? ` → ${safeUrl(answer.location)}` : ''
  return `${answer.status}${where}${answer.error ? `, but ${answer.error}` : ''}`
}

/** A page's body, from a 200 whose body arrived whole; anything else fails the step reading it. */
export async function readPage(url: string, timeoutMs = 20_000): Promise<string> {
  const answer = await probe(url, { timeoutMs, readBody: true })
  if (answer.status === 200 && !answer.error) return answer.body
  throw new Error(answer.status === 200 ? describeAnswer(answer) : `${describeAnswer(answer)}, wanted 200`)
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

/**
 * An error as a step names it: its code and message, `ECONNREFUSED (connect
 * ECONNREFUSED 10.0.0.1:443)`. Only a string code counts: a timeout's
 * `DOMException` carries the legacy number 23, so it is named
 * `TimeoutError`. A connection tried on every address of a dual-stack host
 * fails with an `AggregateError` whose message is empty and whose attempts
 * say what happened, so they are its message.
 */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const { code } = error as { code?: unknown }
  const attempts = error instanceof AggregateError ? error.errors.map((e) => (e instanceof Error ? e.message : String(e))) : []
  return `${typeof code === 'string' ? code : error.name} (${error.message || attempts.join('; ')})`
}

/**
 * `fetch`, failing as `probe` does: Node's `fetch` rejects with a bare "fetch
 * failed" and keeps what went wrong (DNS, a refused connection, TLS) in its
 * `cause`, so the failure names the cause instead.
 */
export async function fetchNamingCause(url: string, init: RequestInit, send: typeof fetch = fetch): Promise<Response> {
  try {
    return await send(url, init)
  } catch (error) {
    throw new Error(describeError((error as Error).cause instanceof Error ? (error as Error).cause : error))
  }
}
