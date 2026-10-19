import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { anchors, textTokens } from '../src/html.ts'
import { formatUsd, parseUsd } from '../src/surfaces/card.ts'
import { decodeFetchMetadata, fabricCards, fabricTiers, fetchMetadata } from '../src/surfaces/fabric.ts'
import { landingCards, pricingCards, readPricingTable } from '../src/surfaces/website2.ts'
import { edit, fetchMetadataBody, live, refusedUrl, serveH2c } from './helpers.ts'

const near = (actual: number | null | undefined, expected: number) =>
  assert.ok(actual !== null && actual !== undefined && Math.abs(actual - expected) < 1e-9, `${actual} ≉ ${expected}`)

const pricingPage = live('pricing.html').toString('utf8')
const homePage = live('home.html').toString('utf8')

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

describe('server-rendered pages as text', () => {
  it('reads past the NUL bytes in the SSR HTML', () => {
    assert.ok(pricingPage.includes('\0'), 'the captured page should carry the NULs production serves')
    assert.ok(textTokens(pricingPage).includes('PORT / METRIC'))
  })

  it('drops scripts and comments, and decodes entities', () => {
    assert.deepEqual(textTokens('<p>a &amp; b<!-- x --></p><script>var s = "<b>no</b>"</script><b> c&#39;d </b>'), ['a & b', "c'd"])
  })

  it('reads every link with its visible text, resolved against the page', () => {
    assert.deepEqual(anchors('<a class="x" href="/pricing?a=1&amp;b=2"><span>Full</span> list →</a><a>none</a>', 'https://demeter.run/'), [
      { href: 'https://demeter.run/pricing?a=1&b=2', text: 'Full list →' },
    ])
  })

  it('keeps a link whose target is not a URL, marked broken', () => {
    assert.deepEqual(anchors('<a href="https://console.demeter.run /login">Sign in</a>', 'https://demeter.run/'), [
      { href: 'https://console.demeter.run /login', text: 'Sign in', broken: true },
    ])
  })
})

