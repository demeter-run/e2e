import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { formatUsd, parseUsd } from '../src/surfaces/card.ts'
import { consoleCards, loadConsolePricing, recognisedIntents } from '../src/surfaces/console.ts'
import { fabricCards, readFabricTiers } from '../src/surfaces/fabric.ts'
import { landingCards, loadPlanTiers, loadPortPricing, portPricingCards } from '../src/surfaces/website2.ts'
import { copyFixtures, edit, fixture } from './helpers.ts'

const near = (actual: number | null | undefined, expected: number) =>
  assert.ok(actual !== null && actual !== undefined && Math.abs(actual - expected) < 1e-9, `${actual} ≉ ${expected}`)

describe('prices as website2 displays them', () => {
  it('reads dollars, cents and thousands separators', () => {
    assert.equal(parseUsd('$0.30'), 0.3)
    assert.equal(parseUsd('$50'), 50)
    assert.equal(parseUsd('$1,000'), 1000)
    assert.equal(parseUsd('$12,500.50'), 12500.5)
  })

  it('reads an unpublished price as null', () => {
    assert.equal(parseUsd('—'), null)
  })

  it('refuses what is not a price', () => {
    assert.throws(() => parseUsd('Talk'))
    assert.throws(() => parseUsd('$1,00'))
    assert.throws(() => parseUsd('0.30'))
  })

  it('prints a price the way a person reads it', () => {
    assert.equal(formatUsd(0.3), '$0.30')
    assert.equal(formatUsd(150), '$150')
    assert.equal(formatUsd(0.30000000000000004), '$0.30')
    assert.equal(formatUsd(1.38889), '$1.3889')
    assert.equal(formatUsd(null), '—')
  })
})

describe('fabric', () => {
  it('reads every tier of every CRD with its dns and cost', async () => {
    const tiers = await readFabricTiers(fixture('fabric'))
    const blockfrost = tiers.filter((t) => t.kind === 'blockfrostport')
    assert.deepEqual(blockfrost.map((t) => t.tier), ['0', '1', '2', '3'])
    assert.deepEqual(blockfrost[2]!.cost, { minimum: 50, delta: 0.0000026 })
    assert.equal(tiers.find((t) => t.kind === 'kupoport')!.dns, 'dmtr.host')
  })

  it('prices per 100k as delta × 100000', async () => {
    const cards = fabricCards(await readFabricTiers(fixture('fabric')))
    const card = cards.find((c) => c.port === 'blockfrost' && c.tier === '1')!
    assert.equal(card.minimum_usd, 0)
    near(card.per_100k_usd, 0.3)
  })

  it('reads a tier with no cost block as billing nothing', async () => {
    const cards = fabricCards(await readFabricTiers(fixture('fabric')))
    const trp = cards.filter((c) => c.port === 'trp')
    assert.equal(trp.length, 4)
    for (const c of trp) assert.deepEqual([c.minimum_usd, c.per_100k_usd], [null, null])
    // Ogmios tier 4 is the off-card internal tier (decision 0024): no cost.
    assert.equal(cards.find((c) => c.port === 'ogmios' && c.tier === '4')!.minimum_usd, null)
  })

  it('refuses a cost block without a delta', async () => {
    const dir = await copyFixtures()
    await edit(join(dir, 'fabric/bootstrap/rpc/crds/kupoport.json'), '"delta": 0.000003', '"rate": 0.000003')
    await assert.rejects(readFabricTiers(join(dir, 'fabric')), /kupoport\.json: plan\.1\.cost needs numeric minimum and delta/)
  })
})

