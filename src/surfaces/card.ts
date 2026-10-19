import { cardPorts, portName, tierName } from './ports.ts'

/**
 * One tier of one port's price, as one surface states it, in the units every
 * surface can be compared in.
 *
 * `per_100k_usd` is USD per 100,000 of the port's metered unit: requests,
 * messages, submits, or seconds of open connection, whichever the port bills.
 * A null field is a price the surface does not state. On fabric both are null
 * together, for a tier whose plan has no `cost` block: fabric bills it
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
 * fabric stores a rate to four significant digits (`0.000013889` for $1.20 a
 * day), so two prices are the same within 0.1%. The divergences this check
 * exists for are whole multiples.
 */
const same = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-9 + 0.001 * Math.max(Math.abs(a), Math.abs(b))

const charges = (c: Card): boolean => (c.minimum_usd ?? 0) > 0 || (c.per_100k_usd ?? 0) > 0

const label = (port: string, tier: string): string => `${portName(port)} ${tierName(tier)}`

const key = (c: { port: string; tier: string }): string => `${c.port}\u0000${c.tier}`

/**
 * Every divergence between fabric's card (what is billed) and the quoting
 * surfaces, named by surface (`website2`, `website2 landing`, and in J2 the
 * Console), one line each, naming the port, the tier and each surface's value:
 *
 * - a surface charging for a port and tier fabric bills nothing for (no `cost`
 *   block, no such tier or no such port): the UTxO RPC incident, quoted and
 *   never billed;
 * - a port a surface must price, on tiers 1–3, that it does not price, or
 *   prices with no minimum fee. A surface owes the card ports (Ogmios, Kupo,
 *   Blockfrost, UTxO RPC) unless `owes` names its ports: J2's Console leg
 *   reads one resource's pricing page, so it owes that resource's port only;
 * - a minimum fee or usage rate that differs between any two that state it;
 * - a port and tier one surface states more than once (`Blockfrost` and
 *   `Blockfrost RYO` on one page, say): the rest compares its last statement
 *   only, so the others would pass unread.
 *
 * With `billed` null (fabric's card could not be read) the quoting surfaces are
 * compared with each other only.
 */
export function compare(
  billed: Card[] | null,
  quotes: Record<string, Card[]>,
  { owes = {} }: { owes?: Record<string, string[]> } = {},
): string[] {
  const fabric = new Map((billed ?? []).map((c) => [key(c), c]))
  const fabricPorts = new Set((billed ?? []).map((c) => c.port))
  const surfaces = Object.entries(quotes).map(([name, cards]) => [name, new Map(cards.map((c) => [key(c), c]))] as const)
  const lines: { order: string; line: string }[] = []
  const add = (port: string, tier: string, field: string, line: string) => lines.push({ order: `${port} ${tier} ${field}`, line })

  for (const [surface, cards] of [['fabric', billed ?? []] as const, ...Object.entries(quotes)]) {
    const stated = new Map<string, Card[]>()
    for (const c of cards) stated.set(key(c), [...(stated.get(key(c)) ?? []), c])
    for (const same of stated.values()) {
      if (same.length === 1) continue
      const { port, tier } = same[0]!
      const prices = same.map((c) => `${formatUsd(c.minimum_usd)} minimum and ${formatUsd(c.per_100k_usd)} per 100k`)
      add(port, tier, `0 ${surface}`, `${label(port, tier)}: ${surface} states it ${same.length} times, ${prices.join(' · ')}`)
    }
  }

  const keys = new Set<string>()
  for (const [, cards] of surfaces) for (const k of cards.keys()) keys.add(k)

  if (billed) {
    for (const k of keys) {
      const [port, tier] = k.split('\u0000') as [string, string]
      const card = fabric.get(k)
      if (card && card.minimum_usd !== null) continue
      for (const [surface, cards] of surfaces) {
        const quote = cards.get(k)
        if (!quote || !charges(quote)) continue
        const why = !fabricPorts.has(port) ? 'fabric has no such port' : !card ? 'fabric has no such tier' : 'fabric bills nothing (no cost block)'
        add(port, tier, `0 ${surface}`, `${label(port, tier)}: ${surface} charges ${formatUsd(quote.minimum_usd)} minimum and ${formatUsd(quote.per_100k_usd)} per 100k; ${why}`)
      }
    }
  }

  for (const [surface, cards] of surfaces) {
    for (const port of owes[surface] ?? cardPorts) {
      for (const tier of ['1', '2', '3']) {
        const quote = cards.get(key({ port, tier }))
        if (!quote || quote.per_100k_usd === null) add(port, tier, `1 ${surface}`, `${label(port, tier)}: ${surface} publishes no price`)
        else if (quote.minimum_usd === null) add(port, tier, `1 ${surface}`, `${label(port, tier)}: ${surface} publishes no minimum fee`)
      }
    }
  }

  for (const k of keys) {
    const [port, tier] = k.split('\u0000') as [string, string]
    for (const [field, name] of [['minimum_usd', 'minimum'], ['per_100k_usd', 'per 100k']] as const) {
      const values: [string, number][] = []
      const fromFabric = fabric.get(k)?.[field]
      if (fromFabric !== undefined && fromFabric !== null) values.push(['fabric', fromFabric])
      for (const [surface, cards] of surfaces) {
        const v = cards.get(k)?.[field]
        if (v !== undefined && v !== null) values.push([surface, v])
      }
      if (values.every(([, v]) => same(v, values[0]![1]))) continue
      add(port, tier, `2 ${name}`, `${label(port, tier)} ${name}: ${values.map(([s, v]) => `${s} ${formatUsd(v)}`).join(' · ')}`)
    }
  }

  return lines.sort((a, b) => a.order.localeCompare(b.order)).map((l) => l.line)
}
