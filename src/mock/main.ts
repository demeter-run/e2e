import { parseArgs } from 'node:util'
import { startMock } from './server.ts'

const usage = `usage: pnpm mock [--port <n>] [--host <address>] [--base-url <url>]

A mock of the Console's agent routes and claim pages, built from the
registration-and-claim contract. Nothing it issues reaches anything real.

options:
  --port <n>          where to listen (default 4010)
  --host <address>    the address to listen on (default 127.0.0.1)
  --base-url <url>    the origin written into claim and port URLs (default http://<host>:<port>)

\`--env mock\` reads its URL from E2E_MOCK_URL (default http://127.0.0.1:4010);
with --base-url, set E2E_MOCK_URL to the same origin.`

/** An http(s) URL with no path but `/`, no query and no fragment: what claim and port URLs are written under. */
function isOrigin(text: string): boolean {
  try {
    const url = new URL(text)
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.pathname === '/' && !url.search && !url.hash
  } catch {
    return false
  }
}

let values: { port: string; host: string; 'base-url'?: string; help: boolean }
try {
  values = parseArgs({
    options: {
      port: { type: 'string', default: '4010' },
      host: { type: 'string', default: '127.0.0.1' },
      'base-url': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  }).values
} catch (error) {
  console.error(`${(error as Error).message}\n\n${usage}`)
  process.exit(2)
}
if (values.help) {
  console.log(usage)
  process.exit(0)
}
const port = Number(values.port)
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`--port ${values.port} is not a port\n\n${usage}`)
  process.exit(2)
}

const baseUrl = values['base-url']
if (baseUrl !== undefined && !isOrigin(baseUrl)) {
  console.error(`--base-url ${baseUrl} is not an http(s) origin, such as http://mock.local:4020\n\n${usage}`)
  process.exit(2)
}

const mock = await startMock({ port, host: values.host, ...(baseUrl ? { baseUrl } : {}) })
console.log(`mock listening on ${mock.url}`)
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => void mock.close().then(() => process.exit(0)))
