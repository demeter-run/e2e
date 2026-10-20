import { call } from '../agent/client.ts'
import type { Environment } from '../env.ts'
import { Failure } from '../report.ts'
import type { Call, ErrorCode, Limits } from './server.ts'

/** Clients of the mock's control routes (`/__mock/`), for the suites that run against it. */

export type MockState =
  | { route: 'register' | 'ports'; error: ErrorCode | null; retry_after_seconds?: number }
  | { project: string; expired: boolean }
  | { provisional_enabled: boolean }
  | { limits: Partial<Limits> }

async function control(env: Environment, method: string, path: string, body?: unknown): Promise<string> {
  const answer = await call(method, `${env.console}${path}`, body === undefined ? {} : { body: JSON.stringify(body) })
  if (answer.status !== 200) throw new Failure(`the mock answered ${method} ${path} with ${answer.status ?? answer.error}: ${answer.body.trim()}`)
  return answer.body
}

/**
 * What `GET /__mock/state` answers: each route's error state, as it was
 * switched on, the expired projects' ids, the kill switch, the caps, and the
 * mock's time.
 */
export interface MockStates {
  errors: Partial<Record<'register' | 'ports', { error: ErrorCode; retry_after_seconds?: number }>>
  expired: string[]
  provisional_enabled: boolean
  limits: Limits
  now: string
}

export const setMockState = async (env: Environment, state: MockState): Promise<void> => void (await control(env, 'POST', '/__mock/state', state))

export const mockState = async (env: Environment): Promise<MockStates> => JSON.parse(await control(env, 'GET', '/__mock/state')) as MockStates

/** Moves the mock's clock forward by `seconds`, which expires every unclaimed project whose expiry it passes. */
export const advanceMockClock = async (env: Environment, seconds: number): Promise<MockStates> =>
  JSON.parse(await control(env, 'POST', '/__mock/clock', { advance_seconds: seconds })) as MockStates

export const resetMock = async (env: Environment): Promise<void> => void (await control(env, 'POST', '/__mock/reset', {}))

export const mockCalls = async (env: Environment): Promise<Call[]> => JSON.parse(await control(env, 'GET', '/__mock/calls')) as Call[]
