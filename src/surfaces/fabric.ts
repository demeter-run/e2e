import { connect } from 'node:http2'
import type { Card } from './card.ts'
import { fabricKinds } from './ports.ts'

/**
 * fabric's port catalog as it serves it: `MetadataService/FetchMetadata` on
 * its gRPC-web API, with no auth interceptor (`src/drivers/grpc/mod.rs` in
 * fabric). The proto is `demeter.ops.v1alpha.Metadata` in fabric's specs:
 * `options` (1) and `crd` (2), each a JSON string.
 *
 * Read from a live response on 2026-10-19 (`test/fixtures/live/`): those two
 * fields are all a record carries. The per-tier `plan.<tier>.{dns, cost}`
 * fabric bills from (`ResourceMetadataPlan`, `src/domain/metadata/mod.rs`) is
 * not serialised, so production does not say what it bills. This reader takes
 * the plan from field 3, a JSON string of that same map, when fabric serves
 * it, and says so plainly when it does not.
 */
export const fetchMetadataPath = '/demeter.ops.v1alpha.MetadataService/FetchMetadata'

/** The field fabric's plan is read from, once fabric serves it. */
export const planField = 3

export interface FabricPlan {
  dns?: string
  cost?: { minimum: number; delta: number } | null
}

export interface MetadataRecord {
  /** The CRD's kind, e.g. `BlockfrostPort`. */
  kind: string
  /** `plan`, keyed by throughput tier; null when the record carries none. */
  plan: Record<string, FabricPlan> | null
}

/** One tier of one port kind. `cost` null: fabric bills it nothing. */
export interface FabricTier {
  port: string
  kind: string
  tier: string
  cost: { minimum: number; delta: number } | null
}

export async function fetchMetadata(rpc: string, { timeoutMs = 15_000 } = {}): Promise<MetadataRecord[]> {
  const response = await postHttp2(`${rpc}${fetchMetadataPath}`, {
    headers: { 'content-type': 'application/grpc-web+proto', 'x-grpc-web': '1' },
    // One uncompressed frame holding the empty FetchMetadataRequest.
    body: new Uint8Array(5),
    timeoutMs,
  })
  if (response.status !== 200) throw new Error(`FetchMetadata answered HTTP ${response.status}`)
  const headerStatus = response.headers['grpc-status']
  if (headerStatus !== undefined && headerStatus !== '0') {
    throw new Error(`FetchMetadata failed: grpc-status ${headerStatus} ${response.headers['grpc-message'] ?? ''}`.trim())
  }
  return decodeFetchMetadata(response.body)
}

/**
 * One POST over HTTP/2. fabric's API refuses HTTP/1.1 at the TLS handshake
 * (it offers only `h2`), and Node 22's `fetch` speaks HTTP/1.1 only, so this
 * call does not go through `probe`. It reports a failure as `probe` does: a
 * status is kept once it arrives, so a body that stalls or breaks after it is
 * not "no answer".
 */
function postHttp2(
  url: string,
  { headers, body, timeoutMs }: { headers: Record<string, string>; body: Uint8Array; timeoutMs: number },
): Promise<{ status: number; headers: Record<string, string>; body: Uint8Array }> {
  const { origin, pathname } = new URL(url)
  return new Promise((resolve, reject) => {
    let status = 0
    const session = connect(origin)
    const broke = (why: string) => {
      clearTimeout(timer)
      session.destroy()
      reject(new Error(`FetchMetadata: ${status ? `answered HTTP ${status}, but the body did not finish` : 'no answer'}${why}`))
    }
    const timer = setTimeout(() => broke(` within ${timeoutMs / 1000} s`), timeoutMs)
    // A refused connection reaches the request first, as a cancelled stream
    // whose cause is the refusal: the cause is what went wrong.
    const failed = (error: Error) => {
      const root = (error.cause instanceof Error ? error.cause : error) as Error & { code?: string }
      broke(`: ${root.code ?? root.name} (${root.message})`)
    }
    session.on('error', failed)
    const request = session.request({ ':method': 'POST', ':path': pathname, ...headers })
    request.on('error', failed)
    const answered: Record<string, string> = {}
    request.on('response', (h) => {
      status = Number(h[':status'])
      for (const [name, value] of Object.entries(h)) if (typeof value === 'string') answered[name] = value
    })
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      clearTimeout(timer)
      session.close()
      resolve({ status, headers: answered, body: new Uint8Array(Buffer.concat(chunks)) })
    })
    request.end(body)
  })
}

