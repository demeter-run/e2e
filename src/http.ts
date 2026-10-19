import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

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
 * One GET that never follows a redirect, as `curl -s` without `-L` does: the
 * answer is the first response, and its `Location` is reported, not visited.
 * Like one curl per probe, each request opens its own connection and closes
 * it: a CI runner had a reused keep-alive connection to the apex reset
 * (ECONNRESET), which says nothing about the contract under test. A timeout
 * or a connection error is an answer with no status, and `error` says which.
 */
export function probe(url: string, { timeoutMs = 15_000, readBody = false } = {}): Promise<Answer> {
  const target = new URL(url)
  const send = target.protocol === 'http:' ? httpRequest : httpsRequest
  return new Promise((resolve) => {
    const nothing = (error: string) => resolve({ status: null, location: null, body: '', error })
    const request = send(target, { agent: false, headers: { connection: 'close', 'user-agent': 'demeter-run-e2e' } }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => readBody && chunks.push(chunk))
      response.on('error', (error: NodeJS.ErrnoException) => nothing(`no answer: ${error.code ?? error.name} (${error.message})`))
      response.on('end', () => {
        clearTimeout(timer)
        const location = response.headers.location
        resolve({
          status: response.statusCode ?? null,
          location: location === undefined ? null : new URL(location, url).toString(),
          body: Buffer.concat(chunks).toString('utf8'),
        })
      })
    })
    const timer = setTimeout(() => {
      request.destroy()
      nothing(`no answer within ${timeoutMs / 1000} s`)
    }, timeoutMs)
    request.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      nothing(`no answer: ${error.code ?? error.name} (${error.message})`)
    })
    request.end()
  })
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