describe('the Console', () => {
  it('reads every port and plan from values.ts', async () => {
    const cards = consoleCards(await loadConsolePricing(fixture('webui')))
    assert.deepEqual(
      [...new Set(cards.map((c) => c.port))].sort(),
      ['blockfrost', 'dbsync', 'kupo', 'marlowe', 'node', 'ogmios', 'submitapi', 'utxorpc'],
    )
    const proI = cards.find((c) => c.port === 'blockfrost' && c.tier === '2')!
    assert.equal(proI.minimum_usd, 50)
    near(proI.per_100k_usd, 0.26)
  })

  it('converts each usage label to metered units', async () => {
    const cards = consoleCards(await loadConsolePricing(fixture('webui')))
    // $1.20 per 24 h of open connection, metered by the second.
    near(cards.find((c) => c.port === 'node' && c.tier === '1')!.per_100k_usd, (1.2 / 86_400) * 100_000)
    // $0.09 per 1000 submits.
    near(cards.find((c) => c.port === 'submitapi' && c.tier === '1')!.per_100k_usd, 9)
    // $0.30 per 100k messages.
    near(cards.find((c) => c.port === 'ogmios' && c.tier === '1')!.per_100k_usd, 0.3)
  })

  it('refuses a slug it cannot place and a label it cannot convert', async () => {
    const pricing = await loadConsolePricing(fixture('webui'))
    assert.throws(() => consoleCards({ 'cardano-new-port': pricing['cardano-kupo-port']! }), /cardano-new-port/)
    const dir = await copyFixtures()
    await edit(join(dir, 'webui/src/app/utils/pricing/values.ts'), "'100k requests'", "'1M requests'", "'cardano-kupo-port'")
    const edited = await loadConsolePricing(join(dir, 'webui'))
    assert.throws(() => consoleCards(edited), /cardano-kupo-port FLEXIBLE: cannot convert "1M requests"/)
  })

  it('reads the intents login.tsx recognises', async () => {
    assert.deepEqual(recognisedIntents(await readFile(fixture('webui/src/app/routes/login.tsx'), 'utf8')), ['signup'])
    assert.deepEqual(recognisedIntents(`if (intent === 'signup' || 'login' == intent) {}`), ['login', 'signup'])
    assert.deepEqual(recognisedIntents(`switch (intent) {\n case 'a': break\n case B: break\n}\nconst B = 'b'`), ['a', 'b'])
    assert.deepEqual(recognisedIntents('const x = 1'), [])
  })
})

describe('website2', () => {
  it('reads the /pricing table per column', async () => {
    const cards = portPricingCards(await loadPortPricing(fixture('website2')))
    assert.deepEqual([...new Set(cards.map((c) => c.port))], ['ogmios', 'kupo', 'blockfrost', 'utxorpc'])
    const proII = cards.find((c) => c.port === 'utxorpc' && c.tier === '3')!
    assert.equal(proII.minimum_usd, 150)
    near(proII.per_100k_usd, 0.23)
  })

  it('reads a minimum fee with a thousands separator', async () => {
    const dir = await copyFixtures()
    await edit(join(dir, 'website2/src/content/portPricing.ts'), "pro2: '$150'", "pro2: '$1,500'", "name: 'Kupo'")
    const cards = portPricingCards(await loadPortPricing(join(dir, 'website2')))
    assert.equal(cards.find((c) => c.port === 'kupo' && c.tier === '3')!.minimum_usd, 1500)
  })

  it('reads an unpublished cell as no price, and a per-connection row in seconds', () => {
    const cards = portPricingCards([
      {
        name: 'Ogmios',
        metrics: [
          { label: 'MINIMUM FEE', flex: '$0', pro1: '—', pro2: '$200' },
          { label: 'PER 24H OF CONNECTION', flex: '$0.23', pro1: '—', pro2: '$0.17' },
        ],
      },
    ])
    assert.deepEqual(cards[1], { port: 'ogmios', tier: '2', minimum_usd: null, per_100k_usd: null })
    near(cards[0]!.per_100k_usd, (0.23 / 86_400) * 100_000)
  })

  it('refuses a port it cannot place and a unit it cannot convert', () => {
    assert.throws(() => portPricingCards([{ name: 'Dolos', metrics: [] }]), /Dolos/)
    assert.throws(
      () => portPricingCards([{ name: 'Kupo', metrics: [{ label: 'PER 1M REQUESTS', flex: '$1', pro1: '$1', pro2: '$1' }] }]),
      /PER 1M REQUESTS/,
    )
  })

  it('reads the landing cards as a quote for every listed port', async () => {
    const cards = landingCards(await loadPlanTiers(fixture('website2')), ['kupo', 'ogmios'])
    assert.equal(cards.length, 6)
    const flexible = cards.find((c) => c.port === 'ogmios' && c.tier === '1')!
    assert.equal(flexible.minimum_usd, 0)
    near(flexible.per_100k_usd, 0.3)
    assert.equal(cards.find((c) => c.port === 'kupo' && c.tier === '2')!.minimum_usd, 50)
    assert.equal(cards.find((c) => c.port === 'kupo' && c.tier === '3')!.minimum_usd, 150)
  })
})
