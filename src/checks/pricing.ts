import { readPage } from '../http.ts'
import { type Card, compare } from '../surfaces/card.ts'
import { fabricCards, fabricTiers, fetchMetadata } from '../surfaces/fabric.ts'
import { landingCards, pricingCards, readPricingTable } from '../surfaces/website2.ts'
import type { Check } from './check.ts'

/**
 * The deployed surfaces that state a price agree: fabric's live metadata (what
 * is billed) and website2's `/pricing` table and landing cards (what a visitor
 * reads). The Console's prices render only signed in, so its leg runs inside
 * J2 with the same comparator. On 2026-07-31 these disagreed by 4.7× on
 * Blockfrost, and UTxO RPC was quoted on website2 while fabric billed it
 * nothing (the rate-card rollout: fabric#272, webui#137, website2#10).
 *
 * A divergence in production is not suppressed: it stays red and alerts
 * (founder, 2026-10-19).
 */
export const pricing: Check = {
  name: 'pricing',
  summary: "fabric's live metadata, website2's /pricing table and its landing cards state the same prices",
  async run({ env, run }) {
    let billed: Card[] | null = null
    const quotes: Record<string, Card[]> = {}

    await run.step(`read fabric's prices from ${env.rpc}`, async () => {
      const records = await fetchMetadata(env.rpc)
      billed = fabricCards(fabricTiers(records))
      const priced = new Set(billed.filter((c) => c.minimum_usd !== null).map((c) => c.port))
      return `${records.length} kinds, ${priced.size} priced (${[...priced].sort().join(', ')})`
    })

    await run.step(`read ${env.website}/pricing`, async () => {
      quotes.website2 = pricingCards(readPricingTable(await readPage(`${env.website}/pricing`)))
      const ports = [...new Set(quotes.website2.map((c) => c.port))]
      return `${ports.length} ports (${ports.join(', ')})`
    })

    await run.step(`read the landing cards on ${env.website}/`, async () => {
      if (!quotes.website2) throw new Error('not read: the /pricing table names the ports the cards quote for')
      const ports = [...new Set(quotes.website2.map((c) => c.port))]
      quotes['website2 landing'] = landingCards(await readPage(`${env.website}/`), ports)
      return 'Flexible, Pro I and Pro II'
    })

    await run.step('compare', () => {
      if (!quotes.website2 || !quotes['website2 landing']) throw new Error('not compared: website2 could not be read')
      const divergences = compare(billed, quotes)
      const n = divergences.length
      if (n > 0) throw new Error(`${n} divergence${n === 1 ? '' : 's'}:\n${divergences.join('\n')}`)
      return billed ? 'every surface agrees with fabric' : "website2's table and landing cards agree; fabric not compared, its prices could not be read"
    })
  },
}
