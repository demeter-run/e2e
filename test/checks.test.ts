import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { loginLinks, type PageLinks } from '../src/checks/intent.ts'
import { environments } from '../src/env.ts'
import { anchors } from '../src/html.ts'
import { compare } from '../src/surfaces/card.ts'
import { landingCards, pricingCards, readPricingTable } from '../src/surfaces/website2.ts'
import { edit, live, preRateCard } from './helpers.ts'

const { website, console: consoleUrl } = environments.production
const pricingPage = live('pricing.html').toString('utf8')
const homePage = live('home.html').toString('utf8')

/** website2's quotes, from the captured pages or edited copies of them. */
function website2(pricing = pricingPage, home = homePage) {
  const table = pricingCards(readPricingTable(pricing))
  return { website2: table, 'website2 landing': landingCards(home, [...new Set(table.map((c) => c.port))]) }
}

describe('pricing comparison', () => {
  it('agrees when fabric bills what the live pages quote', () => {
    const quotes = website2()
    assert.deepEqual(compare(quotes.website2, quotes), [])
  })

  it('names a changed Blockfrost Flexible rate in exactly one line', () => {
    const billed = website2().website2
    const quotes = website2(edit(pricingPage, '>$0.30<', '>$0.35<', '>Blockfrost<'))
    assert.deepEqual(compare(billed, quotes), ['Blockfrost Flexible per 100k: fabric $0.30 · website2 $0.35 · website2 landing $0.30'])
  })

  it('fails on the numbers before the rate-card rollout, naming Blockfrost Flexible', () => {
    const { fabric, ...quotes } = preRateCard
    const lines = compare(fabric, quotes)
    assert.ok(lines.includes('Blockfrost Flexible per 100k: fabric $0.06 · website2 landing $0.28'), lines.join('\n'))
    assert.ok(lines.includes('Blockfrost Flexible: website2 publishes no price'))
    assert.ok(lines.includes('UTxO RPC Flexible: website2 landing charges $0 minimum and $0.28 per 100k; fabric bills nothing (no cost block)'))
  })

  it('flags a quote fabric does not bill: the UTxO RPC incident', () => {
    const lines = compare([{ port: 'utxorpc', tier: '1', minimum_usd: null, per_100k_usd: null }], {
      website2: [{ port: 'utxorpc', tier: '1', minimum_usd: 0, per_100k_usd: 0.28 }],
    })
    assert.ok(lines.includes('UTxO RPC Flexible: website2 charges $0 minimum and $0.28 per 100k; fabric bills nothing (no cost block)'))
  })

  it('accepts a free quote for a tier fabric bills nothing', () => {
    const lines = compare([{ port: 'marlowe', tier: '0', minimum_usd: null, per_100k_usd: null }], {
      console: [{ port: 'marlowe', tier: '0', minimum_usd: 0, per_100k_usd: 0 }],
    })
    assert.deepEqual(lines.filter((l) => l.startsWith('Marlowe')), [])
  })

  it('flags a card port a surface stops pricing, and a port fabric has never heard of', () => {
    const lines = compare([], { website2: [{ port: 'hydra', tier: '2', minimum_usd: 10, per_100k_usd: 1 }] })
    assert.ok(lines.includes('Kupo Flexible: website2 publishes no price'))
    assert.ok(lines.includes('hydra Pro I: website2 charges $10 minimum and $1 per 100k; fabric has no such port'))
  })

  it('compares the quoting surfaces with each other when fabric cannot be read', () => {
    assert.deepEqual(compare(null, website2()), [])
    const lines = compare(null, website2(pricingPage, edit(homePage, '>$0.26<', '>$0.25<', '>PRO I<')))
    assert.equal(lines.length, 4)
    assert.ok(lines.includes('Kupo Pro I per 100k: website2 $0.26 · website2 landing $0.25'))
  })
})

describe('intent links on the live pages', () => {
  const pages = (home = homePage, pricing = pricingPage): PageLinks[] => [
    { page: '/', anchors: anchors(home, `${website}/`) },
    { page: '/pricing', anchors: anchors(pricing, `${website}/pricing`) },
  ]

  it('pass on the pages as captured', () => {
    const links = loginLinks(pages(), consoleUrl)
    assert.deepEqual([links.intents, links.signup, links.signin], [[], [], []])
    // "Sign up" ×4, "Start building", "$ get started" and "Start free" on /, "Start free" on /pricing.
    assert.equal(links.signups, 8)
    assert.equal(links.signins, 1)
  })

  it('fail when a CTA sends a value the Console ignores', () => {
    const home = edit(homePage, 'login?intent=signup', 'login?intent=sign-up', 'Open console')
    const links = loginLinks(pages(home), consoleUrl)
    assert.deepEqual(links.intents, ['/: "Start building" → https://console.demeter.run/login?intent=sign-up sends intent=sign-up, which the Console ignores'])
    assert.deepEqual(links.signup, ['/: "Start building" → https://console.demeter.run/login?intent=sign-up, wanted https://console.demeter.run/login?intent=signup'])
  })

  it('fail when a sign-up CTA drops the intent, or sign-in gains one', () => {
    const pricing = edit(edit(pricingPage, 'login?intent=signup"', 'login"'), 'login"', 'login?intent=signup"')
    const links = loginLinks(pages(homePage, pricing), consoleUrl)
    assert.deepEqual(links.signup, ['/pricing: "Start free" → https://console.demeter.run/login, wanted https://console.demeter.run/login?intent=signup'])
    assert.deepEqual(links.signin, ['/pricing: "Sign in" → https://console.demeter.run/login?intent=signup, wanted https://console.demeter.run/login'])
  })

  it('fail when no sign-up CTA can be found', () => {
    const links = loginLinks([{ page: '/', anchors: [] }], consoleUrl)
    assert.deepEqual(links.signup, ['no sign-up CTA on /: the page or this reader changed'])
  })
})
