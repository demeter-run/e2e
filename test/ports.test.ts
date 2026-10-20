import assert from 'node:assert/strict'
import { once } from 'node:events'
import { type AddressInfo, connect, createServer, type Socket } from 'node:net'
import { describe, it, mock } from 'node:test'
import { main } from '../src/cli/main.ts'
import { environments } from '../src/env.ts'
import { type Cbor, decode, encode, Incomplete, Tagged } from '../src/ports/cbor.ts'
import { fetchNamingCause } from '../src/http.ts'
import { Fabric, signIn } from '../src/ports/fabric.ts'
import type { Call } from '../src/ports/grpc.ts'
import { portSuite, type Seams } from '../src/ports/index.ts'
import { type Kind, kinds, type Probe, portKinds, type Reach } from '../src/ports/kinds.ts'
import { mainnet, queryTip, slotTime, syncProgress, twoDecimals } from '../src/ports/node.ts'
import { decode as decodeProto, encodeStrings, encodeVarints, messages, string, varint } from '../src/ports/proto.ts'
import { type Result, Run } from '../src/report.ts'
import { withEnv } from './helpers.ts'

describe('cbor', () => {
  it('encodes what the handshake sends', () => {
    // [0, {32784: [764824073, false]}]
    assert.deepEqual(
      [...encode([0, new Map([[32784, [764824073, false]]])])],
      [0x82, 0x00, 0xa1, 0x19, 0x80, 0x10, 0x82, 0x1a, 0x2d, 0x96, 0x4a, 0x09, 0xf4],
    )
  })

  it('decodes definite and indefinite items, and says when the input is cut short', () => {
    const tip = Uint8Array.from([0x82, 0x06, 0x82, 0x82, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x42, 0xab, 0xcd, 0x19, 0x01, 0x00])
    const { value, length } = decode(tip)
    assert.equal(length, tip.length)
    assert.deepEqual(value, [6, [[167772160, Uint8Array.from([0xab, 0xcd])], 256]])
    assert.deepEqual(decode(Uint8Array.from([0x9f, 0x01, 0x02, 0xff])).value, [1, 2])
    assert.deepEqual(decode(Uint8Array.from([0xd9, 0x01, 0x02, 0x80])).value, new Tagged(258, []))
    assert.throws(() => decode(tip.subarray(0, 9)), Incomplete)
  })
})

describe('protobuf', () => {
  it('round-trips the strings and varints fabric and UTxO RPC use', () => {
    const message = encodeStrings({ 1: 'id-1', 2: '', 3: 'prj-x' })
    assert.equal(string(message, 1), 'id-1')
    assert.equal(string(message, 2), '')
    assert.equal(string(message, 3), 'prj-x')
    assert.equal(varint(encodeVarints({ 1: 172_800_123 }), 1), 172_800_123)
    // ReadParamsResponse { ledger_tip = 2 { slot = 1 } }, after a values field.
    const tip = encodeVarints({ 1: 140_000_000 })
    const response = Uint8Array.from([...encodeStrings({ 1: 'x' }), 0x12, tip.length, ...tip])
    assert.equal(varint(messages(response, 2)[0]!, 1), 140_000_000)
    assert.equal(decodeProto(response).length, 2)
  })
})

