import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { type Card, compare } from '../src/surfaces/card.ts'
import { consoleCards, readConsolePricing } from '../src/surfaces/console.ts'

/**
 * The Blockfrost pricing grid's cells as a signed-in person reads them on a
 * Free port, in the order webui's pricing route renders them
 * (`routes/$projectNamespace.resources.$resourceId.pricing.tsx` and
 * `utils/pricing/values.ts`, 2026-10-19). The page renders only signed in, so
 * no capture of it is committed; J2 reads it live.
 */
const grid = [
  'Pricing Tiers\nChoose the tier that best fits your needs.\n',
  'Free\nSELECTED',
  'Flexible\nUPGRADE',
  'Pro I\nUPGRADE',
  'Pro II\nUPGRADE',
  'Minimum ticket',
  '$0',
  '$0',
  '$50',
  '$150',
  'Price per 100k requests',
  '$0',
  '$0.3',
  '$0.26',
  '$0.23',
  'Max requests per second',
  '5',
  '20',
  '100',
  '300',
  'Daily requests limit',
  '~430,000',
  '~1,700,000',
  '~8,600,000',
  '~26,000,000',
]

/** fabric's Blockfrost plan (`bootstrap/rpc/crds/blockfrostport.json`, fabric d887e2be3507), as `fabricCards` reads it. */
const fabric: Card[] = [
  { port: 'blockfrost', tier: '0', minimum_usd: 0, per_100k_usd: 0 },
  { port: 'blockfrost', tier: '1', minimum_usd: 0, per_100k_usd: 3e-6 * 100_000 },
  { port: 'blockfrost', tier: '2', minimum_usd: 50, per_100k_usd: 2.6e-6 * 100_000 },
  { port: 'blockfrost', tier: '3', minimum_usd: 150, per_100k_usd: 2.3e-6 * 100_000 },
]

const cards = (cells = grid) => consoleCards(readConsolePricing(cells), 'blockfrost')
const owes = { owes: { console: ['blockfrost'] } }
const edited = (at: number, value: string) => grid.map((c, i) => (i === at ? value : c))

describe("the Console's pricing grid", () => {
  it('reads one card per plan, as fabric tiers', () => {
    assert.deepEqual(readConsolePricing(grid).columns, ['Free', 'Flexible', 'Pro I', 'Pro II'])
    assert.deepEqual(
      cards().map(({ tier, minimum_usd, per_100k_usd }) => [tier, minimum_usd, per_100k_usd]),
      [
        ['0', 0, 0],
        ['1', 0, 0.3],
        ['2', 50, 0.26],
        ['3', 150, 0.23],
      ],
    )
  })

  it("agrees with fabric's Blockfrost plan", () => {
    assert.deepEqual(compare(fabric, { console: cards() }, owes), [])
  })

  it('names a changed rate or minimum in one line each', () => {
    assert.deepEqual(compare(fabric, { console: cards(edited(12, '$0.35')) }, owes), ['Blockfrost Flexible per 100k: fabric $0.30 · console $0.35'])
    assert.deepEqual(compare(fabric, { console: cards(edited(8, '$60')) }, owes), ['Blockfrost Pro I minimum: fabric $50 · console $60'])
  })

  it('reads the same whichever plan is the current one', () => {
    const upgraded = grid.map((c, i) => (i === 1 ? 'Free\nUPGRADE' : i === 3 ? 'Pro I\nSELECTED' : c))
    assert.deepEqual(cards(upgraded), cards())
  })

  it('fails a grid it cannot read, rather than read no price', () => {
    assert.throws(() => cards(['Plans', ...grid.slice(1)]), /opens with "Plans", wanted "Pricing Tiers"/)
    assert.throws(() => cards(grid.map((c) => c.replace(/\n(SELECTED|UPGRADE)$/, ''))), /names no plan/)
    assert.throws(() => cards(grid.slice(0, -1)), /19 cells after its 4 plans, which is no whole number of rows/)
    assert.throws(() => cards(edited(2, 'Starter\nUPGRADE')), /a "Starter" plan, which is no fabric tier/)
    assert.throws(() => cards(edited(5, 'Minimum fee')), /wanted one "Minimum ticket" row, found Minimum fee, Price per 100k requests/)
    assert.throws(() => cards(edited(10, 'Price per request')), /cannot convert "Price per request" to units/)
    assert.throws(() => cards(edited(12, 'Free')), /cannot read "Free" as a price/)
  })
})
