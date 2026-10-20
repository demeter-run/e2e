import { call } from '../agent/client.ts'
import type { Environment } from '../env.ts'
import { Failure } from '../report.ts'
import type { Call, ErrorCode } from './server.ts'

/** Clients of the mock's control routes (`/__mock/`), for the suites that run against it. */

export type MockState =
  | { route: 'register' | 'ports'; error: ErrorCode | null; retry_after_seconds?: number }
  | { project: string; expired: boolean }

async function control(env: Environment, method: string, path: string, body?: unknown): Promise<string> {
  const answer = await call(method, `${env.console}${path}`, body === undefined ? {} : { body: JSON.stringify(body) })
  if (answer.status !== 200) throw new Failure(`the mock answered ${method} ${path} with ${answer.status ?? answer.error}: ${answer.body.trim()}`)
  return answer.body
}

export const setMockState = async (env: Environment, state: MockState): Promise<void> => void (await control(env, 'POST', '/__mock/state', state))

export const resetMock = async (env: Environment): Promise<void> => void (await control(env, 'POST', '/__mock/reset', {}))

export const mockCalls = async (env: Environment): Promise<Call[]> => JSON.parse(await control(env, 'GET', '/__mock/calls')) as Call[]
