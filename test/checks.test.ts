import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { authScreen, loginLinks, type PageLinks, type ScreenPage } from '../src/checks/intent.ts'
import { environments } from '../src/env.ts'
import { anchors } from '../src/html.ts'
import { type Card, compare } from '../src/surfaces/card.ts'
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

  it('flags a card port a surface leaves out on any tier 1–3, or prices with no minimum fee', () => {
    const { website2: table } = website2()
    const quoted = table
      .filter((c) => !(c.port === 'kupo' && c.tier === '3') && !(c.port === 'blockfrost' && c.tier === '2'))
      .map((c) => (c.port === 'ogmios' && c.tier === '1' ? { ...c, minimum_usd: null } : c))
    assert.deepEqual(compare(table, { website2: quoted }), [
      'Blockfrost Pro I: website2 publishes no price',
      'Kupo Pro II: website2 publishes no price',
      'Ogmios Flexible: website2 publishes no minimum fee',
    ])
  })

  it('flags a minimum fee alone, for a tier fabric bills nothing', () => {
    const lines = compare(
      [{ port: 'marlowe', tier: '2', minimum_usd: null, per_100k_usd: null }],
      { console: [{ port: 'marlowe', tier: '2', minimum_usd: 50, per_100k_usd: 0 }] },
      { owes: { console: [] } },
    )
    assert.deepEqual(lines, ['Marlowe Pro I: console charges $50 minimum and $0 per 100k; fabric bills nothing (no cost block)'])
  })

  it("treats prices within 0.1% as the same, fabric's four significant digits, and nothing wider", () => {
    const kupoProI = (minimum_usd: number, per_100k_usd: number): Card[] => [{ port: 'kupo', tier: '2', minimum_usd, per_100k_usd }]
    const loose = { owes: { website2: [] } }
    // $1.20 a day of connection, as fabric stores it: 0.000013889 per second.
    assert.deepEqual(compare(kupoProI(50, 0.000013889 * 100_000), { website2: kupoProI(50, (1.2 / 86_400) * 100_000) }, loose), [])
    assert.deepEqual(compare(kupoProI(50, 0.26), { website2: kupoProI(50, 0.2602) }, loose), [])
    assert.deepEqual(compare(kupoProI(50, 0.26), { website2: kupoProI(50, 0.2606) }, loose), ['Kupo Pro I per 100k: fabric $0.26 · website2 $0.2606'])
    assert.deepEqual(compare(kupoProI(150, 0.26), { website2: kupoProI(146, 0.26) }, loose), ['Kupo Pro I minimum: fabric $150 · website2 $146'])
  })

  it("serves J2's Console leg, which owes its one resource's port on tiers 1–3", () => {
    const { website2: billed } = website2()
    const blockfrost = billed.filter((c) => c.port === 'blockfrost')
    const owes = { owes: { console: ['blockfrost'] } }
    assert.equal(compare(billed, { console: blockfrost }).length, 9, 'by default a surface owes every card port')
    assert.deepEqual(compare(billed, { console: blockfrost }, owes), [])
    const drifted = blockfrost.filter((c) => c.tier !== '3').map((c) => (c.tier === '1' ? { ...c, per_100k_usd: 0.28 } : c))
    assert.deepEqual(compare(billed, { console: drifted }, owes), [
      'Blockfrost Flexible per 100k: fabric $0.30 · console $0.28',
      'Blockfrost Pro II: console publishes no price',
    ])
  })

  it('flags a port a surface prices twice, rather than compare its last price only', () => {
    // Blockfrost at $0.35, then the pre-rate-card name at fabric's $0.30: the last alone agrees.
    const billed = website2().website2
    const table = readPricingTable(pricingPage)
    const blockfrost = table.ports.find((p) => p.name === 'Blockfrost')!
    const raised = { ...blockfrost, rows: blockfrost.rows.map((r) => (r.label.startsWith('PER ') ? { ...r, values: ['$0.35', ...r.values.slice(1)] } : r)) }
    const quoted = pricingCards({ ...table, ports: [...table.ports.map((p) => (p === blockfrost ? raised : p)), { ...blockfrost, name: 'Blockfrost RYO' }] })
    assert.deepEqual(compare(billed, { website2: quoted }), [
      'Blockfrost Flexible: website2 states it 2 times, $0 minimum and $0.35 per 100k · $0 minimum and $0.30 per 100k',
      'Blockfrost Pro I: website2 states it 2 times, $50 minimum and $0.26 per 100k · $50 minimum and $0.26 per 100k',
      'Blockfrost Pro II: website2 states it 2 times, $150 minimum and $0.23 per 100k · $150 minimum and $0.23 per 100k',
    ])
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

  it('fail a CTA whose link is not a URL, rather than skip it', () => {
    const home = edit(homePage, 'https://console.demeter.run/login', 'https://console.demeter.run /login', 'Open console')
    const links = loginLinks(pages(home), consoleUrl)
    assert.equal(links.signups, 8)
    assert.deepEqual(links.signup, [
      '/: "Start building" → "https://console.demeter.run /login?intent=signup", which is not a URL, wanted https://console.demeter.run/login?intent=signup',
    ])
  })

  it('fail every Console link that is not a URL, the sign-in link included', () => {
    const broken = (page: string) => page.replaceAll('https://console.demeter.run/', 'https://console.demeter.run /')
    const links = loginLinks(pages(broken(homePage), broken(pricingPage)), consoleUrl)
    assert.deepEqual([links.signups, links.signup.length], [8, 8])
    assert.deepEqual(links.signin, ['/pricing: "Sign in" → "https://console.demeter.run /login", which is not a URL, wanted https://console.demeter.run/login'])
  })

  it('fail a sign-up or sign-in link that goes anywhere but the Console\'s /login', () => {
    const offSite: PageLinks = {
      page: '/',
      anchors: [
        { href: 'https://console.demeter.run/signup', text: 'Start building' },
        { href: 'https://demeter.run/auth', text: 'Sign in' },
      ],
    }
    const links = loginLinks([offSite], consoleUrl)
    assert.deepEqual(links.signup, ['/: "Start building" → https://console.demeter.run/signup, wanted https://console.demeter.run/login?intent=signup'])
    assert.deepEqual(links.signin, ['/: "Sign in" → https://demeter.run/auth, wanted https://console.demeter.run/login'])
  })
})

