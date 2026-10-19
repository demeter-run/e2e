import { chromium } from '@playwright/test'
import { environments } from '../env.ts'
import { probe, safeUrl } from '../http.ts'
import { readLoginRoute, recognisedIntents } from '../surfaces/console.ts'
import { loadLinks } from '../surfaces/website2.ts'
import type { Check } from './check.ts'

/**
 * `intent=signup` is a magic string shared by two repositories: website2
 * builds it into its sign-up CTAs, and the Console's login route turns it into
 * Auth0's `screen_hint=signup`. Neither side fails when the other changes: an
 * intent the Console does not recognise falls through to the login screen, and
 * Classic Universal Login ignores `screen_hint` without a word
 * (website2-console-auth-ctas, 2026-07-31). This check is what fails instead.
 */

/** The links.ts entries that are sign-up CTAs (`links.ts:35-39`). */
const signupCtas = ['signUp', 'startBuilding', 'getStarted']
/** The sign-in CTA, which must reach the login screen. */
const signinCta = 'signIn'

/**
 * How Auth0's New Universal Login tells its two screens apart, read from the
 * live tenant on 2026-10-19 by loading both Console redirects in Chromium. The
 * submit button reads "Continue" on both, so the heading, the page title and
 * the screen's path are what differ.
 */
export const auth0Screens = {
  signup: { path: '/u/signup', title: 'Sign up | Demeter.run', heading: 'Welcome' },
  login: { path: '/u/login', title: 'Log in | Demeter.run', heading: 'Welcome to Demeter.run' },
}

const intentOf = (href: string): string | null => {
  try {
    return new URL(href).searchParams.get('intent')
  } catch {
    return null
  }
}

export const intent: Check = {
  name: 'intent',
  summary: "website2's sign-up CTAs send an intent the Console recognises, and it reaches Auth0's signup screen",
  mode: 'mixed',
  async run({ env, sources, run }) {
    let recognised: string[] | undefined
    let links: Record<string, string> | undefined
    const consoleLogin = `${environments.production.console}/login`

    await run.step("read the Console's recognised intents", async () => {
      recognised = recognisedIntents(await readLoginRoute(await sources.dir('webui')))
      if (recognised.length === 0) throw new Error('login.tsx compares intent to no value: its handling moved, update this check')
      return `${await sources.describe('webui')}: ${recognised.join(', ')}`
    })

    await run.step("read website2's links", async () => {
      links = await loadLinks(await sources.dir('website2'))
      return `${await sources.describe('website2')}: ${Object.keys(links).length} links`
    })

    await run.step('every intent website2 sends is one the Console recognises', () => {
      if (!links || !recognised) throw new Error('not checked: a source could not be read')
      const sent = Object.entries(links).flatMap(([name, href]) => {
        const value = intentOf(href)
        return value === null ? [] : [[name, value] as const]
      })
      const unknown = sent.filter(([, value]) => !recognised!.includes(value))
      if (unknown.length) throw new Error(unknown.map(([name, value]) => `${name} sends intent=${value}, which the Console ignores`).join('\n'))
      return sent.map(([name, value]) => `${name}: intent=${value}`).join(', ') || 'no link sends an intent'
    })

    await run.step('every sign-up CTA carries intent=signup', () => {
      if (!links) throw new Error('not checked: links.ts could not be read')
      const names = new Set([...signupCtas, ...Object.keys(links).filter((n) => /sign.?up/i.test(n))])
      const problems: string[] = []
      for (const name of names) {
        const href = links[name]
        if (href === undefined) problems.push(`${name}: missing from links.ts`)
        else if (!href.startsWith(`${consoleLogin}?`) || intentOf(href) !== 'signup') problems.push(`${name}: ${href}, wanted ${consoleLogin}?intent=signup`)
      }
      if (problems.length) throw new Error(problems.join('\n'))
      return [...names].join(', ')
    })

    await run.step('the sign-in CTA carries no intent', () => {
      const href = links?.[signinCta]
      if (href === undefined) throw new Error(`${signinCta}: missing from links.ts`)
      if (href !== consoleLogin) throw new Error(`${signinCta}: ${href}, wanted ${consoleLogin}`)
      return `${signinCta}: ${href}`
    })

    if (!env) return

    // The Console answers /login with a redirect to Auth0's /authorize. It is
    // read, not followed: the authorize URL is the Console's whole contribution.
    for (const [query, wantHint] of [['?intent=signup', 'signup'], ['', null]] as const) {
      await run.step(`${env.console}/login${query} redirects to Auth0 ${wantHint ? 'with' : 'without'} screen_hint=signup`, async () => {
        const answer = await probe(`${env.console}/login${query}`)
        const where = safeUrl(answer.location, ['screen_hint'])
        if (answer.status === null) throw new Error('no answer within 15 s')
        if (answer.status < 300 || answer.status > 399 || !answer.location) throw new Error(`${answer.status}, wanted a redirect to ${env.auth0}/authorize`)
        const location = new URL(answer.location)
        if (`${location.origin}${location.pathname}` !== `${env.auth0}/authorize`) throw new Error(`${answer.status} → ${where}, wanted ${env.auth0}/authorize`)
        if (location.searchParams.get('screen_hint') !== wantHint) throw new Error(`${answer.status} → ${where}, wanted ${wantHint ? 'screen_hint=signup' : 'no screen_hint'}`)
        return `${answer.status} → ${where}`
      })
    }

    // The login-versus-signup edge case: Classic Universal Login drops
    // screen_hint silently, so only the screen Auth0 renders proves the hint
    // landed. Each Console redirect is followed in a browser to Auth0's form.
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
    try {
      for (const [query, screen] of [['?intent=signup', 'signup'], ['', 'login']] as const) {
        await run.step(`${env.console}/login${query} shows Auth0's ${screen} form`, async () => {
          browser ??= await chromium.launch()
          const page = await browser.newPage()
          try {
            await page.goto(`${env.console}/login${query}`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
            const heading = page.locator('h1').first()
            await heading.waitFor({ timeout: 30_000 })
            const seen = {
              path: new URL(page.url()).pathname,
              title: await page.title(),
              heading: (await heading.innerText()).trim(),
            }
            const want = auth0Screens[screen]
            const off = (Object.keys(want) as (keyof typeof want)[]).filter((k) => seen[k] !== want[k])
            const shown = `${safeUrl(page.url())}, title "${seen.title}", heading "${seen.heading}"`
            if (off.length) throw new Error(`${shown}; wanted ${off.map((k) => `${k} "${want[k]}"`).join(', ')}`)
            return shown
          } finally {
            await page.close()
          }
        })
      }
    } finally {
      await browser?.close()
    }
  },
}
