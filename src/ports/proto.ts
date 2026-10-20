/**
 * The little protobuf the port suite needs, by hand: fabric's project and
 * resource messages are strings and repeated sub-messages, and UTxO RPC's
 * `ReadParamsResponse` is read for one varint. Field numbers are recorded
 * where each message is built or read.
 */

/** One field of a message as it arrived: a varint's value, or a length-delimited field's bytes. */
export type Field = { number: number; varint: number } | { number: number; bytes: Uint8Array }

/** A message of string fields, keyed by field number; empty strings are omitted, as proto3 does. */
export function encodeStrings(fields: Record<number, string>): Uint8Array {
  const out: number[] = []
  for (const [number, value] of Object.entries(fields)) {
    if (value === '') continue
    const bytes = new TextEncoder().encode(value)
    writeVarint(out, Number(number) * 8 + 2)
    writeVarint(out, bytes.length)
    out.push(...bytes)
  }
  return new Uint8Array(out)
}

/** A message of varint fields, keyed by field number. */
export function encodeVarints(fields: Record<number, number>): Uint8Array {
  const out: number[] = []
  for (const [number, value] of Object.entries(fields)) {
    writeVarint(out, Number(number) * 8)
    writeVarint(out, value)
  }
  return new Uint8Array(out)
}

function writeVarint(out: number[], value: number) {
  while (value >= 0x80) {
    out.push((value % 0x80) | 0x80)
    value = Math.floor(value / 0x80)
  }
  out.push(value)
}

/** Every varint and length-delimited field of one message; fixed-width fields are skipped. */
export function decode(message: Uint8Array): Field[] {
  const out: Field[] = []
  let at = 0
  const varint = (): number => {
    let value = 0
    for (let shift = 0; ; shift += 7) {
      if (at >= message.length || shift > 49) throw new Error('malformed protobuf')
      const byte = message[at++]!
      value += (byte & 0x7f) * 2 ** shift
      if (byte < 0x80) return value
    }
  }
  while (at < message.length) {
    const key = varint()
    const number = Math.floor(key / 8)
    const wire = key % 8
    if (wire === 0) out.push({ number, varint: varint() })
    else if (wire === 1) at += 8
    else if (wire === 5) at += 4
    else if (wire === 2) {
      const length = varint()
      if (at + length > message.length) throw new Error('malformed protobuf')
      out.push({ number, bytes: message.subarray(at, at + length) })
      at += length
    } else throw new Error(`unsupported protobuf wire type ${wire}`)
  }
  return out
}

/** The bytes of every length-delimited field `number`, in order. */
export function messages(message: Uint8Array, number: number): Uint8Array[] {
  return decode(message).flatMap((f) => (f.number === number && 'bytes' in f ? [f.bytes] : []))
}

/** The last string field `number`, or '' when absent, as proto3 reads it. */
export function string(message: Uint8Array, number: number): string {
  const found = messages(message, number).at(-1)
  return found ? new TextDecoder('utf-8', { fatal: true }).decode(found) : ''
}

/** The last varint field `number`, or null when absent. */
export function varint(message: Uint8Array, number: number): number | null {
  const found = decode(message).filter((f) => f.number === number && 'varint' in f).at(-1)
  return found && 'varint' in found ? found.varint : null
}
