import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import type { Check } from '../src/checks/check.ts'
import { endpointParity } from '../src/checks/endpoint-parity.ts'
import { intent } from '../src/checks/intent.ts'
import { compare, pricing, type Quotes } from '../src/checks/pricing.ts'
import { Run } from '../src/report.ts'
import { Sources } from '../src/sources.ts'
import { consoleCards, loadConsolePricing } from '../src/surfaces/console.ts'
import { fabricCards, readFabricTiers } from '../src/surfaces/fabric.ts'
import { landingCards, loadPlanTiers, loadPortPricing, portPricingCards } from '../src/surfaces/website2.ts'
import { copyFixtures, edit, fixture } from './helpers.ts'

async function quotes(root: string): Promise<Quotes> {
  const website2 = portPricingCards(await loadPortPricing(join(root, 'website2')))
  return {
    fabric: fabricCards(await readFabricTiers(join(root, 'fabric'))),
    console: consoleCards(await loadConsolePricing(join(root, 'webui'))),
    website2,
    landing: landingCards(await loadPlanTiers(join(root, 'website2')), [...new Set(website2.map((c) => c.port))]),
  }
}

/** Runs a check statically over a fixture tree, as `pnpm check` would. */
async function runCheck(check: Check, root: string) {
  const run = new Run(check.name, null)
  const sources = new Sources({ fabric: join(root, 'fabric'), webui: join(root, 'webui'), website2: join(root, 'website2') })
  await check.run({ env: null, sources, run })
  return run.finish()
}

describe('pricing comparison', () => {
  it('finds the divergences main carried when the fixtures were copied', async () => {
    // Marlowe is priced in the Console and billed nothing by fabric; Submit
    // API's Console prices are not fabric's. Both are non-card ports.
    assert.deepEqual(compare(await quotes(fixture())), [
      'Marlowe Flexible: console charges $0 minimum and $0.40 per 100k; fabric bills nothing (no cost block)',
      'Marlowe Pro I: console charges $200 minimum and $0.36 per 100k; fabric bills nothing (no cost block)',
      'Marlowe Pro II: console charges $400 minimum and $0.30 per 100k; fabric bills nothing (no cost block)',
      'Submit API Flexible per 100k: fabric $0.40 · console $9',
      'Submit API Pro I minimum: fabric $200 · console $25',
      'Submit API Pro I per 100k: fabric $0.36 · console $8',
      'Submit API Pro II minimum: fabric $400 · console $50',
      'Submit API Pro II per 100k: fabric $0.30 · console $7',
    ])
  })

  it('names a changed Blockfrost Flexible rate in exactly one new line', async () => {
    const baseline = compare(await quotes(fixture()))
    const dir = await copyFixtures()
    await edit(join(dir, 'webui/src/app/utils/pricing/values.ts'), 'usageBased: 0.30,', 'usageBased: 0.35,', "'cardano-blockfrost-port'")
    const added = compare(await quotes(dir)).filter((line) => !baseline.includes(line))
    assert.deepEqual(added, ['Blockfrost Flexible per 100k: fabric $0.30 · console $0.35 · website2 $0.30 · website2 landing $0.30'])
  })

  it('agrees when every surface states the same card', () => {
    const card = { port: 'kupo', tier: '1', minimum_usd: 0, per_100k_usd: 0.3 }
    const others = ['ogmios', 'blockfrost', 'utxorpc'].flatMap((port) =>
      ['1', '2', '3'].map((tier) => ({ port, tier, minimum_usd: 50, per_100k_usd: 0.26 })),
    )
    const all = [card, { ...card, tier: '2' }, { ...card, tier: '3' }, ...others]
    assert.deepEqual(compare({ fabric: all, console: all, website2: all, landing: all }), [])
  })

  it('flags a quote fabric does not bill: the UTxO RPC incident', () => {
    const quoted = { port: 'utxorpc', tier: '1', minimum_usd: 0, per_100k_usd: 0.28 }
    const lines = compare({
      fabric: [{ port: 'utxorpc', tier: '1', minimum_usd: null, per_100k_usd: null }],
      console: [],
      website2: [quoted],
      landing: [],
    })
    assert.ok(lines.includes('UTxO RPC Flexible: website2 charges $0 minimum and $0.28 per 100k; fabric bills nothing (no cost block)'))
  })

  it('accepts a free quote for a tier fabric bills nothing', () => {
    const free = { port: 'marlowe', tier: '0', minimum_usd: 0, per_100k_usd: 0 }
    const unpriced = { port: 'marlowe', tier: '0', minimum_usd: null, per_100k_usd: null }
    assert.deepEqual(
      compare({ fabric: [unpriced], console: [free], website2: [], landing: [] }).filter((l) => l.startsWith('Marlowe')),
      [],
    )
  })

  it('flags a card port a surface stops pricing, and a port fabric has never heard of', () => {
    const lines = compare({
      fabric: [],
      console: [{ port: 'hydra', tier: '2', minimum_usd: 10, per_100k_usd: 1 }],
      website2: [],
      landing: [],
    })
    assert.ok(lines.includes('Kupo Flexible: website2 publishes no price'))
    assert.ok(lines.includes('hydra Pro I: console charges $10 minimum and $1 per 100k; fabric has no such port'))
  })
})