describe('the node check', () => {
  it('reads cardano-cli’s syncProgress from a slot', () => {
    const now = mainnet.shelleyStart + 200_000_000 - mainnet.shelleySlot
    assert.equal(syncProgress(200_000_000, now), 100)
    // Within 600 s of now is 100: the tip's seconds are moved 600 forward.
    assert.equal(syncProgress(200_000_000 - 600, now), 100)
    // Byron's first slot, 1000 s after the system start: (0 + 1 + 600) / (1000 + 1) = 60.04 %.
    assert.equal(syncProgress(0, mainnet.systemStart + 1_000), 60.04)
    assert.equal(syncProgress(0, mainnet.systemStart + 1_000.9), 60.04)
  })

  it('prints two decimals as GHC’s printf does, half to even on the shortest digits', () => {
    assert.equal(twoDecimals(98.994999), 98.99)
    assert.equal(twoDecimals(98.995), 99)
    assert.equal(twoDecimals(98.985), 98.98)
    assert.equal(twoDecimals(98.9851), 98.99)
    assert.equal(twoDecimals(99.999), 100)
    assert.equal(twoDecimals(100), 100)
    assert.equal(twoDecimals(0.0004), 0)
  })

  /** A node that answers the handshake and FindIntersect as cardano-node does, in SDUs split one byte at a time. */
  async function node(reply: (protocol: number, message: Cbor) => Cbor | undefined) {
    const received: [number, Cbor][] = []
    const server = createServer((socket: Socket) => {
      let buffer = Buffer.alloc(0)
      socket.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk])
        while (buffer.length >= 8 && buffer.length >= 8 + buffer.readUInt16BE(6)) {
          const protocol = buffer.readUInt16BE(4)
          const { value } = decode(buffer.subarray(8, 8 + buffer.readUInt16BE(6)))
          buffer = buffer.subarray(8 + buffer.readUInt16BE(6))
          received.push([protocol, value])
          const answer = reply(protocol, value)
          if (answer === undefined) continue
          const payload = encode(answer as Cbor[])
          const header = Buffer.alloc(8)
          header.writeUInt16BE(0x8000 | protocol, 4)
          header.writeUInt16BE(payload.length, 6)
          for (const byte of Buffer.concat([header, payload])) socket.write(Uint8Array.of(byte))
        }
      })
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const { port } = server.address() as AddressInfo
    return { received, open: () => connect(port, '127.0.0.1'), close: () => server.close() }
  }

  it('proposes node-to-client v16–v20 on mainnet and reads the tip FindIntersect answers with', async () => {
    const fake = await node((protocol, message) =>
      protocol === 0 ? [1, 32788, [mainnet.magic, false]] : [6, [[172_000_000, 0], 12_000_000]],
    )
    try {
      assert.deepEqual(await queryTip('unused:9443', { open: fake.open }), { slot: 172_000_000, block: 12_000_000 })
      const [[p0, proposal], [p1, find]] = fake.received as [[number, Cbor[]], [number, Cbor]]
      assert.equal(p0, 0)
      assert.equal(proposal[0], 0)
      assert.deepEqual([...(proposal[1] as Map<number, Cbor>).keys()], [32784, 32785, 32786, 32787, 32788])
      assert.deepEqual((proposal[1] as Map<number, Cbor>).get(32784), [mainnet.magic, false])
      assert.deepEqual([p1, find], [5, [4, []]])
    } finally {
      fake.close()
    }
  })

  it('fails naming a refused handshake', async () => {
    const fake = await node(() => [2, [0, [32784]]])
    try {
      await assert.rejects(queryTip('unused:9443', { open: fake.open }), /the node refused the handshake: \[0,\[32784\]\]/)
    } finally {
      fake.close()
    }
  })

  it('gives up on a node that never answers', async () => {
    const fake = await node(() => undefined)
    try {
      await assert.rejects(queryTip('unused:9443', { open: fake.open, timeoutMs: 50 }), { message: 'no tip within 0.05 s' })
      assert.equal(fake.received.length, 1)
    } finally {
      fake.close()
    }
  })

  it('fails naming a refused connection', async () => {
    const server = createServer().listen(0, '127.0.0.1')
    await once(server, 'listening')
    const { port } = server.address() as AddressInfo
    server.close()
    await once(server, 'close')
    await assert.rejects(queryTip('unused:9443', { open: () => connect(port, '127.0.0.1') }), {
      message: `ECONNREFUSED (connect ECONNREFUSED 127.0.0.1:${port})`,
    })
  })

  it('fails when the connection closes before the tip', async () => {
    const server = createServer((socket) => socket.end()).listen(0, '127.0.0.1')
    await once(server, 'listening')
    const { port } = server.address() as AddressInfo
    try {
      await assert.rejects(queryTip('unused:9443', { open: () => connect(port, '127.0.0.1') }), {
        message: 'the connection closed before the node sent its tip',
      })
    } finally {
      server.close()
    }
  })
})

/**
 * A fabric that keeps its projects in memory; `fail` makes one of its calls
 * throw, and `quirks` keeps a created project out of the list or a deleted one in it.
 */
function fakeFabric(
  fail: Partial<Record<'createProject' | 'deleteProject' | 'createResource', string>> = {},
  quirks: { neverListed?: boolean; staysListed?: boolean } = {},
) {
  const state = { projects: new Set<string>(['someone-elses']), deleted: [] as string[], created: [] as string[], specs: [] as object[] }
  const fabric: Seams['fabric'] = (address, token) => {
    assert.equal(address, 'rpc.demeter.run:443')
    assert.equal(token, 'token-abc')
    return {
      async createProject() {
        if (fail.createProject) throw new Error(fail.createProject)
        if (!quirks.neverListed) state.projects.add('p-1')
        return { id: 'p-1', namespace: 'prj-e2e' }
      },
      async deleteProject(id) {
        if (fail.deleteProject) throw new Error(fail.deleteProject)
        state.deleted.push(id)
        if (!quirks.staysListed) state.projects.delete(id)
      },
      async projectIds() {
        return [...state.projects]
      },
      async createResource(projectId, kind, spec) {
        if (fail.createResource === kind) throw new Error(`CreateResource: INTERNAL (${kind})`)
        state.created.push(`${projectId}/${kind}`)
        state.specs.push(spec)
        return { id: `r-${kind}`, name: kind.toLowerCase() }
      },
      async resourceSpec(id) {
        return { authToken: `key-${id}` }
      },
    }
  }
  return { state, fabric }
}

const kind = (name: string, check: Kind['check']): Kind => ({ kind: name, label: name, claim: 'answers', spec: { of: name }, check })

