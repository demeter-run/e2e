/**
 * Single source for every link target on the site.
 *
 * `resolved` entries are the real hrefs the redesign names. The placeholders
 * the mock left at "#" were filled at the apex cutover, from the targets the
 * site this one replaced actually used — see the block at the bottom.
 *
 * Contact-shaped CTAs are not listed here: the apply/support buttons navigate
 * to `/contact` with the matching request type, so they are router targets in
 * the components, not hrefs.
 */

/**
 * The Demeter Console. Every auth-shaped CTA on this site funnels here: the
 * console owns the whole Auth0 mechanism and lands a visitor on the ports page
 * of a project, creating a first one for anyone who has none.
 *
 * A plain source constant rather than an env var — the deployment carries no
 * env plumbing (`k8s/deployment.yaml`), there is no staging console to point
 * at, and this site's discipline is content-as-data.
 */
const CONSOLE_URL = 'https://console.demeter.run'

export const links = {
  // resolved — named in the redesign
  status: 'https://demeter.statuspage.io/',
  // internal: the rebuilt site's own docs and contact pages. The docs were
  // docs.demeter.run, the legacy site; /docs replaced it as the place every
  // "docs" link on this site goes.
  docs: '/docs',
  contact: '/contact',

  // console auth funnel — `intent=signup` asks Auth0 for the signup screen
  // rather than the login screen; the console recognizes that single value.
  signUp: `${CONSOLE_URL}/login?intent=signup`,
  signIn: `${CONSOLE_URL}/login`,
  openConsole: `${CONSOLE_URL}/`,
  startBuilding: `${CONSOLE_URL}/login?intent=signup`,
  getStarted: `${CONSOLE_URL}/login?intent=signup`,

  // community — the accounts the legacy apex linked, carried over unchanged so
  // the cutover does not quietly move where visitors are sent.
  github: 'https://github.com/txpipe',
  discord: 'https://discord.gg/eVc6HJrYmP',
  twitter: 'https://twitter.com/DemeterRun',
  // the port operators themselves, which is what "open-source ports" means here
  openSourcePorts: 'https://github.com/demeter-run',

  // known issues are the status page's incident history; there is no separate
  // issues surface, and inventing one at the cutover would be worse than
  // pointing at the one that is actually maintained.
  knownIssues: 'https://demeter.statuspage.io/',

  // what a plan includes is answered by the detailed pricing table, which is
  // on this site. Free-tier eligibility used to point here too; it now has its
  // own page, and the CTAs that ask for it are router targets in the
  // components rather than an href here.
  whatsIncluded: '/pricing',
} as const

export type LinkKey = keyof typeof links
