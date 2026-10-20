import type { Environment } from '../env.ts'
import { advanceMockClock, resetMock, setMockState } from '../mock/control.ts'
import { defaultLimits } from '../mock/server.ts'
import type { Run } from '../report.ts'
import { describe, type Secrets } from './client.ts'
import { Agent, answers, claimPath, createdPort, expectError, expectIpCap, fail, type Port, type Project, portOn, signedIn } from './mock-journey.ts'

/**
 * J9, abuse (`solution/devex/contracts/journey-matrix.md`), as scripted calls
 * with no model, on the mock alone: the caps and the kill switch are shared
 * production state. Agents on addresses of their own meet each cap the
 * contract's "Errors" table names, in fabric's terms (3 registrations per
 * client IP in a trailing 24 hours, 3 ports per unclaimed project, a global
 * limit of live unclaimed projects), and the kill switch, which stops
 * registration only.
 */

const HOUR = 3_600
const WINDOW = 24 * HOUR
/** The agents' addresses, from TEST-NET-1. */
const IP = { busy: '192.0.2.9', other: '192.0.2.20', late: '192.0.2.30' }
const PORTS = [
  { kind: 'BlockfrostPort', network: 'cardano-preprod' },
  { kind: 'OgmiosPort', network: 'cardano-preprod' },
  { kind: 'KupoPort', network: 'cardano-preview' },
]
const FOURTH_PORT = { kind: 'UtxoRpcPort', network: 'cardano-preview' }

export async function j9({ env, run, secrets }: { env: Environment; run: Run; secrets: Secrets }): Promise<void> {
  const busy = new Agent(env, secrets, 'e2e-j9', IP.busy)
  /** Every project registered, in order: the global cap counts them while none is claimed or expired. */
  const projects: Project[] = []
  let firstPort: Port | undefined
  /** The wait the first ip_cap refusal named. */
  let wait: number | undefined
  /** The wait a minute before it ends. */
  let lastMinute: number | undefined

  const project = (i: number) => projects[i] ?? fail(`not run: registration ${i + 1} failed`)

  await run.step('start from an empty mock', () => resetMock(env).then(() => 'POST /__mock/reset'))

  await run.step(`from ${IP.busy}, three registrations an hour apart from the first succeed`, async () => {
    projects.push(await busy.registered())
    await advanceMockClock(env, HOUR)
    projects.push(await busy.registered())
    projects.push(await busy.registered())
    return `3 × 200: ${projects.map((p) => p.namespace).join(', ')}`
  })

  await run.step('the fourth is 429 ip_cap, retry_after_seconds equal to Retry-After, until the first leaves the 24-hour window', async () => {
    if (projects.length !== 3) fail('not run: the first three registrations did not all succeed')
    wait = expectIpCap(await busy.register(), secrets)
    // The first registration leaves the window 23 hours after the others were made.
    if (wait > WINDOW - HOUR || wait < WINDOW - HOUR - 60) fail(`the wait is ${wait} s, wanted the ${WINDOW - HOUR} s until the first registration is 24 hours old`)
    return `429 ip_cap, retry after ${wait} s`
  })

  await run.step('a minute before that wait ends, it is still ip_cap, with the minute left', async () => {
    if (wait === undefined) fail('not run: the fourth registration was not refused')
    await advanceMockClock(env, wait! - 60)
    lastMinute = expectIpCap(await busy.register(), secrets)
    if (lastMinute > 60) fail(`the wait is ${lastMinute} s, wanted at most the 60 s left`)
    return `clock +${wait! - 60} s: 429 ip_cap, retry after ${lastMinute} s`
  })

  await run.step('past the wait, the address registers again', async () => {
    if (lastMinute === undefined) fail('not run: the wait was not confirmed')
    await advanceMockClock(env, lastMinute! + 1)
    projects.push(await busy.registered())
    return `clock +${lastMinute! + 1} s: 200, namespace ${projects.at(-1)!.namespace}`
  })

  await run.step('the window slides: the next is ip_cap again, until the second registration leaves it', async () => {
    if (projects.length !== 4) fail('not run: the address did not register again')
    const next = expectIpCap(await busy.register(), secrets)
    if (next > HOUR || next < HOUR - 120) fail(`the wait is ${next} s, wanted under the hour until the second registration is 24 hours old`)
    return `429 ip_cap, retry after ${next} s`
  })

  await run.step('one project takes three ports, and the fourth is 429 port_cap', async () => {
    const own = project(0)
    for (const port of PORTS) {
      const made = await createdPort(env, secrets, own, port)
      firstPort ??= made
    }
    const fourth = await portOn(env, secrets, own, FOURTH_PORT)
    expectError(fourth, 429, 'port_cap', secrets)
    return `3 × 200, then ${FOURTH_PORT.kind}: ${describe(fourth)}`
  })

  await run.step(`with the global limit one above the live projects, ${IP.other} registers once, then gets 503 global_cap`, async () => {
    if (!projects.length) fail('not run: nothing was registered')
    const limit = projects.length + 1
    await setMockState(env, { limits: { global_cap: limit } })
    try {
      const other = new Agent(env, secrets, 'e2e-j9-other', IP.other)
      projects.push(await other.registered())
      const answer = await other.register()
      expectError(answer, 503, 'global_cap', secrets)
      return `global_cap ${limit}: 200, then ${describe(answer)}`
    } finally {
      await setMockState(env, { limits: { global_cap: defaultLimits.global_cap } })
    }
  })

  const late = new Agent(env, secrets, 'e2e-j9-late', IP.late)
  await setMockState(env, { provisional_enabled: false })
  try {
    await run.step('with the kill switch off, registration is 503 registration_disabled', async () => {
      const answer = await late.register()
      expectError(answer, 503, 'registration_disabled', secrets)
      return describe(answer)
    })

    await run.step("with it off, an existing project's port still answers, and it still takes a port", async () => {
      if (!firstPort) fail('not run: no port was created')
      const answered = await answers(firstPort!)
      await createdPort(env, secrets, project(1))
      return `the port answered ${answered}; a new port on ${project(1).namespace} 200`
    })

    await run.step('with it off, an existing project can still be claimed', async () => {
      const own = project(0)
      const path = claimPath(env, own)
      const visit = await signedIn(env, secrets, 'e2e-j9@mock')
      const post = await visit('POST', path, { name: own.namespace })
      if (post.status !== 302 || post.headers.location !== `/${own.namespace}/ports`) fail(`claiming it answered ${describe(post)}, wanted 302 to /${own.namespace}/ports`)
      const owned = await visit('GET', `/${own.namespace}/ports`)
      if (owned.status !== 200) fail(`/${own.namespace}/ports answered the person ${describe(owned)} after the claim, wanted 200`)
      return `302 to /${own.namespace}/ports, which answers 200`
    })
  } finally {
    await setMockState(env, { provisional_enabled: true })
  }

  await run.step('with it on again, registration opens', async () => {
    const made = await late.registered()
    return `200, namespace ${made.namespace}`
  })
}
