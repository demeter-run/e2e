import { type Card, formatUsd } from '../surfaces/card.ts'
import { consoleCards, loadConsolePricing } from '../surfaces/console.ts'
import { fabricCards, readFabricTiers } from '../surfaces/fabric.ts'
import { cardPorts, portName, tierName } from '../surfaces/ports.ts'
import { landingCards, loadPlanTiers, loadPortPricing, portPricingCards } from '../surfaces/website2.ts'
import type { Check } from './check.ts'

/**
 * Three surfaces state the same price: fabric's CRD metadata (what is billed),
 * the Console's price list (what a customer confirms before enabling a port),
 * and website2's `/pricing` table and landing cards (what a visitor reads).
 * On 2026-07-31 they disagreed by 4.7× on Blockfrost, and UTxO RPC was quoted
 * on website2 while fabric billed it nothing (the rate-card rollout:
 * fabric#272, webui#137, website2#10).
 */

export interface Quotes {
  fabric: Card[]
  console: Card[]
  website2: Card[]
  landing: Card[]
}

type Surface = 'console' | 'website2' | 'website2 landing'

/**
 * fabric stores a rate to four significant digits (`0.000013889` for $1.20 a
 * day), so two prices are the same within 0.1%. The divergences this check
 * exists for are whole multiples.
 */
const same = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-9 + 0.001 * Math.max(Math.abs(a), Math.abs(b))

const charges = (c: Card): boolean => (c.minimum_usd ?? 0) > 0 || (c.per_100k_usd ?? 0) > 0

const label = (port: string, tier: string): string => `${portName(port)} ${tierName(tier)}`

/**
 * Every divergence between the surfaces, one line each, naming the port, the
 * tier and each surface's value:
 *
 * - a surface charging for a port and tier fabric bills nothing for (no `cost`
 *   block, or no such port);
 * - a card port (Ogmios, Kupo, Blockfrost, UTxO RPC) on tiers 1–3 that a
 *   surface does not price;
 * - a minimum fee or usage rate that differs between any two surfaces that
 *   state it.
 */
export function compare(quotes: Quotes): string[] {
  const key = (c: { port: string; tier: string }) => `${c.port}\u0000${c.tier}`
  const fabric = new Map(quotes.fabric.map((c) => [key(c), c]))
  const fabricPorts = new Set(quotes.fabric.map((c) => c.port))
  const surfaces: [Surface, Map<string, Card>][] = [
    ['console', new Map(quotes.console.map((c) => [key(c), c]))],
    ['website2', new Map(quotes.website2.map((c) => [key(c), c]))],
    ['website2 landing', new Map(quotes.landing.map((c) => [key(c), c]))],
  ]
  const lines: { order: string; line: string }[] = []
  const add = (port: string, tier: string, field: string, line: string) =>
    lines.push({ order: `${port} ${tier} ${field}`, line })

  const keys = new Set<string>()
  for (const [, cards] of surfaces) for (const k of cards.keys()) keys.add(k)

  for (const k of keys) {
    const [port, tier] = k.split('\u0000') as [string, string]
    const billed = fabric.get(k)
    const billedNothing = !billed || billed.minimum_usd === null
    for (const [surface, cards] of surfaces) {
      const quote = cards.get(k)
      if (!quote || !charges(quote) || !billedNothing) continue
      const why = !fabricPorts.has(port) ? 'fabric has no such port' : !billed ? 'fabric has no such tier' : 'fabric bills nothing (no cost block)'
      add(port, tier, `0 ${surface}`, `${label(port, tier)}: ${surface} charges ${formatUsd(quote.minimum_usd)} minimum and ${formatUsd(quote.per_100k_usd)} per 100k; ${why}`)
    }
  }

  for (const port of cardPorts) {
    for (const tier of ['1', '2', '3']) {
      for (const [surface, cards] of surfaces) {
        const quote = cards.get(key({ port, tier }))
        if (!quote || quote.per_100k_usd === null) add(port, tier, `1 ${surface}`, `${label(port, tier)}: ${surface} publishes no price`)
      }
    }
  }

  for (const k of keys) {
    const [port, tier] = k.split('\u0000') as [string, string]
    for (const [field, name] of [['minimum_usd', 'minimum'], ['per_100k_usd', 'per 100k']] as const) {
      const values: [string, number][] = []
      const billed = fabric.get(k)?.[field]
      if (billed !== undefined && billed !== null) values.push(['fabric', billed])
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

export const pricing: Check = {
  name: 'pricing',
  summary: "fabric's CRD prices, the Console's price list and website2's pricing content agree",
  mode: 'static',
  async run({ sources, run }) {
    const quotes: Partial<Quotes> = {}

    await run.step('read fabric', async () => {
      quotes.fabric = fabricCards(await readFabricTiers(await sources.dir('fabric')))
      const priced = new Set(quotes.fabric.filter((c) => c.minimum_usd !== null).map((c) => c.port))
      return `${await sources.describe('fabric')}: ${priced.size} priced kinds (${[...priced].sort().join(', ')})`
    })

    await run.step('read the Console', async () => {
      quotes.console = consoleCards(await loadConsolePricing(await sources.dir('webui')))
      const ports = new Set(quotes.console.map((c) => c.port))
      return `${await sources.describe('webui')}: ${ports.size} ports (${[...ports].sort().join(', ')})`
    })

    await run.step('read website2', async () => {
      const dir = await sources.dir('website2')
      quotes.website2 = portPricingCards(await loadPortPricing(dir))
      const ports = [...new Set(quotes.website2.map((c) => c.port))]
      quotes.landing = landingCards(await loadPlanTiers(dir), ports)
      return `${await sources.describe('website2')}: ${ports.length} ports (${ports.sort().join(', ')}) and ${quotes.landing.length / Math.max(ports.length, 1)} landing cards`
    })

    await run.step('compare', () => {
      const { fabric, console, website2, landing } = quotes
      if (!fabric || !console || !website2 || !landing) throw new Error('not compared: a surface could not be read')
      const divergences = compare({ fabric, console, website2, landing })
      if (divergences.length > 0) throw new Error(`${divergences.length} divergences:\n${divergences.join('\n')}`)
      return 'every surface agrees with fabric'
    })
  },
}
