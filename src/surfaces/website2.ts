import { textTokens } from '../html.ts'
import { type Card, parseUsd } from './card.ts'
import { website2Names } from './ports.ts'

/**
 * website2's prices as a visitor reads them: the `/pricing` table and the tier
 * cards on the landing page, both server-rendered, read from the page text.
 * The text order was read from the live pages on 2026-10-19
 * (`test/fixtures/live/`); when the markup moves, these readers fail rather
 * than read nothing.
 */

export interface PricingTable {
  /** The plan columns, left to right: `Flexible`, `Pro I`, `Pro II`. */
  columns: string[]
  ports: { name: string; rows: { label: string; values: string[] }[] }[]
}

/** The table's column names, as fabric's throughput tiers. */
const columnTiers: Record<string, string> = { Flexible: '1', 'Pro I': '2', 'Pro II': '3' }

/** How many metered units each "PER …" row prices; a connection is metered by the second. */
const rowUnits: Record<string, number> = {
  'PER 100K REQUESTS': 100_000,
  'PER 100K MESSAGES': 100_000,
  'PER 24H OF CONNECTION': 86_400,
}

const isLabel = (t: string | undefined): boolean => t !== undefined && /[A-Z]/.test(t) && !/[a-z]/.test(t)
const isValue = (t: string | undefined): boolean => t !== undefined && /^(?:\$\s?)?[\d,]+(?:\.\d+)?$|^[—–-]$/.test(t)
/**
 * A table cell, readable or not: a value, or one word (`1.7M`, `Free`). The
 * headings and links after the table run to several words or carry no digit
 * (`PRODUCT`, then `Products`, `Pricing`, `Status`), which tells them apart.
 */
const isCell = (t: string | undefined): boolean => isValue(t) || (t !== undefined && /^\S+$/.test(t))

/**
 * The `/pricing` table. In text order it is the header (`PORT / METRIC`, then
 * a tag, a name and a blurb per plan column), then per port its name, a few
 * lines of description, and its rows: an upper-case label followed by one value
 * per column. Text that is not a row starts the next port; a "port" with no
 * rows (the footnotes after the table) is not one.
 *
 * A label followed by one word per column, one with a digit, is a row with a
 * cell this reader cannot read (`1,700,000` shortened to `1.7M`, `$0` turned
 * `Free`). It fails naming that row and cell: read as text, its label would
 * start a port that is not there, or drop a price row from the port it is in.
 */
export function readPricingTable(html: string): PricingTable {
  const tokens = textTokens(html)
  const start = tokens.indexOf('PORT / METRIC')
  if (start < 0) throw new Error('/pricing has no "PORT / METRIC" table header')
  const columns: string[] = []
  let at = start + 1
  while (/^PLAN \d+$/.test(tokens[at] ?? '')) {
    columns.push(tokens[at + 1] ?? '')
    at += 3
  }
  if (columns.length === 0) throw new Error('/pricing table header names no plan column')

  const ports: PricingTable['ports'] = []
  let current: PricingTable['ports'][number] | undefined
  let newPort = true
  while (at < tokens.length) {
    const row = tokens.slice(at + 1, at + 1 + columns.length)
    if (isLabel(tokens[at]) && row.length === columns.length && row.every(isValue)) {
      if (!current) throw new Error(`/pricing row "${tokens[at]}" before any port`)
      current.rows.push({ label: tokens[at]!, values: row })
      at += 1 + columns.length
      newPort = true
      continue
    }
    if (isLabel(tokens[at]) && row.length === columns.length && row.every(isCell) && row.some((t) => /\d/.test(t))) {
      const cell = row.findIndex((t) => !isValue(t))
      throw new Error(`/pricing ${current?.name ?? 'header'}, row "${tokens[at]}": cannot read "${row[cell]}" in the ${columns[cell]} column`)
    }
    if (newPort) {
      current = { name: tokens[at]!, rows: [] }
      ports.push(current)
      newPort = false
    }
    at += 1
  }
  return { columns, ports: ports.filter((p) => p.rows.length > 0) }
}

