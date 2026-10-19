import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { apex } from '../src/checks/apex.ts'
import { environments } from '../src/env.ts'
import { Run } from '../src/report.ts'
import { type Served, serve } from './helpers.ts'

const installer = 'https://github.com/demeter-run/cli/releases/latest/download/dmtrctl-installer.sh'

describe('the apex check, against a local apex and legacy host', () => {
  let site: Served
  let legacy: Served
  let installerLocation = `${installer}?utm_source=readme`

  before(async () => {
    legacy = await serve((request, response) => void response.writeHead(request.url === '/faq' ? 200 : 404).end())
    // The answers production gives today (README.md, "apex").
    site = await serve((request, response) => {
      const self = `http://${request.headers.host}`
      const answers: Record<string, [number, string?]> = {
        '/pricing': [200],
        '/auth': [302, `${environments.production.auth0}/authorize?client_id=x&state=y`],
        '/callbacks/auth0': [302, `${self}/error`],
        '/webhooks/stripe': [500],
        '/install/dmtrctl.sh': [302, installerLocation],
        '/faq': [301, `${legacy.url}/faq`],
        '/ports/cardano-ogmios-port': [301, `${legacy.url}/ports/cardano-ogmios-port`],
        '/assets/logos/favicon.ico': [200],
      }
      if (request.url === '/') return void response.writeHead(200).end('<link rel="modulepreload" href="/assets/index.js">')
      const [status, location] = answers[request.url ?? ''] ?? [404]
      response.writeHead(status, location ? { location } : {}).end()
    })
  })

  after(async () => {
    await site.close()
    await legacy.close()
  })

  async function check() {
    const run = new Run('apex', 'local')
    await apex.run({ env: { ...environments.production, name: 'local', website: site.url, legacy: legacy.url }, run })
    return run.finish()
  }

  it('passes on the answers production gives, a query on the installer Location included', async () => {
    installerLocation = `${installer}?utm_source=readme`
    const result = await check()
    assert.equal(result.ok, true, JSON.stringify(result.steps, null, 2))
    assert.equal(result.steps.length, 10)
  })

  it('fails a redirect to another path, naming the one it wanted', async () => {
    installerLocation = 'https://github.com/demeter-run/cli/releases/latest/download/dmtrctl.sh'
    const failed = (await check()).steps.filter((s) => !s.ok)
    assert.deepEqual(
      failed.map((s) => s.detail),
      [`302 → https://github.com/demeter-run/cli/releases/latest/download/dmtrctl.sh, wanted Location ${installer}`],
    )
  })
})