async function runSuite(seams: Seams, env: Record<string, string | undefined> = {}): Promise<Result> {
  return withEnv({ E2E_USER_PASSWORD: 'pw', AUTH0_CLIENT_ID: 'cid', AUTH0_CLIENT_SECRET: 'csecret', GITHUB_ACTIONS: undefined, ...env }, async () => {
    const run = new Run('ports', 'production')
    await portSuite({ sleep: async () => {}, signIn: async () => 'token-abc', ...seams }).run({ env: environments.production, run })
    return run.finish()
  })
}

describe('the port suite', () => {
  it('creates each kind, checks it against the node tip, and deletes only its own project', async () => {
    const { state, fabric } = fakeFabric()
    const tips: (number | null)[] = []
    const result = await runSuite({
      fabric,
      kinds: [
        kind('CardanoNodePort', async () => ({ detail: 'synced', slot: 1_000 })),
        kind('KupoPort', async ({ tip, key }) => {
          tips.push(tip)
          assert.equal(key, 'key-r-KupoPort')
          return { detail: 'at tip' }
        }),
      ],
    })
    assert.equal(result.ok, true, JSON.stringify(result.steps))
    assert.deepEqual(
      result.steps.map((s) => s.name),
      [
        'sign in as e2e@txpipe.io',
        'create a project',
        'the project is listed',
        'CardanoNodePort: create CardanoNodePort',
        'CardanoNodePort: answers',
        'KupoPort: create KupoPort',
        'KupoPort: answers',
        'delete the project',
        'the project is no longer listed',
      ],
    )
    assert.deepEqual(tips, [1_000 - 120])
    assert.deepEqual(state.created, ['p-1/CardanoNodePort', 'p-1/KupoPort'])
    assert.deepEqual(state.specs, [{ of: 'CardanoNodePort' }, { of: 'KupoPort' }])
    assert.deepEqual(state.deleted, ['p-1'])
    assert.deepEqual([...state.projects], ['someone-elses'])
  })

  it('takes the tip from the node alone, not from a kind after it that reads a slot', async () => {
    const { fabric } = fakeFabric()
    const tips: (number | null)[] = []
    const result = await runSuite({
      fabric,
      kinds: [
        kind('CardanoNodePort', async () => ({ detail: 'synced', slot: 1_000 })),
        kind('KupoPort', async ({ tip }) => {
          tips.push(tip)
          return { detail: 'at tip', slot: 5_000 }
        }),
        kind('OgmiosPort', async ({ tip }) => {
          tips.push(tip)
          return { detail: 'at tip' }
        }),
      ],
    })
    assert.equal(result.ok, true, JSON.stringify(result.steps))
    assert.deepEqual(tips, [880, 880])
  })

  it('fails when the deleted project is still listed', async () => {
    const { state, fabric } = fakeFabric({}, { staysListed: true })
    const result = await runSuite({ fabric, kinds: [] })
    assert.equal(result.ok, false)
    assert.deepEqual(state.deleted, ['p-1'])
    const last = result.steps.at(-1)!
    assert.deepEqual([last.name, last.ok, last.detail], ['the project is no longer listed', false, 'FetchProjects still lists p-1 after 5 reads'])
  })

  it('fails when the created project is never listed, and still checks the kinds and deletes it', async () => {
    const { state, fabric } = fakeFabric({}, { neverListed: true })
    const result = await runSuite({ fabric, kinds: [kind('KupoPort', async () => ({ detail: 'at tip' }))] })
    assert.equal(result.ok, false)
    assert.deepEqual(
      result.steps.filter((s) => !s.ok).map((s) => [s.name, s.detail]),
      [['the project is listed', 'FetchProjects does not list p-1 after 5 reads']],
    )
    assert.ok(result.steps.some((s) => s.name === 'KupoPort: answers' && s.ok))
    assert.deepEqual(state.deleted, ['p-1'])
  })

  it('checks every kind after one fails, and still deletes the project', async () => {
    const { state, fabric } = fakeFabric({ createResource: 'OgmiosPort' })
    const checked: string[] = []
    const result = await runSuite({
      fabric,
      kinds: ['CardanoNodePort', 'OgmiosPort', 'KupoPort'].map((name) =>
        kind(name, async ({ tip }) => {
          checked.push(name)
          if (name === 'CardanoNodePort') throw new Error('syncProgress 97.00 at slot 1, not within 99–100')
          if (tip === null) throw new Error('answered at slot 5, but there is no node tip to compare it with')
          return { detail: '' }
        }),
      ),
    })
    assert.equal(result.ok, false)
    assert.deepEqual(checked, ['CardanoNodePort', 'KupoPort'])
    assert.deepEqual(
      result.steps.filter((s) => !s.ok).map((s) => s.name),
      ['CardanoNodePort: answers', 'OgmiosPort: create OgmiosPort', 'KupoPort: answers'],
    )
    assert.deepEqual(state.deleted, ['p-1'])
  })

  it('keeps the token, the credentials and each port key out of every detail', async () => {
    const { fabric } = fakeFabric()
    const result = await runSuite({
      fabric,
      kinds: [
        kind('BlockfrostPort', async ({ key }) => {
          throw new Error(`getaddrinfo ENOTFOUND ${key}.blockfrost-m1.demeter.run (token-abc, pw, csecret)`)
        }),
      ],
    })
    const detail = result.steps.find((s) => s.name === 'BlockfrostPort: answers')!.detail
    assert.equal(detail, 'getaddrinfo ENOTFOUND ***.blockfrost-m1.demeter.run (***, ***, ***)')
    assert.doesNotMatch(JSON.stringify(result), /key-r-|token-abc|csecret/)
  })

  it('stops at a failed sign-in, creating nothing', async () => {
    const { state, fabric } = fakeFabric()
    const result = await runSuite({ fabric }, { AUTH0_CLIENT_SECRET: undefined })
    assert.deepEqual(
      result.steps.map(({ name, ok, detail }) => ({ name, ok, detail })),
      [{ name: 'sign in as e2e@txpipe.io', ok: false, detail: 'AUTH0_CLIENT_SECRET not set' }],
    )
    assert.deepEqual(state.created, [])
  })

  it('stops at a failed project creation, deleting nothing', async () => {
    const { state, fabric } = fakeFabric({ createProject: 'CreateProject: UNAUTHENTICATED (authentication is required)' })
    const result = await runSuite({ fabric })
    assert.deepEqual(
      result.steps.map((s) => [s.name, s.ok]),
      [
        ['sign in as e2e@txpipe.io', true],
        ['create a project', false],
      ],
    )
    assert.deepEqual(state.deleted, [])
  })

  it('fails when the project cannot be deleted', async () => {
    const { fabric } = fakeFabric({ deleteProject: 'DeleteProject: UNAVAILABLE' })
    const result = await runSuite({ fabric, kinds: [] })
    assert.equal(result.ok, false)
    assert.deepEqual(result.steps.at(-1), {
      ...result.steps.at(-1)!,
      name: 'delete the project',
      ok: false,
      detail: 'p-1 is left behind: DeleteProject: UNAVAILABLE',
    })
  })

  /**
   * A suite of one kind whose sleeps and fabric calls are logged in order;
   * `lists` and `specs` answer the nth `FetchProjects` and `FetchResourcesById`.
   */
  async function polled(lists: (n: number) => string[] | Error, specs: (n: number) => Record<string, unknown> | null | Error) {
    const log: string[] = []
    const counts = { lists: 0, specs: 0 }
    const answer = <T>(a: T | Error): T => {
      if (a instanceof Error) throw a
      return a
    }
    const result = await runSuite({
      sleep: async (ms) => void log.push(`sleep ${ms}`),
      kinds: [kind('KupoPort', async () => ({ detail: 'at tip' }))],
      fabric: () => ({
        async createProject() {
          log.push('CreateProject')
          return { id: 'p-1', namespace: 'prj-e2e' }
        },
        async deleteProject() {
          log.push('DeleteProject')
        },
        async projectIds() {
          log.push('FetchProjects')
          return answer(lists(++counts.lists))
        },
        async createResource() {
          log.push('CreateResource')
          return { id: 'r-1', name: 'kupo' }
        },
        async resourceSpec() {
          log.push('FetchResourcesById')
          return answer(specs(++counts.specs))
        },
      }),
    })
    return { result, log, counts }
  }

  it('reads until the project and the key arrive, sleeping before each read and riding out a failed one', async () => {
    const unavailable = (call: string) => new Error(`${call}: UNAVAILABLE (connection reset)`)
    const lists = [unavailable('FetchProjects'), [], ['p-1'], ['p-1'], unavailable('FetchProjects'), []]
    const specs = [unavailable('FetchResourcesById'), null, {}, { authToken: 'key-1' }]
    const { result, log } = await polled(
      (n) => lists[n - 1]!,
      (n) => specs[n - 1]!,
    )
    assert.equal(result.ok, true, JSON.stringify(result.steps))
    const wait = 'sleep 3000'
    assert.deepEqual(log, [
      'CreateProject',
      ...[wait, 'FetchProjects', wait, 'FetchProjects', wait, 'FetchProjects'],
      wait,
      'CreateResource',
      ...[wait, 'FetchResourcesById', wait, 'FetchResourcesById', wait, 'FetchResourcesById', wait, 'FetchResourcesById'],
      'DeleteProject',
      ...[wait, 'FetchProjects', wait, 'FetchProjects', wait, 'FetchProjects'],
    ])
    assert.equal(
      result.steps.find((s) => s.name === 'the project is listed')!.detail,
      'FetchProjects lists 1 project(s), including p-1',
    )
    assert.equal(result.steps.find((s) => s.name === 'KupoPort: create KupoPort')!.detail, 'kupo (r-1)')
  })

  it('stops after five reads, failing with what the last one said', async () => {
    const { result, counts } = await polled(
      () => [],
      (n) => (n < 5 ? null : new Error('FetchResourcesById: UNAVAILABLE (connection reset)')),
    )
    assert.deepEqual(counts, { lists: 6, specs: 5 })
    assert.deepEqual(
      result.steps.filter((s) => !s.ok).map((s) => [s.name, s.detail]),
      [
        ['the project is listed', 'FetchProjects does not list p-1 after 5 reads'],
        ['KupoPort: create KupoPort', 'kupo (r-1): FetchResourcesById: UNAVAILABLE (connection reset) after 5 reads'],
      ],
    )
    const { result: noKey } = await polled(
      (n) => (n <= 1 ? ['p-1'] : []),
      () => ({ network: 'mainnet' }),
    )
    assert.equal(noKey.steps.find((s) => s.name === 'KupoPort: create KupoPort')!.detail, 'kupo (r-1): no authToken in its spec after 5 reads')
  })
})

