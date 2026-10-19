import { type Answer, probe, safeUrl } from '../http.ts'
import type { Check } from './check.ts'

/**
 * The apex contract, moved here from `cutover.sh verify` in the cutover-apex
 * skill (`probe` at `cutover.sh:174-187`, `verify` at `:258-286`). When
 * website2 took `demeter.run`, the legacy app kept `/auth`, `/callbacks` and
 * `/webhooks` on the apex, and its pages moved to `legacy.demeter.run`.
 *
 * Same semantics as the script: one request each, no redirect followed, 15 s
 * to answer (20 s for the page body). Where the script printed a `Location`
 * without checking it, it is asserted here.
 */

type Want = number | 'not404'

function expect(answer: Answer, want: Want, location?: (l: URL) => boolean, locationWanted?: string): string {
  const where = answer.location ? ` → ${safeUrl(answer.location)}` : ''
  if (answer.status === null) throw new Error(`no answer within 15 s, wanted ${want}`)
  if (want === 'not404' ? answer.status === 404 : answer.status !== want) {
    throw new Error(`${answer.status}${where}, wanted ${want === 'not404' ? 'anything but 404' : want}`)
  }
  if (location && !(answer.location && location(new URL(answer.location)))) {
    throw new Error(`${answer.status}${where}, wanted Location ${locationWanted}`)
  }
  return `${answer.status}${where}`
}

const at = (base: string, path: string) => (l: URL) => `${l.origin}${l.pathname}` === `${base}${path}`

export const apex: Check = {
  name: 'apex',
  summary: 'demeter.run serves website2 and keeps the legacy endpoints the cutover left on it',
  mode: 'live',
  async run({ env, run }) {
    if (!env) throw new Error('apex only runs live: pass --env')
    const site = env.website
    const legacy = env.legacy

    // cutover.sh:266-267. website2 emits /assets/*.js modulepreloads, the
    // legacy Remix app /build/_assets/*: the only reliable teller, since both
    // answer with the same <title>. The SSR shell carries stray NUL bytes.
    await run.step(`${site}/ is served by website2`, async () => {
      const answer = await probe(`${site}/`, { timeoutMs: 20_000, readBody: true })
      if (answer.status === null) throw new Error('no answer within 20 s')
      if (!answer.body.replaceAll('\0', '').includes('modulepreload" href="/assets/')) {
        throw new Error(`${answer.status}, no website2 modulepreload (legacy shell or error)`)
      }
      return `${answer.status}, website2 shell`
    })

    // cutover.sh:274.
    await run.step(`${site}/pricing answers 200`, async () => expect(await probe(`${site}/pricing`), 200))

    // cutover.sh:275. The legacy login: a redirect to the Auth0 tenant's
    // /authorize, which the script printed but never checked.
    await run.step(`${site}/auth redirects 302 to Auth0`, async () =>
      expect(await probe(`${site}/auth`), 302, at(env.auth0, '/authorize'), `${env.auth0}/authorize`),
    )

    // cutover.sh:276. The legacy Auth0 callback. Called without an
    // authorization code it fails the way a failed login does, to the legacy
    // app's /error, which website2 forwards to the legacy host
    // (website2's legacy-redirects.mjs keeps /error for this branch).
    await run.step(`${site}/callbacks/auth0 redirects 302 to the login failure page`, async () =>
      expect(await probe(`${site}/callbacks/auth0`), 302, at(site, '/error'), `${site}/error`),
    )

    // cutover.sh:277. Stripe's webhook: anything but 404 or no answer. An
    // unsigned GET errors in the app (500 today), which proves it reaches it.
    await run.step(`${site}/webhooks/stripe reaches the legacy app`, async () =>
      expect(await probe(`${site}/webhooks/stripe`), 'not404'),
    )

    // cutover.sh:278. The install line in every README; a 302 because the
    // target is whatever the latest release is.
    const installer = 'https://github.com/demeter-run/cli/releases/latest/download/dmtrctl-installer.sh'
    await run.step(`${site}/install/dmtrctl.sh redirects 302 to the latest dmtrctl installer`, async () =>
      expect(await probe(`${site}/install/dmtrctl.sh`), 302, (l) => l.toString() === installer, installer),
    )

    // cutover.sh:279. A legacy page: website2 forwards it, path intact, to the
    // legacy host.
    await run.step(`${site}/faq redirects 301 to the legacy site`, async () =>
      expect(await probe(`${site}/faq`), 301, at(legacy, '/faq'), `${legacy}/faq`),
    )

    // cutover.sh:280. A legacy port page, forwarded the same way.
    await run.step(`${site}/ports/cardano-ogmios-port redirects 301 to the legacy site`, async () =>
      expect(
        await probe(`${site}/ports/cardano-ogmios-port`),
        301,
        at(legacy, '/ports/cardano-ogmios-port'),
        `${legacy}/ports/cardano-ogmios-port`,
      ),
    )

    // cutover.sh:281. A static asset website2 serves itself.
    await run.step(`${site}/assets/logos/favicon.ico answers 200`, async () =>
      expect(await probe(`${site}/assets/logos/favicon.ico`), 200),
    )

    // cutover.sh:282. The legacy site, on its own host.
    await run.step(`${legacy}/faq answers 200`, async () => expect(await probe(`${legacy}/faq`), 200))
  },
}