describe('checks over the fixtures', () => {
  it('pricing fails, listing each divergence on its own line', async () => {
    const result = await runCheck(pricing, fixture())
    assert.equal(result.ok, false)
    const compareStep = result.steps.find((s) => s.name === 'compare')!
    assert.equal(compareStep.ok, false)
    assert.match(compareStep.detail, /^8 divergences:\nMarlowe Flexible: /)
  })

  it('intent passes on the real links and login route', async () => {
    const result = await runCheck(intent, fixture())
    assert.deepEqual(
      result.steps.map((s) => [s.name, s.ok]),
      [
        ["read the Console's recognised intents", true],
        ["read website2's links", true],
        ['every intent website2 sends is one the Console recognises', true],
        ['every sign-up CTA carries intent=signup', true],
        ['the sign-in CTA carries no intent', true],
      ],
    )
  })

  it('intent fails when website2 sends a value the Console ignores', async () => {
    const dir = await copyFixtures()
    await edit(join(dir, 'website2/src/content/links.ts'), 'login?intent=signup', 'login?intent=sign-up', 'startBuilding')
    const result = await runCheck(intent, dir)
    const failed = result.steps.filter((s) => !s.ok)
    assert.deepEqual(
      failed.map((s) => s.detail),
      [
        'startBuilding sends intent=sign-up, which the Console ignores',
        'startBuilding: https://console.demeter.run/login?intent=sign-up, wanted https://console.demeter.run/login?intent=signup',
      ],
    )
  })

  it('intent fails when the Console stops recognising signup', async () => {
    const dir = await copyFixtures()
    await edit(join(dir, 'webui/src/app/routes/login.tsx'), "const SIGNUP_INTENT = 'signup'", "const SIGNUP_INTENT = 'register'")
    const result = await runCheck(intent, dir)
    assert.equal(result.steps.find((s) => s.name === 'every intent website2 sends is one the Console recognises')!.ok, false)
  })

  it('endpoint-parity passes on every CRD', async () => {
    const result = await runCheck(endpointParity, fixture())
    assert.equal(result.ok, true)
    assert.equal(result.steps.length, 13)
  })

  it('endpoint-parity fails on a tier with its own dns', async () => {
    const dir = await copyFixtures()
    await edit(join(dir, 'fabric/bootstrap/rpc/crds/blockfrostport.json'), '"dns": "demeter.run"', '"dns": "dmtr.host"', '"2"')
    const result = await runCheck(endpointParity, dir)
    const failed = result.steps.filter((s) => !s.ok)
    assert.deepEqual(
      failed.map((s) => `${s.name}: ${s.detail}`),
      ['blockfrostport: one dns on every tier: tiers disagree: 0 → demeter.run, 1 → demeter.run, 2 → dmtr.host, 3 → demeter.run'],
    )
  })
})