/** The table's quote for every port and column it prices. */
export function pricingCards(table: PricingTable): Card[] {
  const tiers = table.columns.map((name) => {
    const tier = columnTiers[name]
    if (!tier) throw new Error(`/pricing has a "${name}" column, which is no fabric tier this check knows`)
    return tier
  })
  if (table.ports.length === 0) throw new Error('/pricing prices no port')
  const cards: Card[] = []
  for (const { name, rows } of table.ports) {
    const port = website2Names[name]
    if (!port) throw new Error(`website2 prices "${name}", a port this check cannot place: add it to src/surfaces/ports.ts`)
    // A price row this reader cannot place fails it: a relabelled row read as
    // no price would let the comparison skip what it states.
    const labels = rows.map((r) => r.label).join(', ')
    const minimums = rows.filter((r) => r.label.includes('MINIMUM'))
    if (minimums.length !== 1 || minimums[0]!.label !== 'MINIMUM FEE') throw new Error(`${name}: wanted one "MINIMUM FEE" row, found ${labels}`)
    const usage = rows.filter((r) => r.label.startsWith('PER '))
    if (usage.length !== 1) throw new Error(`${name}: wanted one usage row ("PER …"), found ${labels}`)
    const units = rowUnits[usage[0]!.label]
    if (!units) throw new Error(`${name}: cannot convert "${usage[0]!.label}" to units`)
    tiers.forEach((tier, column) => {
      const perUnit = parseUsd(usage[0]!.values[column]!)
      cards.push({
        port,
        tier,
        minimum_usd: parseUsd(minimums[0]!.values[column]!),
        per_100k_usd: perUnit === null ? null : (perUnit / units) * 100_000,
      })
    })
  }
  return cards
}

/** The landing page's tier cards, by the tag each card opens with. */
const landingTags: Record<string, string> = { FLEXIBLE: '1', 'PRO I': '2', 'PRO II': '3' }

const landingUnits: Record<string, number> = {
  'per 100k requests': 100_000,
  'per 100k messages': 100_000,
}

/**
 * The landing cards' quote. A card is its tag, a price, a unit and a note
 * that states the minimum fee. Each card prices "all APIs, one rate", so it is
 * a quote for every port in `ports`, the ports the `/pricing` table lists.
 */
export function landingCards(html: string, ports: string[]): Card[] {
  const tokens = textTokens(html)
  const cards: Card[] = []
  for (const [tag, tier] of Object.entries(landingTags)) {
    const at = tokens.flatMap((t, i) => (t === tag && isValue(tokens[i + 1]) && /^per /.test(tokens[i + 2] ?? '') ? [i] : []))
    if (at.length !== 1) throw new Error(`the landing page has ${at.length} "${tag}" price cards, wanted 1`)
    const [price, unit, note] = [tokens[at[0]! + 1]!, tokens[at[0]! + 2]!, tokens[at[0]! + 3] ?? '']
    const units = landingUnits[unit]
    if (!units) throw new Error(`landing card ${tag}: cannot convert "${unit}" to units`)
    // The two wordings the live cards use; any other fails the reader rather
    // than read the card as stating no minimum.
    const fee = /minimum fee (?:from )?(\$[\d,.]*\d)/i.exec(note)
    const minimum = /no minimum fee/i.test(note) ? 0 : fee ? parseUsd(fee[1]!) : null
    if (minimum === null) throw new Error(`landing card ${tag}: cannot read a minimum fee in "${note}"`)
    const perUnit = parseUsd(price)
    for (const port of ports) {
      cards.push({ port, tier, minimum_usd: minimum, per_100k_usd: perUnit === null ? null : (perUnit / units) * 100_000 })
    }
  }
  return cards
}