describe('pnpm ports', () => {
  it('takes no check names', async () => {
    const error = mock.method(console, 'error', () => {})
    try {
      const code = await main(['pricing', '--env', 'production'], { checks: [portSuite()], suite: { command: 'ports', title: 'Port suite' } })
      assert.equal(code, 2)
      assert.match(String(error.mock.calls[0]?.arguments[0]), /^pnpm ports takes no check names\n\nusage: pnpm ports --env <name>/)
    } finally {
      error.mock.restore()
    }
  })
})

/** A fabric whose calls are recorded and answered by `answer`. */
function recordedFabric(answer: (call: Call) => Uint8Array) {
  const calls: Call[] = []
  const fabric = new Fabric('rpc.demeter.run:443', 'token-abc', async (call) => {
    calls.push(call)
    return answer(call)
  })
  return { calls, fabric }
}

/** A length-delimited field holding `message`, as protobuf nests one. */
const nested = (number: number, message: Uint8Array) => Uint8Array.from([(number << 3) | 2, message.length, ...message])

describe('fabric', () => {
  it('lists project ids from FetchProjects records', async () => {
    const project = (id: string) => nested(2, encodeStrings({ 1: id, 2: `name of ${id}`, 3: `prj-${id}` }))
    const { calls, fabric } = recordedFabric(() => Uint8Array.from([...project('p-1'), ...project('p-2')]))
    assert.deepEqual(await fabric.projectIds(), ['p-1', 'p-2'])
    const [call] = calls
    assert.equal(call!.method, '/demeter.ops.v1alpha.ProjectService/FetchProjects')
    assert.deepEqual(call!.headers, { authorization: 'Bearer token-abc' })
    // FetchProjectsRequest { page = 1, page_size = 2 }: one page of 100.
    assert.equal(varint(call!.request, 2), 100)
    assert.equal(varint(call!.request, 1), null)
  })

  it('creates a resource with its kind and its spec as JSON, and reads the key back from its spec', async () => {
    const { calls, fabric } = recordedFabric((call) =>
      call.method.endsWith('/CreateResource')
        ? encodeStrings({ 1: 'r-1', 2: 'kupo-abc' })
        : nested(1, encodeStrings({ 1: 'r-1', 4: '{"network":"mainnet","authToken":"dmtr_kupo1"}' })),
    )
    assert.deepEqual(await fabric.createResource('p-1', 'KupoPort', { network: 'mainnet', pruneUtxo: true }), { id: 'r-1', name: 'kupo-abc' })
    assert.deepEqual(await fabric.resourceSpec('r-1'), { network: 'mainnet', authToken: 'dmtr_kupo1' })
    assert.deepEqual(
      calls.map((c) => [c.method, c.headers, string(c.request, 1), string(c.request, 2), string(c.request, 3)]),
      [
        ['/demeter.ops.v1alpha.ResourceService/CreateResource', { authorization: 'Bearer token-abc' }, 'p-1', 'KupoPort', '{"network":"mainnet","pruneUtxo":true}'],
        ['/demeter.ops.v1alpha.ResourceService/FetchResourcesById', { authorization: 'Bearer token-abc' }, 'r-1', '', ''],
      ],
    )
  })

  it('fails a resource with no id, and reads no record as null', async () => {
    const { fabric } = recordedFabric(() => encodeStrings({ 2: 'kupo-abc' }))
    await assert.rejects(fabric.createResource('p-1', 'KupoPort', {}), { message: 'CreateResource answered no resource id' })
    const { fabric: empty } = recordedFabric(() => new Uint8Array())
    assert.equal(await empty.resourceSpec('r-1'), null)
  })

  it('deletes the project by its id', async () => {
    const { calls, fabric } = recordedFabric(() => new Uint8Array())
    await fabric.deleteProject('p-1')
    assert.deepEqual(
      calls.map((c) => [c.method, string(c.request, 1)]),
      [['/demeter.ops.v1alpha.ProjectService/DeleteProject', 'p-1']],
    )
  })

  it('gives CreateProject a minute, so a slow commit is not a project the run cannot delete', async () => {
    const { calls, fabric } = recordedFabric(() => encodeStrings({ 1: 'p-1', 2: 'e2e project', 3: 'prj-e2e' }))
    assert.deepEqual(await fabric.createProject('e2e project'), { id: 'p-1', namespace: 'prj-e2e' })
    assert.equal(calls[0]!.timeoutMs, 60_000)
    assert.equal(string(calls[0]!.request, 1), 'e2e project')
  })

  it('reports a spec that is not JSON without quoting it', async () => {
    const { fabric } = recordedFabric(() => nested(1, encodeStrings({ 1: 'r-1', 4: '{"authToken":"dmtr_secret' })))
    await assert.rejects(fabric.resourceSpec('r-1'), (error: Error) => {
      assert.equal(error.message, 'FetchResourcesById answered a spec that is not JSON')
      return true
    })
  })
})

