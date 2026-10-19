import { setTimeout as delay } from 'node:timers/promises'
import type { Check } from '../checks/check.ts'
import { Fabric, signIn } from './fabric.ts'
import { budget, type Kind, kinds as allKinds, tipSlack } from './kinds.ts'

/**
 * fabric's daily `test/e2e`, embedded: sign in as the test user, create a
 * project, create each port kind and check it answers from the chain tip,
 * then delete the project, pass or fail. Every kind is checked even when one
 * before it failed; a failed sign-in or project creation ends the run there.
 */

/** The credentials the sign-in reads, by environment variable. */
export const secrets = ['E2E_USER_PASSWORD', 'AUTH0_CLIENT_ID', 'AUTH0_CLIENT_SECRET'] as const

export interface Seams {
  kinds?: Kind[]
  sleep?: (ms: number) => Promise<void>
  signIn?: typeof signIn
  fabric?: (address: string, token: string) => Pick<Fabric, 'createProject' | 'deleteProject' | 'projectIds' | 'createResource' | 'resourceSpec'>
}

export function portSuite({
  kinds = allKinds,
  sleep = (ms) => delay(ms),
  signIn: authenticate = signIn,
  fabric: open = (address, token) => new Fabric(address, token),
}: Seams = {}): Check {
  return {
    name: 'ports',
    summary: "fabric's daily port suite: a project, each port kind at the chain tip, then deleted",
    async run({ env, run }) {
      const target = env.ports
      if (!target) throw new Error(`the ${env.name} environment names no port suite target`)
      for (const name of secrets) run.conceal(process.env[name] ?? '')

      let token = ''
      const signedIn = await run.step(`sign in as ${target.user}`, async () => {
        const missing = secrets.filter((name) => !process.env[name])
        if (missing.length) throw new Error(`${missing.join(', ')} not set`)
        token = await authenticate(env.auth0, {
          username: target.user,
          password: process.env.E2E_USER_PASSWORD!,
          clientId: process.env.AUTH0_CLIENT_ID!,
          clientSecret: process.env.AUTH0_CLIENT_SECRET!,
          audience: target.audience,
        })
        run.conceal(token)
        return `an access token for ${target.audience}`
      })
      if (!signedIn) return

      const api = open(target.grpc, token)
      let project = ''
      const created = await run.step('create a project', async () => {
        const { id, namespace } = await api.createProject('e2e project')
        project = id
        return `${id} (${namespace})`
      })
      if (!created) return

      try {
        await sleep(budget.sleepMs)
        let tip: number | null = null
        for (const kind of kinds) {
          let key = ''
          const made = await run.step(`${kind.label}: create ${kind.kind}`, async () => {
            const { id, name } = await api.createResource(project, kind.kind, kind.spec)
            // fabric's `create_port`: the resource is read back until its spec carries the key.
            let why = 'no authToken in its spec'
            for (let n = 1; n <= budget.attempts && !key; n++) {
              await sleep(budget.sleepMs)
              try {
                const spec = await api.resourceSpec(id)
                if (typeof spec?.authToken === 'string' && spec.authToken) key = spec.authToken
                else why = spec ? 'no authToken in its spec' : 'no record'
              } catch (error) {
                why = (error as Error).message
              }
            }
            if (!key) throw new Error(`${name} (${id}): ${why} after ${budget.attempts} reads`)
            run.conceal(key)
            return `${name} (${id})`
          })
          if (!made) continue
          await run.step(`${kind.label}: ${kind.claim}`, async () => {
            const { detail, slot } = await kind.check({ key, hosts: target.hosts, tip, sleep })
            if (kind.kind === 'CardanoNodePort' && slot !== undefined) tip = slot - tipSlack
            return detail
          })
        }
      } finally {
        const deleted = await run.step('delete the project', async () => {
          await api.deleteProject(project)
          return project
        })
        if (deleted) {
          await run.step('the project is no longer listed', async () => {
            let why = ''
            for (let n = 1; n <= budget.attempts; n++) {
              await sleep(budget.sleepMs)
              try {
                const listed = await api.projectIds()
                if (!listed.includes(project)) return `FetchProjects lists ${listed.length} project(s), not ${project}`
                why = `FetchProjects still lists ${project}`
              } catch (error) {
                why = (error as Error).message
              }
            }
            throw new Error(`${why} after ${budget.attempts} reads`)
          })
        }
      }
    },
  }
}

export const ports = portSuite()