describe('fabric', () => {
  it('reads the live FetchMetadata response: every kind, and no prices', () => {
    const records = decodeFetchMetadata(new Uint8Array(live('fetch-metadata.bin')))
    assert.deepEqual(records.map((r) => r.kind).sort(), [
      'BaliusWorker',
      'BlockfrostPort',
      'CardanoNodePort',
      'DbSyncPort',
      'KupoPort',
      'MarlowePort',
      'MumakPort',
      'OgmiosPort',
      'ScrollsPort',
      'SubmitApiPort',
      'TrpPort',
      'UtxoRpcPort',
    ])
    assert.ok(records.every((r) => r.plan === null))
    assert.throws(() => fabricTiers(records), /^Error: fabric's live metadata publishes no prices: none of its 12 FetchMetadata records carries a plan/)
  })

  it('reads a plan served in field 3, per 100k as delta × 100000', () => {
    const plan = { '0': { dns: 'dmtr.host', cost: { minimum: 0, delta: 0 } }, '1': { dns: 'dmtr.host', cost: { minimum: 0, delta: 0.000003 } } }
    const records = decodeFetchMetadata(fetchMetadataBody([{ kind: 'KupoPort', extra: { 3: JSON.stringify(plan) } }]))
    const cards = fabricCards(fabricTiers(records))
    assert.deepEqual(cards[0], { port: 'kupo', tier: '0', minimum_usd: 0, per_100k_usd: 0 })
    near(cards[1]!.per_100k_usd, 0.3)
  })

  it('reads a tier with no cost as billing nothing', () => {
    const plan = { '1': { dns: 'demeter.run' }, '2': { dns: 'demeter.run', cost: null } }
    const records = decodeFetchMetadata(fetchMetadataBody([{ kind: 'UtxoRpcPort', extra: { 3: JSON.stringify(plan) } }]))
    assert.deepEqual(fabricCards(fabricTiers(records)), [
      { port: 'utxorpc', tier: '1', minimum_usd: null, per_100k_usd: null },
      { port: 'utxorpc', tier: '2', minimum_usd: null, per_100k_usd: null },
    ])
  })

  it('refuses a cost without a delta, and a failed call', () => {
    const plan = { '1': { dns: 'dmtr.host', cost: { minimum: 0, rate: 0.000003 } } }
    const records = decodeFetchMetadata(fetchMetadataBody([{ kind: 'KupoPort', extra: { 3: JSON.stringify(plan) } }]))
    assert.throws(() => fabricTiers(records), /KupoPort: plan\.1\.cost needs numeric minimum and delta/)
    assert.throws(() => decodeFetchMetadata(fetchMetadataBody([], 'grpc-status:14\r\ngrpc-message:unavailable\r\n')), /grpc-status 14 unavailable/)
  })
})

// A test that outlives its own timeout fails rather than hang the suite: a
// timer scaled wrong would otherwise outlive the CI job.
describe("fabric's transport", { timeout: 5_000 }, () => {
  it('says why nothing answered when fabric is unreachable', async () => {
    await assert.rejects(fetchMetadata(await refusedUrl(), { timeoutMs: 2_000 }), /^Error: FetchMetadata: no answer: ECONNREFUSED/)
  })

  it('says nothing answered in time when fabric never answers', async () => {
    const fabric = await serveH2c(() => {})
    try {
      await assert.rejects(fetchMetadata(fabric.url, { timeoutMs: 300 }), { message: 'FetchMetadata: no answer within 0.3 s' })
    } finally {
      await fabric.close()
    }
  })

  it('keeps the status when the body stalls after it', async () => {
    const fabric = await serveH2c((_, response) => {
      response.writeHead(200, { 'content-type': 'application/grpc-web+proto' })
      // A frame header promising ten bytes, then nothing.
      response.write(Buffer.from([0, 0, 0, 0, 10]))
    })
    try {
      await assert.rejects(fetchMetadata(fabric.url, { timeoutMs: 300 }), {
        message: 'FetchMetadata: answered HTTP 200, but the body did not finish within 0.3 s',
      })
    } finally {
      await fabric.close()
    }
  })
})

describe('website2', () => {
  it('reads the live /pricing table per column', () => {
    const table = readPricingTable(pricingPage)
    assert.deepEqual(table.columns, ['Flexible', 'Pro I', 'Pro II'])
    assert.deepEqual(table.ports.map((p) => p.name), ['Ogmios', 'Kupo', 'Blockfrost', 'UTxO RPC'])
    const cards = pricingCards(table)
    const proII = cards.find((c) => c.port === 'utxorpc' && c.tier === '3')!
    assert.equal(proII.minimum_usd, 150)
    near(proII.per_100k_usd, 0.23)
    near(cards.find((c) => c.port === 'ogmios' && c.tier === '1')!.per_100k_usd, 0.3)
  })

  it('reads a minimum fee with a thousands separator', () => {
    const page = edit(pricingPage, '>$150<', '>$1,500<', '>Kupo<')
    const cards = pricingCards(readPricingTable(page))
    assert.equal(cards.find((c) => c.port === 'kupo' && c.tier === '3')!.minimum_usd, 1500)
    assert.equal(cards.find((c) => c.port === 'ogmios' && c.tier === '3')!.minimum_usd, 150)
  })

  it('reads an unpublished cell as no price, and a per-connection row in seconds', () => {
    const cards = pricingCards({
      columns: ['Flexible', 'Pro I', 'Pro II'],
      ports: [
        {
          name: 'Ogmios',
          rows: [
            { label: 'MINIMUM FEE', values: ['$0', '—', '$200'] },
            { label: 'PER 24H OF CONNECTION', values: ['$0.23', '—', '$0.17'] },
          ],
        },
      ],
    })
    assert.deepEqual(cards[1], { port: 'ogmios', tier: '2', minimum_usd: null, per_100k_usd: null })
    near(cards[0]!.per_100k_usd, (0.23 / 86_400) * 100_000)
  })

  it('refuses a minimum fee or usage row it cannot place, rather than read no price', () => {
    // Read as no minimum, the relabelled row would let $60 against fabric's $50 pass.
    const relabelled = edit(edit(pricingPage, '>MINIMUM FEE<', '>MINIMUM FEE / MONTH<', '>Kupo<'), '>$50<', '>$60<', '>Kupo<')
    assert.throws(
      () => pricingCards(readPricingTable(relabelled)),
      /^Error: Kupo: wanted one "MINIMUM FEE" row, found MINIMUM FEE \/ MONTH, PER 100K REQUESTS, MAX REQUESTS \/ SECOND, APPROX\. DAILY REQUESTS$/,
    )
    const noUsage = edit(pricingPage, '>PER 100K REQUESTS<', '>USAGE PER 100K REQUESTS<', '>Kupo<')
    assert.throws(() => pricingCards(readPricingTable(noUsage)), /^Error: Kupo: wanted one usage row \("PER …"\), found MINIMUM FEE, USAGE PER 100K REQUESTS,/)
  })

  it('refuses a second minimum fee or usage row, rather than read the first', () => {
    const port = (name: string, rows: { label: string; values: string[] }[]) => () =>
      pricingCards({ columns: ['Flexible', 'Pro I', 'Pro II'], ports: [{ name, rows }] })
    const minimum = { label: 'MINIMUM FEE', values: ['$0', '$50', '$150'] }
    const requests = { label: 'PER 100K REQUESTS', values: ['$0.30', '$0.26', '$0.23'] }
    assert.throws(
      port('Kupo', [minimum, { label: 'MINIMUM FEE / MONTH', values: ['$0', '$60', '$150'] }, requests]),
      /^Error: Kupo: wanted one "MINIMUM FEE" row, found MINIMUM FEE, MINIMUM FEE \/ MONTH, PER 100K REQUESTS$/,
    )
    assert.throws(
      port('Ogmios', [minimum, { label: 'PER 100K MESSAGES', values: ['$0.30', '$0.26', '$0.23'] }, { label: 'PER 24H OF CONNECTION', values: ['$0.23', '$0.20', '$0.17'] }]),
      /^Error: Ogmios: wanted one usage row \("PER …"\), found MINIMUM FEE, PER 100K MESSAGES, PER 24H OF CONNECTION$/,
    )
  })

  it('names a row and the cell it cannot read, wherever the row is', () => {
    // Read as text, the first would be a port named "APPROX. DAILY REQUESTS",
    // the second an Ogmios with no minimum fee row, and the third dropped.
    const daily = edit(pricingPage, '>1,700,000<', '>1.7M<', '>Kupo<')
    assert.throws(() => readPricingTable(daily), { message: '/pricing Kupo, row "APPROX. DAILY REQUESTS": cannot read "1.7M" in the Flexible column' })
    const free = edit(pricingPage, '>$0<', '>Free<', '>Ogmios<')
    assert.throws(() => readPricingTable(free), { message: '/pricing Ogmios, row "MINIMUM FEE": cannot read "Free" in the Flexible column' })
    const last = edit(pricingPage, '>300<', '>300+<', '>UTxO RPC<')
    assert.throws(() => readPricingTable(last), { message: '/pricing UTxO RPC, row "MAX REQUESTS / SECOND": cannot read "300+" in the Pro II column' })
  })

  it('refuses a port, a column or a unit it cannot place', () => {
    assert.throws(() => pricingCards(readPricingTable(edit(pricingPage, '>Kupo<', '>Dolos<'))), /website2 prices "Dolos"/)
    assert.throws(() => pricingCards(readPricingTable(edit(pricingPage, '>Pro II<', '>Scale<'))), /"Scale" column/)
    assert.throws(() => pricingCards(readPricingTable(edit(pricingPage, 'PER 100K REQUESTS', 'PER 1M REQUESTS', '>Kupo<'))), /PER 1M REQUESTS/)
    assert.throws(() => readPricingTable('<p>Pricing</p>'), /no "PORT \/ METRIC" table header/)
  })

  it('reads the live landing cards as a quote for every listed port', () => {
    const cards = landingCards(homePage, ['kupo', 'ogmios'])
    assert.equal(cards.length, 6)
    const flexible = cards.find((c) => c.port === 'ogmios' && c.tier === '1')!
    assert.equal(flexible.minimum_usd, 0)
    near(flexible.per_100k_usd, 0.3)
    assert.equal(cards.find((c) => c.port === 'kupo' && c.tier === '2')!.minimum_usd, 50)
    assert.equal(cards.find((c) => c.port === 'kupo' && c.tier === '3')!.minimum_usd, 150)
  })

  it('refuses a landing page without its price cards, or with two of one', () => {
    assert.throws(() => landingCards('<p>FLEXIBLE</p>', ['kupo']), /0 "FLEXIBLE" price cards/)
    assert.throws(() => landingCards(homePage + homePage, ['kupo']), /^Error: the landing page has 2 "FLEXIBLE" price cards, wanted 1$/)
  })

  it('refuses a landing card whose minimum fee it cannot read, rather than read none', () => {
    const home = edit(homePage, 'Minimum fee $50', 'Minimum fee: $60', '>PRO I<')
    assert.throws(() => landingCards(home, ['kupo']), /^Error: landing card PRO I: cannot read a minimum fee in "Minimum fee: \$60 once you reserve throughput"$/)
  })
})