/** A gRPC-web response body: its message frames, then the trailer frame. */
export function decodeFetchMetadata(body: Uint8Array): MetadataRecord[] {
  const messages: Uint8Array[] = []
  const trailers = new Map<string, string>()
  let at = 0
  while (at < body.length) {
    if (at + 5 > body.length) throw new Error('FetchMetadata: truncated gRPC-web frame')
    const flags = body[at]!
    const length = new DataView(body.buffer, body.byteOffset + at + 1, 4).getUint32(0)
    const payload = body.subarray(at + 5, at + 5 + length)
    if (payload.length !== length) throw new Error('FetchMetadata: truncated gRPC-web frame')
    if (flags & 0x80) {
      for (const line of new TextDecoder().decode(payload).split('\r\n')) {
        const colon = line.indexOf(':')
        if (colon > 0) trailers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim())
      }
    } else {
      if (flags & 0x01) throw new Error('FetchMetadata: compressed frames are not supported')
      messages.push(payload)
    }
    at += 5 + length
  }
  const status = trailers.get('grpc-status')
  if (status !== '0') throw new Error(`FetchMetadata failed: grpc-status ${status ?? '(none)'} ${trailers.get('grpc-message') ?? ''}`.trim())
  if (messages.length !== 1) throw new Error(`FetchMetadata: ${messages.length} messages, wanted 1`)

  const text = new TextDecoder('utf-8', { fatal: true })
  return fields(messages[0]!)
    .filter((f) => f.number === 1)
    .map(({ bytes }) => {
      const strings = new Map(fields(bytes).map((f) => [f.number, text.decode(f.bytes)]))
      const crd = JSON.parse(strings.get(2) ?? 'null') as { spec?: { names?: { kind?: unknown } } } | null
      const kind = crd?.spec?.names?.kind
      if (typeof kind !== 'string') throw new Error('FetchMetadata: a record whose crd names no kind')
      const plan = strings.get(planField)
      return { kind, plan: plan === undefined ? null : (JSON.parse(plan) as Record<string, FabricPlan>) }
    })
}

/** The length-delimited fields of one protobuf message; other wire types are skipped. */
function fields(message: Uint8Array): { number: number; bytes: Uint8Array }[] {
  const out: { number: number; bytes: Uint8Array }[] = []
  let at = 0
  const varint = (): number => {
    let value = 0
    for (let shift = 0; ; shift += 7) {
      if (at >= message.length || shift > 49) throw new Error('FetchMetadata: malformed protobuf')
      const byte = message[at++]!
      value += (byte & 0x7f) * 2 ** shift
      if (byte < 0x80) return value
    }
  }
  while (at < message.length) {
    const key = varint()
    const wire = key % 8
    if (wire === 0) varint()
    else if (wire === 1) at += 8
    else if (wire === 5) at += 4
    else if (wire === 2) {
      const length = varint()
      if (at + length > message.length) throw new Error('FetchMetadata: malformed protobuf')
      out.push({ number: Math.floor(key / 8), bytes: message.subarray(at, at + length) })
      at += length
    } else throw new Error(`FetchMetadata: unsupported wire type ${wire}`)
  }
  return out
}

/**
 * Every tier of every kind that publishes its plan. When no record carries a
 * plan, fabric's prices cannot be read at all, and that is the error.
 */
export function fabricTiers(records: MetadataRecord[]): FabricTier[] {
  if (records.length === 0) throw new Error('FetchMetadata returned no kinds')
  if (records.every((r) => r.plan === null)) {
    throw new Error(
      `fabric's live metadata publishes no prices: none of its ${records.length} FetchMetadata records carries a plan, only options and crd`,
    )
  }
  const tiers: FabricTier[] = []
  for (const { kind, plan } of records) {
    for (const [tier, entry] of Object.entries(plan ?? {})) {
      let cost: FabricTier['cost'] = null
      if (entry.cost) {
        const { minimum, delta } = entry.cost
        if (typeof minimum !== 'number' || typeof delta !== 'number') throw new Error(`${kind}: plan.${tier}.cost needs numeric minimum and delta`)
        cost = { minimum, delta }
      }
      tiers.push({ port: fabricKinds[kind] ?? kind.toLowerCase(), kind, tier, cost })
    }
  }
  return tiers
}

/** fabric's price, which is what it bills: `delta` per unit is `delta × 100000` per 100k. */
export function fabricCards(tiers: FabricTier[]): Card[] {
  return tiers.map(({ port, tier, cost }) => ({
    port,
    tier,
    minimum_usd: cost ? cost.minimum : null,
    per_100k_usd: cost ? cost.delta * 100_000 : null,
  }))
}
