import { type Card, parseUsd } from './card.ts'

/**
 * The Console's price for one port, as a signed-in person reads it on the
 * port's pricing page (`routes/$projectNamespace.resources.$resourceId.pricing.tsx`
 * in webui, read on 2026-10-19). The page renders only signed in, so J2 reads
 * it, from the browser.
 *
 * The page is one grid, read here as its cells' visible text in order: a
 * heading cell ("Pricing Tiers"), one cell per plan (its name, then
 * "SELECTED" on the port's current plan and "UPGRADE" on the others), then
 * rows of a label and one value per plan: "Minimum ticket", "Price per 100k
 * requests", and the throughput rows. A grid that does not read this way
 * fails the reader rather than reading as no price.
 */

export interface ConsolePricing {
  /** The plan columns, left to right: `Free`, `Flexible`, `Pro I`, `Pro II`. */
  columns: string[]
  rows: { label: string; values: string[] }[]
}

/** The Console's plan names, as fabric's throughput tiers (`pricingTierPlansNames` in webui). */
const planTiers: Record<string, string> = { Free: '0', Flexible: '1', 'Pro I': '2', 'Pro II': '3' }

/** How many metered units each "Price per …" row prices. */
const usageUnits: Record<string, number> = {
  'Price per 100k requests': 100_000,
  'Price per 100k messages': 100_000,
}

const lines = (cell: string): string[] =>
  cell
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)

/** The grid's cells, each one's visible text, in document order. */
export function readConsolePricing(cells: string[]): ConsolePricing {
  const [head, ...rest] = cells.map((c) => c.trim())
  if (!head || lines(head)[0] !== 'Pricing Tiers') throw new Error(`the pricing grid opens with "${lines(head ?? '')[0] ?? ''}", wanted "Pricing Tiers"`)
  const columns: string[] = []
  while (rest.length > 0 && ['SELECTED', 'UPGRADE'].includes(lines(rest[0]!)[1] ?? '')) columns.push(lines(rest.shift()!)[0]!)
  if (columns.length === 0) throw new Error('the pricing grid names no plan')
  if (rest.length % (columns.length + 1) !== 0) {
    throw new Error(`the pricing grid has ${rest.length} cells after its ${columns.length} plans, which is no whole number of rows`)
  }
  const rows: ConsolePricing['rows'] = []
  for (let at = 0; at < rest.length; at += columns.length + 1) {
    rows.push({ label: rest[at]!, values: rest.slice(at + 1, at + 1 + columns.length) })
  }
  return { columns, rows }
}

/** The page's quote for `port`, one card per plan. */
export function consoleCards(pricing: ConsolePricing, port: string): Card[] {
  const tiers = pricing.columns.map((name) => {
    const tier = planTiers[name]
    if (!tier) throw new Error(`the Console's pricing grid has a "${name}" plan, which is no fabric tier this check knows`)
    return tier
  })
  const labels = pricing.rows.map((r) => r.label).join(', ')
  const minimums = pricing.rows.filter((r) => /minimum/i.test(r.label))
  if (minimums.length !== 1 || minimums[0]!.label !== 'Minimum ticket') throw new Error(`wanted one "Minimum ticket" row, found ${labels}`)
  const usage = pricing.rows.filter((r) => r.label.startsWith('Price per '))
  if (usage.length !== 1) throw new Error(`wanted one usage row ("Price per …"), found ${labels}`)
  const units = usageUnits[usage[0]!.label]
  if (!units) throw new Error(`cannot convert "${usage[0]!.label}" to units`)
  return tiers.map((tier, column) => {
    const perUnit = parseUsd(usage[0]!.values[column]!)
    return {
      port,
      tier,
      minimum_usd: parseUsd(minimums[0]!.values[column]!),
      per_100k_usd: perUnit === null ? null : (perUnit / units) * 100_000,
    }
  })
}
