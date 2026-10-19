import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

/**
 * One tier of one port's price, as one surface states it, in the units every
 * surface can be compared in.
 *
 * `per_100k_usd` is USD per 100,000 of the port's metered unit: requests,
 * messages, submits, or seconds of open connection, whichever the port bills.
 * A null field is a price the surface does not state. On fabric both are null
 * together, for a tier whose CRD entry has no `cost` block: fabric bills it
 * nothing.
 */
export interface Card {
  port: string
  tier: string
  minimum_usd: number | null
  per_100k_usd: number | null
}

/** `$0.30`, `$1,000` or `$50` as a number; `—` (not published) as null. */
export function parseUsd(text: string): number | null {
  const s = text.trim()
  if (['', '—', '–', '-'].includes(s)) return null
  const match = /^\$\s?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?$/.exec(s)
  if (!match) throw new Error(`cannot read "${text}" as a price`)
  return Number(`${match[1]!.replaceAll(',', '')}${match[2] ?? ''}`)
}

/** A price as a person reads it: `$0.30`, `$150`, `$1.3889`. */
export function formatUsd(n: number | null): string {
  if (n === null) return '—'
  const rounded = Math.round(n * 10_000) / 10_000
  if (Number.isInteger(rounded)) return `$${rounded}`
  const trimmed = rounded.toFixed(4).replace(/0+$/, '')
  return `$${trimmed.split('.')[1]!.length < 2 ? rounded.toFixed(2) : trimmed}`
}

/**
 * Imports a TypeScript module from another repository's tree. These files use
 * extensionless imports and bundler resolution, which plain `node` cannot
 * load; the checks run under `tsx`, which compiles them on import.
 */
export async function importModule<T>(path: string): Promise<T> {
  if (!existsSync(path)) throw new Error(`${path}: not found`)
  return (await import(pathToFileURL(path).href)) as T
}
