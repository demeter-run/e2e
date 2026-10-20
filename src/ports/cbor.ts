/**
 * The CBOR the node check speaks: encoding unsigned integers, booleans,
 * arrays and integer-keyed maps (the handshake and chain-sync requests), and
 * decoding whatever the node answers.
 */

export type Cbor = number | bigint | boolean | null | undefined | string | Uint8Array | Cbor[] | Map<Cbor, Cbor> | Tagged

export class Tagged {
  constructor(
    readonly tag: number,
    readonly value: Cbor,
  ) {}
}

/** The input ended inside an item: more bytes are needed, which a stream reader waits for. */
export class Incomplete extends Error {}

export function encode(value: number | boolean | Cbor[] | Map<number, Cbor>): Uint8Array {
  const out: number[] = []
  const head = (major: number, n: number) => {
    if (n < 24) out.push((major << 5) | n)
    else if (n < 0x100) out.push((major << 5) | 24, n)
    else if (n < 0x10000) out.push((major << 5) | 25, n >> 8, n & 0xff)
    else if (n < 0x100000000) out.push((major << 5) | 26, n >>> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff)
    else throw new Error(`cbor: ${n} is too large to encode`)
  }
  const item = (v: unknown) => {
    if (typeof v === 'boolean') out.push(v ? 0xf5 : 0xf4)
    else if (typeof v === 'number' && Number.isInteger(v) && v >= 0) head(0, v)
    else if (Array.isArray(v)) {
      head(4, v.length)
      for (const x of v) item(x)
    } else if (v instanceof Map) {
      head(5, v.size)
      for (const [k, x] of v) {
        item(k)
        item(x)
      }
    } else throw new Error(`cbor: cannot encode ${typeof v}`)
  }
  item(value)
  return new Uint8Array(out)
}

/** The first item in `bytes` and how many bytes it took. Throws `Incomplete` when it is cut short. */
export function decode(bytes: Uint8Array): { value: Cbor; length: number } {
  let at = 0
  const need = (n: number) => {
    if (at + n > bytes.length) throw new Incomplete('cbor: truncated')
  }
  const argument = (info: number): number | bigint => {
    if (info < 24) return info
    const size = { 24: 1, 25: 2, 26: 4, 27: 8 }[info]
    if (size === undefined) throw new Error(`cbor: unsupported additional info ${info}`)
    need(size)
    let n = 0n
    for (let i = 0; i < size; i++) n = (n << 8n) | BigInt(bytes[at++]!)
    return n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n
  }
  const length = (info: number) => {
    const n = argument(info)
    if (typeof n === 'bigint') throw new Error('cbor: length too large')
    return n
  }
  const BREAK = Symbol('break')
  const item = (): Cbor | typeof BREAK => {
    need(1)
    const initial = bytes[at++]!
    const major = initial >> 5
    const info = initial & 0x1f
    if (initial === 0xff) return BREAK
    switch (major) {
      case 0:
        return argument(info)
      case 1: {
        const n = argument(info)
        return typeof n === 'bigint' ? -1n - n : -1 - n
      }
      case 2:
      case 3: {
        let chunk: Uint8Array
        if (info === 31) {
          const parts: Uint8Array[] = []
          for (let part = item(); part !== BREAK; part = item()) parts.push(typeof part === 'string' ? new TextEncoder().encode(part) : (part as Uint8Array))
          chunk = new Uint8Array(Buffer.concat(parts))
        } else {
          const n = length(info)
          need(n)
          chunk = bytes.slice(at, at + n)
          at += n
        }
        return major === 2 ? chunk : new TextDecoder().decode(chunk)
      }
      case 4: {
        const list: Cbor[] = []
        if (info === 31) for (let x = item(); x !== BREAK; x = item()) list.push(x)
        else for (let n = length(info); n > 0; n--) list.push(value())
        return list
      }
      case 5: {
        const map = new Map<Cbor, Cbor>()
        if (info === 31) for (let k = item(); k !== BREAK; k = item()) map.set(k, value())
        else for (let n = length(info); n > 0; n--) map.set(value(), value())
        return map
      }
      case 6:
        return new Tagged(length(info), value())
      default: {
        if (info === 20) return false
        if (info === 21) return true
        if (info === 22) return null
        if (info === 23) return undefined
        if (info === 26 || info === 27) {
          const size = info === 26 ? 4 : 8
          need(size)
          const view = new DataView(bytes.buffer, bytes.byteOffset + at, size)
          at += size
          return size === 4 ? view.getFloat32(0) : view.getFloat64(0)
        }
        if (info < 24) return info
        throw new Error(`cbor: unsupported simple value ${info}`)
      }
    }
  }
  const value = (): Cbor => {
    const v = item()
    if (v === BREAK) throw new Error('cbor: unexpected break')
    return v
  }
  const result = value()
  return { value: result, length: at }
}
