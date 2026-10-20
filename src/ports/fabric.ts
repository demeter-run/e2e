import { fetchNamingCause } from '../http.ts'
import { type Call, unary } from './grpc.ts'
import { encodeStrings, encodeVarints, messages, string } from './proto.ts'

/**
 * fabric's project and resource API, as the test user calls it: the RPCs
 * fabric's script made with `grpcurl`, on `demeter.ops.v1alpha` (fabric's
 * specs, `project.proto` and `resource.proto`). Every message here is strings
 * and repeated records, so the field numbers are noted where each is built.
 */
export class Fabric {
  constructor(
    readonly address: string,
    readonly token: string,
    readonly call: (call: Call) => Promise<Uint8Array> = unary,
  ) {}

  #call(method: string, request: Uint8Array, timeoutMs?: number) {
    return this.call({
      address: this.address,
      method: `/demeter.ops.v1alpha.${method}`,
      request,
      headers: { authorization: `Bearer ${this.token}` },
      timeoutMs,
    })
  }

  /**
   * `CreateProject { name = 1 }` → `{ id = 1, name = 2, namespace = 3 }`. A
   * minute's deadline, not 15 s: a project fabric commits after the client
   * gave up is one the run never learns the id of, so cannot delete. It
   * answers in about a second.
   */
  async createProject(name: string): Promise<{ id: string; namespace: string }> {
    const response = await this.#call('ProjectService/CreateProject', encodeStrings({ 1: name }), 60_000)
    const id = string(response, 1)
    if (!id) throw new Error('CreateProject answered no project id')
    return { id, namespace: string(response, 3) }
  }

  /** `DeleteProject { id = 1 }`. fabric marks the project deleted by an event, so it leaves the list shortly after. */
  async deleteProject(id: string): Promise<void> {
    await this.#call('ProjectService/DeleteProject', encodeStrings({ 1: id }))
  }

  /** `FetchProjects { page_size = 2 }` → `records = 2` of `Project { id = 1 }`: the projects the Console lists, deleted ones left out. */
  async projectIds(): Promise<string[]> {
    const response = await this.#call('ProjectService/FetchProjects', encodeVarints({ 2: 100 }))
    return messages(response, 2).map((project) => string(project, 1))
  }

  /** `CreateResource { project_id = 1, kind = 2, spec = 3 }` → `{ id = 1, name = 2 }`. */
  async createResource(projectId: string, kind: string, spec: object): Promise<{ id: string; name: string }> {
    const response = await this.#call(
      'ResourceService/CreateResource',
      encodeStrings({ 1: projectId, 2: kind, 3: JSON.stringify(spec) }),
    )
    const id = string(response, 1)
    if (!id) throw new Error('CreateResource answered no resource id')
    return { id, name: string(response, 2) }
  }

  /** `FetchResourcesById { id = 1 }` → `records = 1` of `Resource { spec = 4 }`; the spec is JSON. Null when there is no record yet. */
  async resourceSpec(id: string): Promise<Record<string, unknown> | null> {
    const response = await this.#call('ResourceService/FetchResourcesById', encodeStrings({ 1: id }))
    const [record] = messages(response, 1)
    if (!record) return null
    // A parse error quotes the text around it, which would hold part of the key.
    try {
      return JSON.parse(string(record, 4)) as Record<string, unknown>
    } catch {
      throw new Error('FetchResourcesById answered a spec that is not JSON')
    }
  }
}

/**
 * An access token for fabric's API: Auth0's password grant, as fabric's
 * script asked for it. The password and client secret go in the body only.
 */
export async function signIn(
  auth0: string,
  { username, password, clientId, clientSecret, audience }: { username: string; password: string; clientId: string; clientSecret: string; audience: string },
): Promise<string> {
  const response = await fetchNamingCause(`${auth0}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password',
      username,
      password,
      audience,
      scope: 'profile openid email',
      client_id: clientId,
      client_secret: clientSecret,
    }),
    signal: AbortSignal.timeout(15_000),
  })
  const body = (await response.json().catch(() => ({}))) as { access_token?: unknown; error?: unknown; error_description?: unknown }
  if (response.ok && typeof body.access_token === 'string' && body.access_token) return body.access_token
  // Auth0's error and description name the problem (`invalid_grant`, "Wrong
  // email or password.") and carry nothing secret.
  const why = typeof body.error === 'string' ? `: ${body.error}${typeof body.error_description === 'string' ? ` (${body.error_description})` : ''}` : ''
  throw new Error(`Auth0 answered HTTP ${response.status} with no access token${why}`)
}