describe('sign-in', () => {
  const credentials = { username: 'e2e@txpipe.io', password: 'pw', clientId: 'cid', clientSecret: 'csecret', audience: 'demeter-api' }

  function auth0(answer: Response | Error) {
    const requests: { url: string; init: RequestInit }[] = []
    const send = (async (url: string, init: RequestInit) => {
      requests.push({ url, init })
      if (answer instanceof Error) throw answer
      return answer
    }) as typeof fetch
    return { requests, send }
  }

  it('asks Auth0 for a password grant, the secrets in the body only', async () => {
    const { requests, send } = auth0(Response.json({ access_token: 'token-abc', token_type: 'Bearer' }))
    assert.equal(await signIn('https://txpipe.us.auth0.com', credentials, send), 'token-abc')
    const [{ url, init }] = requests as [{ url: string; init: RequestInit }]
    assert.equal(url, 'https://txpipe.us.auth0.com/oauth/token')
    assert.equal(init.method, 'POST')
    assert.deepEqual(init.headers, { 'content-type': 'application/x-www-form-urlencoded' })
    assert.deepEqual(Object.fromEntries(init.body as URLSearchParams), {
      grant_type: 'password',
      username: 'e2e@txpipe.io',
      password: 'pw',
      audience: 'demeter-api',
      scope: 'profile openid email',
      client_id: 'cid',
      client_secret: 'csecret',
    })
  })

  it('fails naming what Auth0 said', async () => {
    const refused = Response.json({ error: 'unauthorized_client', error_description: "Grant type 'password' not allowed for the client." }, { status: 403 })
    await assert.rejects(signIn('https://txpipe.us.auth0.com', credentials, auth0(refused).send), {
      message: "Auth0 answered HTTP 403 with no access token: unauthorized_client (Grant type 'password' not allowed for the client.)",
    })
    await assert.rejects(signIn('https://txpipe.us.auth0.com', credentials, auth0(Response.json({}, { status: 200 })).send), {
      message: 'Auth0 answered HTTP 200 with no access token',
    })
    const unreachable = new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND txpipe.us.auth0.com'), { code: 'ENOTFOUND' }) })
    await assert.rejects(signIn('https://txpipe.us.auth0.com', credentials, auth0(unreachable).send), {
      message: 'ENOTFOUND (getaddrinfo ENOTFOUND txpipe.us.auth0.com)',
    })
  })
})

