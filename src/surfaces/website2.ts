import { join } from 'node:path'
import { type Card, importModule, parseUsd } from './card.ts'
import { website2Names } from './ports.ts'

/** The detailed pricing table on `/pricing`. */
export const portPricingModule = 'src/content/portPricing.ts'
/** The tier cards on the landing page. */
export const plansModule = 'src/content/plans.ts'
/** Every link target on the site. */
export const linksModule = 'src/content/links.ts'

export interface PortPricingRow {
  name: string
  metrics: { label: string; flex: string; pro1: string; pro2: string }[]
}

export interface PlanTier {
  id: string
  price: string
  priceUnit: string
  note: string
}

/** The table's columns, as fabric's throughput tiers. */
const columns = { flex: '1', pro1: '2', pro2: '3' } as const

/** The landing cards' ids, as fabric's throughput tiers; `custom` has no price. */
const planIds: Record<string, string> = { flexible: '1', 'pro-1': '2', 'pro-2': '3' }

/** How many metered units each "PER …" row prices; a connection is metered by the second. */
const rowUnits: Record<string, number> = {
  'PER 100K REQUESTS': 100_000,
  'PER 100K MESSAGES': 100_000,
  'PER 24H OF CONNECTION': 86_400,
}

const priceUnits: Record<string, number> = {
  'per 100k requests': 100_000,
  'per 100k messages': 100_000,
}

export async function loadPortPricing(website2Dir: string): Promise<PortPricingRow[]> {
  const module = await importModule<{ ports?: PortPricingRow[] }>(join(website2Dir, portPricingModule))
  if (!module.ports) throw new Error(`${portPricingModule}: no ports export`)
  return module.ports
}

export async function loadPlanTiers(website2Dir: string): Promise<PlanTier[]> {
  const module = await importModule<{ planTiers?: PlanTier[] }>(join(website2Dir, plansModule))
  if (!module.planTiers) throw new Error(`${plansModule}: no planTiers export`)
  return module.planTiers
}

export async function loadLinks(website2Dir: string): Promise<Record<string, string>> {
  const module = await importModule<{ links?: Record<string, string> }>(join(website2Dir, linksModule))
  if (!module.links) throw new Error(`${linksModule}: no links export`)
  return module.links
}

/** The `/pricing` table's quote for every port and column it prices. */
export function portPricingCards(rows: PortPricingRow[]): Card[] {
  const cards: Card[] = []
  for (const row of rows) {
    const port = website2Names[row.name]
    if (!port) throw new Error(`website2 prices "${row.name}", a port this check cannot place: add it to src/surfaces/ports.ts`)
    const minimum = row.metrics.find((m) => m.label === 'MINIMUM FEE')
    const usage = row.metrics.filter((m) => m.label.startsWith('PER '))
    if (usage.length > 1) throw new Error(`${row.name}: more than one usage row (${usage.map((m) => m.label).join(', ')})`)
    const units = usage[0] ? rowUnits[usage[0].label] : undefined
    if (usage[0] && !units) throw new Error(`${row.name}: cannot convert "${usage[0].label}" to units`)
    for (const [column, tier] of Object.entries(columns)) {
      const perUnit = usage[0] && units ? parseUsd(usage[0][column as keyof typeof columns]) : null
      cards.push({
        port,
        tier,
        minimum_usd: minimum ? parseUsd(minimum[column as keyof typeof columns]) : null,
        per_100k_usd: perUnit === null || !units ? null : (perUnit / units) * 100_000,
      })
    }
  }
  return cards
}

/**
 * The landing cards' quote. Each card prices "all APIs, one rate", so it is
 * a quote for every port in `ports`, the ports the `/pricing` table lists.
 * The minimum fee is read from the card's note.
 */
export function landingCards(tiers: PlanTier[], ports: string[]): Card[] {
  const cards: Card[] = []
  for (const plan of tiers) {
    const tier = planIds[plan.id]
    if (!tier) continue
    const units = priceUnits[plan.priceUnit]
    if (!units) throw new Error(`landing card ${plan.id}: cannot convert "${plan.priceUnit}" to units`)
    const price = parseUsd(plan.price)
    let minimum: number | null = null
    if (/no minimum fee/i.test(plan.note)) minimum = 0
    const fee = /minimum fee (?:from )?(\$[\d,.]*\d)/i.exec(plan.note)
    if (fee) minimum = parseUsd(fee[1]!)
    for (const port of ports) {
      cards.push({ port, tier, minimum_usd: minimum, per_100k_usd: price === null ? null : (price / units) * 100_000 })
    }
  }
  return cards
}
