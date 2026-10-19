import { chromium } from '@playwright/test'
import { type Anchor, anchors } from '../html.ts'
import { describeAnswer, probe, readPage, safeUrl } from '../http.ts'
import type { Check } from './check.ts'

/**
 * `intent=signup` is a magic string shared by two deployables: website2 builds
 * it into its sign-up CTAs, and the Console's login route turns it into
 * Auth0's `screen_hint=signup`. Neither side fails when the other changes: an
 * intent the Console does not recognise falls through to the login screen, and
 * Classic Universal Login ignores `screen_hint` without a word
 * (website2-console-auth-ctas, 2026-07-31). This check is what fails instead,
 * reading only what is deployed.
 */

/** A sign-up CTA, by what a visitor reads on it. */
const signupText = /\b(sign\s*up|start building|get started|start free)\b/i
/** A sign-in link, by what a visitor reads on it. */
const signinText = /\b(sign\s*in|log\s*in)\b/i

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

export interface PageLinks {
  /** The page's path, for messages. */
  page: string
  anchors: Anchor[]
}

const show = (page: string, a: Anchor) => `${page}: "${a.text}" → ${a.href}`

const atLogin = (href: string, login: string): URL | null => {
  const url = new URL(href)
  return `${url.origin}${url.pathname}` === login ? url : null
}

/**
 * What website2's pages send to the Console's `/login`. Each list is the
 * problems found, empty when the rule holds; `signups` and `signins` count the
 * links each rule looked at.
 */
export function loginLinks(pages: PageLinks[], consoleUrl: string) {
  const login = `${consoleUrl}/login`
  const intents: string[] = []
  const signup: string[] = []
  const signin: string[] = []
  let signups = 0
  let signins = 0
  for (const { page, anchors } of pages) {
    for (const a of anchors) {
      const url = atLogin(a.href, login)
      const intent = url?.searchParams.get('intent') ?? null
      // The Console recognises signup and nothing else (src/app/routes/login.tsx).
      if (url && intent !== null && intent !== 'signup') intents.push(`${show(page, a)} sends intent=${intent}, which the Console ignores`)
      if (signupText.test(a.text)) {
        signups += 1
        if (!url || intent !== 'signup') signup.push(`${show(page, a)}, wanted ${login}?intent=signup`)
      } else if (signinText.test(a.text)) {
        signins += 1
        if (!url || url.search !== '') signin.push(`${show(page, a)}, wanted ${login}`)
      }
    }
  }
  if (signups === 0) signup.push(`no sign-up CTA on ${pages.map((p) => p.page).join(' or ')}: the page or this reader changed`)
  return { intents, signup, signin, signups, signins }
}

export const intent: Check = {
  name: 'intent',
  summary: "website2's sign-up CTAs send an intent the Console honours, and it reaches Auth0's signup screen",
  async run({ env, run }) {
    const pages: PageLinks[] = []
    let links: ReturnType<typeof loginLinks> | undefined

    await run.step(`read the links on ${env.website}/ and /pricing`, async () => {
      for (const page of ['/', '/pricing']) {
        let body: string
        try {
          body = await readPage(`${env.website}${page}`)
        } catch (error) {
          throw new Error(`${page}: ${(error as Error).message}`)
        }
        pages.push({ page, anchors: anchors(body, `${env.website}${page}`) })
      }
      links = loginLinks(pages, env.console)
      return pages.map((p) => `${p.page}: ${p.anchors.length} links`).join(', ')
    })

    await run.step("every link to the Console's /login sends no intent or intent=signup", () => {
      if (!links) throw new Error('not checked: the pages could not be read')
      if (links.intents.length) throw new Error(links.intents.join('\n'))
    })

    await run.step(`every sign-up CTA goes to ${env.console}/login?intent=signup`, () => {
      if (!links) throw new Error('not checked: the pages could not be read')
      if (links.signup.length) throw new Error(links.signup.join('\n'))
      return `${links.signups} CTAs`
    })

    await run.step(`every sign-in link goes to ${env.console}/login with no intent`, () => {
      if (!links) throw new Error('not checked: the pages could not be read')
      if (links.signin.length) throw new Error(links.signin.join('\n'))
      return links.signins ? `${links.signins} link${links.signins === 1 ? '' : 's'}` : 'no sign-in link on these pages'
    })

    // The Console answers /login with a redirect to Auth0's /authorize. It is
    // read, not followed: the authorize URL is the Console's whole contribution.
    for (const [query, wantHint] of [['?intent=signup', 'signup'], ['', null]] as const) {
      await run.step(`${env.console}/login${query} redirects to Auth0 ${wantHint ? 'with' : 'without'} screen_hint=signup`, async () => {
        const answer = await probe(`${env.console}/login${query}`)
        const where = safeUrl(answer.location, ['screen_hint'])
        if (answer.status === null || answer.error) throw new Error(describeAnswer(answer))
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
