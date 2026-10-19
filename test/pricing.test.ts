import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { pricing } from '../src/checks/pricing.ts'
import { environments } from '../src/env.ts'
import { Run } from '../src/report.ts'
import { fetchMetadataPath } from '../src/surfaces/fabric.ts'
import { pricingCards, readPricingTable } from '../src/surfaces/website2.ts'
import { edit, fetchMetadataBody, live, type Served, serve, serveH2c } from './helpers.ts'

const pricingPage = live('pricing.html')
const homePage = live('home.html')

const kinds: Record<string, string> = { ogmios: 'OgmiosPort', kupo: 'KupoPort', blockfrost: 'BlockfrostPort', utxorpc: 'UtxoRpcPort' }

/** fabric's records for the ports the captured `/pricing` table prices, billing what it quotes, save one `delta`. */
function billing(change?: { port: string; tier: string; delta: number }) {
  const plans = new Map<string, Record<string, unknown>>()
  for (const c of pricingCards(readPricingTable(pricingPage.toString('utf8')))) {
    const delta = change?.port === c.port && change.tier === c.tier ? change.delta : c.per_100k_usd! / 100_000
    plans.set(c.port, { ...plans.get(c.port), [c.tier]: { dns: 'dmtr.host', cost: { minimum: c.minimum_usd, delta } } })
  }
  return fetchMetadataBody([...plans].map(([port, plan]) => ({ kind: kinds[port]!, extra: { 3: JSON.stringify(plan) } })))
}

describe('the pricing check, against local surfaces', () => {
  let website: Served
  let fabric: Served
  let metadata: Uint8Array
  let home = homePage

  before(async () => {
    website = await serve((request, response) => {
      const page = { '/pricing': pricingPage, '/': home }[request.url ?? '']
      if (page) response.writeHead(200, { 'content-type': 'text/html' }).end(page)
      else response.writeHead(404).end()
    })
    fabric = await serveH2c((request, response) => {
      if (request.method !== 'POST' || request.url !== fetchMetadataPath) return void response.writeHead(404).end()
      response.writeHead(200, { 'content-type': 'application/grpc-web+proto' }).end(metadata)
    })
  })

  after(async () => {
    await website.close()
    await fabric.close()
  })

  async function check() {
    const run = new Run('pricing', 'local')
    await pricing.run({ env: { ...environments.production, name: 'local', website: website.url, rpc: fabric.url }, run })
    return run.finish()
  }

  it('passes when fabric bills what website2 quotes', async () => {
    metadata = billing()
    const result = await check()
    assert.equal(result.ok, true, JSON.stringify(result.steps, null, 2))
    assert.equal(result.steps.at(-1)!.detail, 'every surface agrees with fabric')
  })

  it("compares website2 with fabric's prices, naming the divergence", async () => {
    metadata = billing({ port: 'blockfrost', tier: '1', delta: 0.0000035 })
    const compared = (await check()).steps.at(-1)!
    assert.equal(compared.ok, false)
    assert.equal(compared.detail, '1 divergence:\nBlockfrost Flexible per 100k: fabric $0.35 · website2 $0.30 · website2 landing $0.30')
  })

  it('fails when fabric publishes no prices, as production does today, and still compares website2 with itself', async () => {
    metadata = new Uint8Array(live('fetch-metadata.bin'))
    const result = await check()
    assert.equal(result.ok, false)
    assert.deepEqual(result.steps.map((s) => s.ok), [false, true, true, true])
    assert.match(result.steps[0]!.detail, /^fabric's live metadata publishes no prices/)
    assert.equal(result.steps[3]!.detail, 'website2 and website2 landing agree; fabric not compared, could not be read')
  })

  it('still compares fabric with /pricing when the landing cards cannot be read', async () => {
    home = Buffer.from(edit(homePage.toString('utf8'), 'Minimum fee $50', 'Minimum fee: $50', '>PRO I<'))
    try {
      metadata = billing({ port: 'blockfrost', tier: '1', delta: 0.0000006 })
      const diverged = await check()
      assert.deepEqual(diverged.steps.map((s) => s.ok), [true, true, false, false])
      assert.match(diverged.steps[2]!.detail, /^landing card PRO I: cannot read a minimum fee/)
      assert.equal(diverged.steps[3]!.detail, '1 divergence:\nBlockfrost Flexible per 100k: fabric $0.06 · website2 $0.30')

      metadata = billing()
      const agreed = (await check()).steps[3]!
      assert.equal(agreed.ok, true)
      assert.equal(agreed.detail, 'fabric and website2 agree; website2 landing not compared, could not be read')
    } finally {
      home = homePage
    }
  })
})