describe("intent's browser steps", () => {
  /** A stand-in for a Playwright page: what it answered, where it ended up, and its heading, if any. */
  const page = ({ status = 200, url = '', title = '', heading = null as string | null, goto = null as Error | null }) =>
    ({
      goto: async () => {
        if (goto) throw goto
        return { status: () => status }
      },
      url: () => url,
      title: async () => title,
      locator: () => ({
        first: () => ({
          waitFor: async () => {
            if (heading === null) throw new Error('\x1b[2mlocator.waitFor: Timeout 10ms exceeded.\x1b[22m\nCall log:\n  - waiting for locator(\'h1\').first() to be visible')
          },
          innerText: async () => ` ${heading} `,
        }),
      }),
    }) as unknown as ScreenPage

  const login = 'https://console.demeter.run/login?intent=signup'

  it("read the screen's path, title and heading", async () => {
    const signup = page({ url: 'https://txpipe.us.auth0.com/u/signup?state=s3cr3t', title: 'Sign up | Demeter.run', heading: 'Welcome' })
    assert.deepEqual(await authScreen(signup, login, 10), { path: '/u/signup', title: 'Sign up | Demeter.run', heading: 'Welcome' })
  })

  it('say where they landed, its status and title, when the page has no heading', async () => {
    const limited = page({ status: 429, url: 'https://txpipe.us.auth0.com/u/signup?state=s3cr3t', title: 'Too Many Requests' })
    await assert.rejects(authScreen(limited, login, 10), {
      message: 'https://txpipe.us.auth0.com/u/signup answered 429, title "Too Many Requests", and shows no heading after 0.01 s',
    })
  })

  it('report a failed navigation on one line, without terminal colours', async () => {
    const refused = page({ goto: new Error('\x1b[31mpage.goto: net::ERR_CONNECTION_REFUSED at https://console.demeter.run/login\x1b[39m\nCall log:\n  - navigating to …') })
    await assert.rejects(authScreen(refused, login, 10), {
      message: 'https://console.demeter.run/login: page.goto: net::ERR_CONNECTION_REFUSED at https://console.demeter.run/login',
    })
  })
})
