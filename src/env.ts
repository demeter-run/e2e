/**
 * The named environments a check or journey runs against, and their base URLs.
 *
 * `production` is what is deployed. `mock` is the agent-route mock
 * (`pnpm mock`, `src/mock/`), which stands in for the Console, its agent API
 * under `/api/agent/`, and the sign-in; it serves nothing else, so only the
 * agent suites run against it.
 */
export interface Environment {
  name: string
  /** website2, on the apex. */
  website: string
  /** The Console. */
  console: string
  /** The pre-website2 site, moved off the apex at the cutover. */
  legacy: string
  /** fabric's gRPC-web API. */
  rpc: string
  /** The Auth0 tenant the Console and the legacy app sign in through. */
  auth0: string
  /** What the port suite signs in as and where it reaches each port; absent where the suite does not run. */
  ports?: PortSuiteTarget
}

export interface PortSuiteTarget {
  /** The standing test user (decision 0047), signed in by Auth0's password grant. */
  user: string
  /** The Auth0 audience fabric's API accepts. */
  audience: string
  /** fabric's native gRPC endpoint, as `host:port`. */
  grpc: string
  /**
   * Each port kind's host, after the port's key: `<key>.<host>`. UTxO RPC
   * takes its key in a header instead, so its host is used as it is.
   */
  hosts: {
    node: string
    blockfrost: string
    kupo: string
    ogmios: string
    utxorpc: string
    submitapi: string
  }
}

/** Where `pnpm mock` listens: `E2E_MOCK_URL`, by default its default port on this machine. */
const mockUrl = (process.env.E2E_MOCK_URL ?? 'http://127.0.0.1:4010').replace(/\/+$/, '')

export const environments = {
  production: {
    name: 'production',
    website: 'https://demeter.run',
    console: 'https://console.demeter.run',
    legacy: 'https://legacy.demeter.run',
    rpc: 'https://rpc.demeter.run',
    auth0: 'https://txpipe.us.auth0.com',
    ports: {
      user: 'e2e@txpipe.io',
      audience: 'demeter-api',
      grpc: 'rpc.demeter.run:443',
      hosts: {
        node: 'cnode-m1.demeter.run:9443',
        blockfrost: 'blockfrost-m1.demeter.run',
        kupo: 'mainnet-v2.kupo-m1.demeter.run',
        ogmios: 'cardano-mainnet-v6.ogmios-m1.demeter.run',
        utxorpc: 'mainnet.utxorpc-v0.demeter.run:443',
        submitapi: 'submitapi-m1.demeter.run',
      },
    },
  },
  mock: {
    name: 'mock',
    website: mockUrl,
    console: mockUrl,
    legacy: mockUrl,
    rpc: mockUrl,
    auth0: mockUrl,
  },
} satisfies Record<string, Environment>

export type EnvironmentName = keyof typeof environments

export function environment(name: string): Environment {
  if (Object.hasOwn(environments, name)) return environments[name as EnvironmentName]
  throw new Error(`unknown environment "${name}" (known: ${Object.keys(environments).join(', ')})`)
}
