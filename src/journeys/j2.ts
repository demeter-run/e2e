import type { Page } from '@playwright/test'
import type { ConsolePort } from './console.ts'
import { NotRun } from './spec.ts'

/**
 * What J2 leaves the edge cases that share its browser (`journeys/j2.spec.ts`):
 * the page it walked, whether it signed in on it, and the port it deployed.
 * Each edge case takes only what it needs, through a guard that fails it as
 * not run when J2 left none. The legacy cookie needs the signed-in session
 * alone, so a J2 that signed in and failed later still walks it; 401 and 429
 * need the port.
 */
export interface Shared {
  page?: Page
  signedIn: boolean
  port?: ConsolePort
}

/** The page J2 signed in on, or `NotRun` when it did not sign in or left no page. */
export function signedInPage(shared: Shared): Page {
  if (!shared.page || !shared.signedIn) throw new NotRun('J2 left no signed-in session')
  return shared.page
}

/** The port J2 deployed, or `NotRun` when it deployed none. */
export function deployedPort(shared: Shared): ConsolePort {
  if (!shared.port) throw new NotRun('J2 deployed no port')
  return shared.port
}