describe('fetchNamingCause', () => {
  const failing = (error: Error) => (async () => {
    throw error
  }) as unknown as typeof fetch

  it('names a timeout by its name, not its legacy numeric code', async () => {
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    assert.equal(timeout.code, 23)
    await assert.rejects(fetchNamingCause('https://example.invalid', {}, failing(timeout)), {
      message: 'TimeoutError (The operation was aborted due to timeout)',
    })
  })

  it('names each address a dual-stack connection was refused on', async () => {
    const refused = (address: string) => Object.assign(new Error(`connect ECONNREFUSED ${address}`), { code: 'ECONNREFUSED' })
    const cause = Object.assign(new AggregateError([refused('::1:443'), refused('127.0.0.1:443')], ''), { code: 'ECONNREFUSED' })
    await assert.rejects(fetchNamingCause('https://localhost', {}, failing(new TypeError('fetch failed', { cause }))), {
      message: 'ECONNREFUSED (connect ECONNREFUSED ::1:443; connect ECONNREFUSED 127.0.0.1:443)',
    })
  })
})

describe('the port kinds', () => {
  it('are fabric’s, in its order, each with the spec its script sends', () => {
    // fabric's test/e2e, each `create_port` call's spec as it is written there.
    assert.deepEqual(
      kinds.map((k) => [k.kind, JSON.stringify(k.spec)]),
      [
        ['CardanoNodePort', '{"network":"mainnet","version":"stable","throughputTier":"0"}'],
        ['BlockfrostPort', '{"network":"mainnet","throughputTier":"0","operatorVersion":"1"}'],
        ['KupoPort', '{"network":"mainnet","throughputTier":"0","pruneUtxo":true,"operatorVersion":"1"}'],
        ['OgmiosPort', '{"network":"mainnet","throughputTier":"0","version":6}'],
        ['UtxoRpcPort', '{"network":"mainnet","throughputTier":"0","operatorVersion":"1"}'],
        ['SubmitApiPort', '{"network":"mainnet","throughputTier":"0","operatorVersion":"1"}'],
      ],
    )
  })

  const hosts = environments.production.ports!.hosts
  const now = 1_790_000_000
  /** The slot at unix time `t`, on mainnet. */
  const slotAt = (t: number) => mainnet.shelleySlot + (t - mainnet.shelleyStart)

  function probe(tip: number | null = 900) {
    const sleeps: number[] = []
    const value: Probe = { key: 'k', hosts, tip, sleep: async (ms) => void sleeps.push(ms) }
    return { probe: value, sleeps }
  }

  /** The kinds, with `fetch` answered by `answer` (a Response, or an error to throw) and each request recorded. */
  function reach(answer: (url: string, n: number) => Response | Error, more: Partial<Reach> = {}) {
    const requests: { url: string; init: RequestInit }[] = []
    const fetch = (async (url: string, init: RequestInit) => {
      requests.push({ url, init })
      const answered = answer(url, requests.length)
      if (answered instanceof Error) throw answered
      return answered
    }) as typeof globalThis.fetch
    const kinds = portKinds({ fetch, now: () => now, ...more })
    return { requests, kind: (name: string) => kinds.find((k) => k.kind === name)! }
  }

  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

  /** What each HTTP kind answers, and the field its slot is read from. */
  const httpKinds = [
    { name: 'BlockfrostPort', url: `https://k.${hosts.blockfrost}/blocks/latest`, body: (slot: number) => ({ slot, height: 1 }) },
    { name: 'KupoPort', url: `https://k.${hosts.kupo}/health`, body: (slot: number) => ({ most_recent_checkpoint: slot, most_recent_node_tip: 1 }) },
    { name: 'OgmiosPort', url: `https://k.${hosts.ogmios}/health`, body: (slot: number) => ({ lastKnownTip: { slot, height: 1 } }) },
  ]

  for (const { name, url, body } of httpKinds) {
    it(`${name} passes at the tip, reading its own field from its own URL`, async () => {
      const { requests, kind } = reach(() => json(body(900)))
      const { slot } = await kind(name).check(probe(900).probe)
      assert.equal(slot, 900)
      assert.deepEqual(
        requests.map((r) => [r.url, (r.init.headers as Record<string, string>).accept]),
        [[url, 'application/json']],
      )
    })

    it(`${name} finds no slot in another kind's answer`, async () => {
      for (const other of httpKinds.filter((k) => k.name !== name)) {
        const { kind } = reach(() => json(other.body(900)))
        await assert.rejects(kind(name).check(probe().probe), /^Error: after 5 attempts: answered no /)
      }
    })
  }

  it('fails a slot behind the tip, and a slot with no tip to compare it with', async () => {
    const { kind } = reach(() => json({ slot: 899 }))
    await assert.rejects(kind('BlockfrostPort').check(probe(900).probe), {
      message: 'is not at the chain tip: slot 899, the node\'s tip less 120 slots is 900',
    })
    await assert.rejects(kind('BlockfrostPort').check(probe(null).probe), {
      message: 'answered at slot 899, but there is no node tip to compare it with',
    })
  })

  it('tries five times, three seconds before each, and fails naming the last cause', async () => {
    const refused = new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND k.kupo'), { code: 'ENOTFOUND' }) })
    const { requests, kind } = reach(() => refused)
    const { probe: p, sleeps } = probe()
    await assert.rejects(kind('KupoPort').check(p), { message: 'after 5 attempts: ENOTFOUND (getaddrinfo ENOTFOUND k.kupo)' })
    assert.equal(requests.length, 5)
    assert.deepEqual(sleeps, [3_000, 3_000, 3_000, 3_000, 3_000])
  })

  it('retries a failed answer or one with no integer slot, and passes when one arrives in budget', async () => {
    const answers = [json({}, 503), new Response('<html>', { status: 200 }), json({ slot: '900' }), json({ slot: 900.5 }), json({ slot: 900 })]
    const { requests, kind } = reach((_url, n) => answers[n - 1]!)
    assert.equal((await kind('BlockfrostPort').check(probe().probe)).slot, 900)
    assert.equal(requests.length, 5)
    const { kind: never } = reach(() => json({ slot: '900' }))
    await assert.rejects(never('BlockfrostPort').check(probe().probe), { message: 'after 5 attempts: answered no slot' })
  })

  describe('the node', () => {
    function node(slots: number[]) {
      const asked: string[] = []
      const queryTip: Reach['queryTip'] = async (address) => {
        asked.push(address)
        return { slot: slots[Math.min(asked.length, slots.length) - 1]!, block: 12_000_000 }
      }
      return { asked, kind: reach(() => new Error('no fetch'), { queryTip }).kind('CardanoNodePort') }
    }

    it('passes at the tip, on the key’s host', async () => {
      const { asked, kind } = node([slotAt(now)])
      const result = await kind.check(probe().probe)
      assert.deepEqual(result, { detail: `syncProgress 100.00 at slot ${slotAt(now)}, block 12000000`, slot: slotAt(now) })
      assert.deepEqual(asked, [`k.${hosts.node}`])
    })

    it('passes at 99.00, and fails at 98.99 after five tries with doubling waits', async () => {
      // cardano-cli's ratio is (tip's seconds + 1 + 600) / (now's seconds + 1),
      // both since the system start; it prints 99.00 from 98.995 up.
      const sb = now - mainnet.systemStart + 1
      const at = (ratio: number) => slotAt(mainnet.systemStart + ratio - 601)
      const lowest = Math.ceil(0.98995 * sb)
      assert.equal(syncProgress(at(lowest), now), 99)
      assert.equal(syncProgress(at(lowest) - 1, now), 98.99)
      assert.ok(slotTime(at(lowest)) < now - 600)

      assert.equal((await node([at(lowest)]).kind.check(probe().probe)).slot, at(lowest))
      const behind = node([at(lowest) - 1])
      const { probe: p, sleeps } = probe()
      await assert.rejects(behind.kind.check(p), { message: `after 5 attempts: syncProgress 98.99 at slot ${at(lowest) - 1}, not within 99–100` })
      assert.deepEqual(sleeps, [3_000, 6_000, 12_000, 24_000, 48_000])
      assert.equal(behind.asked.length, 5)
    })
  })

  describe('UTxO RPC', () => {
    function utxorpc(response: Uint8Array) {
      const calls: Call[] = []
      const unary: Reach['unary'] = async (call) => {
        calls.push(call)
        return response
      }
      return { calls, kind: reach(() => new Error('no fetch'), { unary }).kind('UtxoRpcPort') }
    }

    it('reads ReadParams’ ledger tip with the key in a header', async () => {
      // ReadParamsResponse { values = 1, ledger_tip = 2 { slot = 1, hash = 2 } }
      const tip = Uint8Array.from([...encodeVarints({ 1: 900 }), ...encodeStrings({ 2: 'hash' })])
      const { calls, kind } = utxorpc(Uint8Array.from([...encodeStrings({ 1: 'params' }), ...nested(2, tip)]))
      assert.equal((await kind.check(probe(900).probe)).slot, 900)
      assert.deepEqual(
        calls.map(({ address, method, headers }) => ({ address, method, headers })),
        [{ address: hosts.utxorpc, method: '/utxorpc.v1alpha.query.QueryService/ReadParams', headers: { 'dmtr-api-key': 'k' } }],
      )
    })

    it('fails an answer with no ledger tip', async () => {
      const { calls, kind } = utxorpc(encodeStrings({ 1: 'params' }))
      await assert.rejects(kind.check(probe().probe), { message: 'after 5 attempts: answered no ledger tip' })
      assert.equal(calls.length, 5)
    })
  })

  describe('the Submit API', () => {
    it('passes when an empty transaction is refused with 400, trying at once', async () => {
      const { requests, kind } = reach(() => new Response('bad tx', { status: 400 }))
      const { probe: p, sleeps } = probe()
      assert.deepEqual(await kind('SubmitApiPort').check(p), { detail: 'POST /api/submit/tx with an empty body answered 400' })
      assert.deepEqual(
        requests.map(({ url, init }) => [url, init.method, init.body, (init.headers as Record<string, string>)['content-type']]),
        [[`https://k.${hosts.submitapi}/api/submit/tx`, 'POST', '', 'application/cbor']],
      )
      assert.deepEqual(sleeps, [0])
    })

    it('fails a refusal that is not the submit API’s 400', async () => {
      for (const status of [401, 403, 404]) {
        const { kind } = reach(() => new Response('', { status }))
        await assert.rejects(kind('SubmitApiPort').check(probe().probe), {
          message: `after 5 attempts: POST /api/submit/tx with an empty body answered HTTP ${status}, wanted 400`,
        })
      }
    })

    it('fails any other answer after five tries, three seconds apart', async () => {
      const { requests, kind } = reach(() => new Response('', { status: 202 }))
      const { probe: p, sleeps } = probe()
      await assert.rejects(kind('SubmitApiPort').check(p), {
        message: 'after 5 attempts: POST /api/submit/tx with an empty body answered HTTP 202, wanted 400',
      })
      assert.equal(requests.length, 5)
      assert.deepEqual(sleeps, [0, 3_000, 3_000, 3_000, 3_000])
    })
  })
})
