/**
 * The named environments a check or journey runs against, and their base URLs.
 *
 * `production` is the only one today. The agent-route mock adds `mock`.
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
  /**
   * The standing test user journeys sign in as (decision 0047), whose password
   * is `E2E_USER_PASSWORD`; absent where nothing signs in.
   */
  testUser?: string
}

export const environments = {
  production: {
    name: 'production',
    website: 'https://demeter.run',
    console: 'https://console.demeter.run',
    legacy: 'https://legacy.demeter.run',
    rpc: 'https://rpc.demeter.run',
    auth0: 'https://txpipe.us.auth0.com',
    testUser: 'e2e@txpipe.io',
  },
} satisfies Record<string, Environment>

export type EnvironmentName = keyof typeof environments

export function environment(name: string): Environment {
  if (Object.hasOwn(environments, name)) return environments[name as EnvironmentName]
  throw new Error(`unknown environment "${name}" (known: ${Object.keys(environments).join(', ')})`)
}
