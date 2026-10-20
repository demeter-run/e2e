import type { Environment } from '../env.ts'
import { advanceMockClock, mockState } from '../mock/control.ts'
import type { Run } from '../report.ts'
import { describe, type Secrets } from './client.ts'
import { Agent, answers, claimPath, createdPort, dataRequest, expectError, fail, type Port, type Project, portOn, signedIn, startFromEmptyMock } from './mock-journey.ts'

/**
 * J3, expiry (`solution/devex/contracts/journey-matrix.md`), as scripted
 * calls with no model, on the mock alone: production's expiry takes 7 days.
 * An agent's project expires unclaimed after 7 days on the mock's clock and
 * takes its ports with it (decision 0041); the agent registers again and
 * starts over, and the person who opens the expired claim link is told so.
 */

const DAY = 86_400
const TTL_SECONDS = 7 * DAY
const AGENT_NAME = 'e2e-j3'
/** The agent's address, from TEST-NET-1. */
const IP = '192.0.2.3'
const SECOND_PORT = { kind: 'OgmiosPort', network: 'cardano-preprod' }

export async function j3({ env, run, secrets }: { env: Environment; run: Run; secrets: Secrets }): Promise<void> {
  const agent = new Agent(env, secrets, AGENT_NAME, IP)
  let first: Project | undefined
  let firstPort: Port | undefined
  let expired = false

  const needFirst = () => first ?? fail('not run: the first registration failed')

  if (!(await startFromEmptyMock(env, run))) return

  await run.step(`register as agent ${AGENT_NAME} from ${IP}: expires 7 days later on the mock's clock`, async () => {
    const now = Date.parse((await mockState(env)).now)
    first = await agent.registered()
    const expires = Date.parse(first.expiresAt)
    if (Number.isNaN(expires) || Math.abs(expires - (now + TTL_SECONDS * 1000)) > 60_000) {
      fail(`DEMETER_EXPIRES_AT ${first.expiresAt} is not 7 days after the mock's now, ${new Date(now).toISOString()}`)
    }
    return `200: namespace ${first.namespace}, expires ${first.expiresAt}`
  })

  await run.step('create a Blockfrost port on cardano-preprod, and it answers 2xx', async () => {
    firstPort = await createdPort(env, secrets, needFirst())
    return `200, then the port answered ${await answers(firstPort)}`
  })

  await run.step('a minute before the expiry, the project still takes a port', async () => {
    const project = needFirst()
    await advanceMockClock(env, TTL_SECONDS - 60)
    await createdPort(env, secrets, project, SECOND_PORT)
    return `clock +7 days less a minute: ${SECOND_PORT.kind} on ${SECOND_PORT.network} 200`
  })

  await run.step('a minute past the expiry, the next port call is 410 expired, with docs', async () => {
    const project = needFirst()
    const state = await advanceMockClock(env, 120)
    const answer = await portOn(env, secrets, project)
    const body = expectError(answer, 410, 'expired', secrets)
    expired = true
    const swept = state.expired.includes(project.projectId) ? 'swept' : 'not in the mock\'s expired list'
    return `clock +7 days and a minute, project ${swept}: ${describe(answer)}, docs ${body.docs}`
  })

  await run.step("the expired project's port no longer answers", async () => {
    if (!firstPort) fail('not run: the first port was never created')
    if (!expired) fail('not run: the project did not expire')
    const answer = await dataRequest(firstPort!)
    if (answer.status === null || (answer.status >= 200 && answer.status < 300)) fail(`the port answered ${describe(answer)}, wanted a refusal`)
    return describe(answer)
  })

  await run.step('register again: a new project, whose port answers 2xx', async () => {
    const again = await agent.registered()
    if (first && (again.projectId === first.projectId || again.namespace === first.namespace)) fail(`register named the expired project ${first.namespace} again`)
    const port = await createdPort(env, secrets, again)
    return `200: namespace ${again.namespace}; its port answered ${await answers(port)}`
  })

  await run.step("the expired project's claim link says it expired, and claims nothing", async () => {
    const project = needFirst()
    if (!expired) fail('not run: the project did not expire')
    const path = claimPath(env, project)
    const visit = await signedIn(env, secrets, 'e2e-j3@mock')
    const page = await visit('GET', path)
    if (page.status !== 200 || !page.body.includes('This link has expired or was already used')) {
      fail(`the claim page answered ${describe(page)} without "This link has expired or was already used"`)
    }
    const post = await visit('POST', path, { name: project.namespace })
    if (post.status === 302 && post.headers.location === `/${project.namespace}/ports`) fail(`claiming it redirected to /${project.namespace}/ports, as a claim that worked does`)
    const owned = await visit('GET', `/${project.namespace}/ports`)
    if (owned.status !== 404) fail(`/${project.namespace}/ports answered the person ${describe(owned)} after the claim, wanted 404: the expired project was claimed`)
    return `"This link has expired or was already used"; the claim answered ${describe(post)} and /${project.namespace}/ports 404`
  })
}
