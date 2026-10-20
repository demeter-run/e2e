import { connect } from 'node:tls'
import type { Duplex } from 'node:stream'
import { describeError } from '../http.ts'
import { type Cbor, decode, encode, Incomplete } from './cbor.ts'

/**
 * A node port's tip, read over the node-to-client protocol as fabric's script
 * read it with `socat` and `cardano-cli query tip`: the port is the node's
 * socket behind TLS on `<key>.cnode-m1.demeter.run:9443`.
 *
 * One connection: the mux, a handshake proposing node-to-client v16–v20
 * (cardano-node 10.x), then chain-sync's `MsgFindIntersect` with no points,
 * which the node answers with `MsgIntersectNotFound` and its tip.
 */

/** Mainnet's era boundary, for turning a slot into a time. */
export const mainnet = {
  magic: 764824073,
  /** Byron's start, unix seconds; Byron slots last 20 s. */
  systemStart: 1506203091,
  /** Shelley's first slot and its time; Shelley slots last 1 s. */
  shelleySlot: 4492800,
  shelleyStart: 1596059091,
}

const handshake = 0
const chainSync = 5
const versions = [16, 17, 18, 19, 20].map((v) => 0x8000 | v)

export interface Tip {
  slot: number
  block: number
}

export function slotTime(slot: number): number {
  return slot >= mainnet.shelleySlot ? mainnet.shelleyStart + (slot - mainnet.shelleySlot) : mainnet.systemStart + slot * 20
}

/**
 * `cardano-cli query tip`'s `syncProgress`, as cardano-cli 10.1.1.0's
 * `percentage` computes it: the tip's and now's whole seconds since the
 * system start, each plus one; the tip's moved 600 s forward, but not past
 * now's; their ratio as a percentage, printed `%.2f`. So a tip within 600 s
 * of now is 100.
 */
export function syncProgress(slot: number, now = Date.now() / 1000): number {
  const sa = Math.floor(slotTime(slot) - mainnet.systemStart) + 1
  const sb = Math.floor(now - mainnet.systemStart) + 1
  return twoDecimals((Math.min(sa + 600, sb) / sb) * 100)
}

/**
 * `printf "%.2f"` of a positive Double, as GHC renders it: its shortest
 * decimal digits, rounded at the second decimal, half to even.
 */
export function twoDecimals(x: number): number {
  const [whole = '0', fraction = ''] = String(x).split('.')
  const cents = Number(whole) * 100 + Number(fraction.slice(0, 2).padEnd(2, '0'))
  const [next = '0', ...rest] = fraction.slice(2)
  const half = next === '5' && rest.every((d) => d === '0')
  const up = next > '5' || (next === '5' && !half) || (half && cents % 2 === 1)
  return (cents + (up ? 1 : 0)) / 100
}

/** One SDU from the initiator: timestamp, mini-protocol (mode bit clear), length, payload. */
function sdu(protocol: number, payload: Uint8Array): Buffer {
  const header = Buffer.alloc(8)
  header.writeUInt32BE(Number(process.hrtime.bigint() / 1000n) >>> 0, 0)
  header.writeUInt16BE(protocol, 4)
  header.writeUInt16BE(payload.length, 6)
  return Buffer.concat([header, payload])
}

export function queryTip(
  address: string,
  { magic = mainnet.magic, timeoutMs = 15_000, open }: { magic?: number; timeoutMs?: number; open?: () => Duplex } = {},
): Promise<Tip> {
  const [host = '', port = '9443'] = address.split(':')
  const socket = open ? open() : connect({ host, port: Number(port), servername: host })
  return new Promise((resolve, reject) => {
    const settle = (fn: () => void) => {
      clearTimeout(timer)
      socket.destroy()
      fn()
    }
    const fail = (why: string) => settle(() => reject(new Error(why)))
    const timer = setTimeout(() => fail(`no tip within ${timeoutMs / 1000} s`), timeoutMs)

    let incoming = Buffer.alloc(0)
    const pending = new Map<number, Buffer>()
    socket.on('data', (chunk: Buffer) => {
      incoming = Buffer.concat([incoming, chunk])
      while (incoming.length >= 8) {
        const length = incoming.readUInt16BE(6)
        if (incoming.length < 8 + length) break
        const protocol = incoming.readUInt16BE(4) & 0x7fff
        let buffer = Buffer.concat([pending.get(protocol) ?? Buffer.alloc(0), incoming.subarray(8, 8 + length)])
        incoming = incoming.subarray(8 + length)
        while (buffer.length > 0) {
          let message: { value: Cbor; length: number }
          try {
            message = decode(buffer)
          } catch (error) {
            if (error instanceof Incomplete) break
            return fail(`the node sent malformed CBOR: ${(error as Error).message}`)
          }
          buffer = buffer.subarray(message.length)
          receive(protocol, message.value)
        }
        pending.set(protocol, buffer)
      }
    })
    socket.on('error', (error) => fail(describeError(error)))
    socket.on('close', () => fail('the connection closed before the node sent its tip'))

    const receive = (protocol: number, message: Cbor) => {
      if (!Array.isArray(message)) return fail(`unexpected message on mini-protocol ${protocol}`)
      const [tag] = message
      if (protocol === handshake) {
        if (tag === 1) return void socket.write(sdu(chainSync, encode([4, []])))
        if (tag === 2) return fail(`the node refused the handshake: ${JSON.stringify(message[1], replacer)}`)
        return fail(`unexpected handshake message ${String(tag)}`)
      }
      if (protocol === chainSync) {
        // MsgIntersectNotFound [6, tip] or MsgIntersectFound [5, point, tip].
        const tip = tag === 6 ? message[1] : tag === 5 ? message[2] : undefined
        if (!Array.isArray(tip) || !Array.isArray(tip[0])) return fail(`unexpected chain-sync message ${String(tag)}`)
        const [slot] = tip[0]
        const block = tip[1]
        if (tip[0].length === 0) return fail('the node is at genesis: its tip is the origin')
        if (typeof slot !== 'number' || typeof block !== 'number') return fail('the tip is not a slot and block number')
        return settle(() => resolve({ slot, block }))
      }
    }

    const proposal = new Map(versions.map((v) => [v, [magic, false] as Cbor]))
    socket.write(sdu(handshake, encode([0, proposal])))
  })
}

function replacer(_key: string, value: unknown) {
  return typeof value === 'bigint' ? String(value) : value instanceof Map ? Object.fromEntries(value) : value
}
