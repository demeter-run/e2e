import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { createServer, type RequestListener } from 'node:http'
import { createServer as createH2cServer, type Http2ServerRequest, type Http2ServerResponse } from 'node:http2'
import { type AddressInfo, createServer as createNetServer } from 'node:net'
import { join } from 'node:path'
import type { Card } from '../src/surfaces/card.ts'

/** A local server for one test: its base URL, how many connections it has accepted, and `close` to stop it. */
export interface Served {
  url: string
  readonly connections: number
  close(): Promise<void>
}

async function listen(server: ReturnType<typeof createServer> | ReturnType<typeof createH2cServer>): Promise<Served> {
  let connections = 0
  server.on('connection', () => (connections += 1))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    get connections() {
      return connections
    },
    close: () =>
      new Promise((resolve) => {
        if ('closeAllConnections' in server) server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

/** An HTTP/1.1 server on a free local port. */
export const serve = (handler: RequestListener): Promise<Served> => listen(createServer(handler))

/** A cleartext HTTP/2 server on a free local port, as fabric's API speaks only HTTP/2. */
export const serveH2c = (handler: (request: Http2ServerRequest, response: Http2ServerResponse) => void): Promise<Served> =>
  listen(createH2cServer(handler))

/** A local URL nothing listens on: a port that was free a moment ago. */
export async function refusedUrl(): Promise<string> {
  const server = createNetServer().listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as AddressInfo
  await new Promise((resolve) => server.close(resolve))
  return `http://127.0.0.1:${port}`
}

/**
 * Runs `fn` with the environment variables in `vars` set, or unset where the
 * value is undefined, and puts them back after. In CI the real ones would send
 * an alert or write into the job's own summary.
 */
export async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T | Promise<T>): Promise<T> {
  const set = (values: Record<string, string | undefined>) => {
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
  const saved = Object.fromEntries(Object.keys(vars).map((name) => [name, process.env[name]]))
  set(vars)
  try {
    return await fn()
  } finally {
    set(saved)
  }
}

/** A fixture captured from production (sources in `fixtures/README.md`). */
export const live = (name: string): Buffer => readFileSync(join(import.meta.dirname, 'fixtures', 'live', name))

const { sources: _sources, ...cards } = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures', 'cards', 'pre-rate-card.json'), 'utf8'),
) as { sources: Record<string, string> } & Record<'fabric' | 'website2' | 'website2 landing', Card[]>

/** The normalised cards from before the rate-card rollout, by surface; the file's `sources` names their commits. */
export const preRateCard = cards

/**
 * Replaces the first `from` after the first `anchor`; fails when there is
 * nothing to replace, so a fixture refresh that moves the text breaks the test
 * instead of silently testing nothing.
 */
export function edit(text: string, from: string, to: string, anchor = ''): string {
  const start = text.indexOf(anchor)
  const at = start < 0 ? -1 : text.indexOf(from, start)
  if (at < 0) throw new Error(`"${from}"${anchor ? ` after "${anchor}"` : ''} not found`)
  return text.slice(0, at) + to + text.slice(at + from.length)
}

const varint = (n: number): number[] => {
  const out: number[] = []
  while (n >= 0x80) {
    out.push((n % 0x80) | 0x80)
    n = Math.floor(n / 0x80)
  }
  out.push(n)
  return out
}

const field = (number: number, bytes: Uint8Array): number[] => [...varint(number * 8 + 2), ...varint(bytes.length), ...bytes]

const frame = (flags: number, payload: Uint8Array): number[] => {
  const length = new Uint8Array(4)
  new DataView(length.buffer).setUint32(0, payload.length)
  return [flags, ...length, ...payload]
}

/**
 * A gRPC-web FetchMetadata response body. Each record's `extra` maps a field
 * number to a string, which is how a test serves a plan in field 3.
 */
export function fetchMetadataBody(
  records: { kind: string; extra?: Record<number, string> }[],
  trailer = 'grpc-status:0\r\n',
): Uint8Array {
  const text = new TextEncoder()
  const message = records.flatMap(({ kind, extra = {} }) => {
    const record = [
      ...field(1, text.encode('[]')),
      ...field(2, text.encode(JSON.stringify({ spec: { names: { kind } } }))),
      ...Object.entries(extra).flatMap(([n, s]) => field(Number(n), text.encode(s))),
    ]
    return field(1, Uint8Array.from(record))
  })
  return Uint8Array.from([...frame(0, Uint8Array.from(message)), ...frame(0x80, text.encode(trailer))])
}
