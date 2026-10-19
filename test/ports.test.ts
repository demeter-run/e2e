import assert from 'node:assert/strict'
import { once } from 'node:events'
import { type AddressInfo, connect, createServer, type Socket } from 'node:net'
import { describe, it, mock } from 'node:test'
import { main } from '../src/cli/main.ts'
import { environments } from '../src/env.ts'
import { type Cbor, decode, encode, Incomplete, Tagged } from '../src/ports/cbor.ts'
import { portSuite, type Seams } from '../src/ports/index.ts'
import type { Kind } from '../src/ports/kinds.ts'
import { mainnet, queryTip, syncProgress } from '../src/ports/node.ts'
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
    assert.equal(syncProgress(200_000_000 - 599, now), 100)
    const progress = syncProgress(200_000_000 - 86_400 * 40, now)
    assert.ok(progress > 98 && progress < 99, String(progress))
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
})

/** A fabric that keeps its projects in memory; `fail` makes one of its calls throw. */
function fakeFabric(fail: Partial<Record<'createProject' | 'deleteProject' | 'createResource', string>> = {}) {
  const state = { projects: new Set<string>(['someone-elses']), deleted: [] as string[], created: [] as string[] }
  const fabric: Seams['fabric'] = (address, token) => {
    assert.equal(address, 'rpc.demeter.run:443')
    assert.equal(token, 'token-abc')
    return {
      async createProject() {
        if (fail.createProject) throw new Error(fail.createProject)
        state.projects.add('p-1')
        return { id: 'p-1', namespace: 'prj-e2e' }
      },
      async deleteProject(id) {
        if (fail.deleteProject) throw new Error(fail.deleteProject)
        state.deleted.push(id)
        state.projects.delete(id)
      },
      async projectIds() {
        return [...state.projects]
      },
      async createResource(projectId, kind) {
        if (fail.createResource === kind) throw new Error(`CreateResource: INTERNAL (${kind})`)
        state.created.push(`${projectId}/${kind}`)
        return { id: `r-${kind}`, name: kind.toLowerCase() }
      },
      async resourceSpec(id) {
        return { authToken: `key-${id}` }
      },
    }
  }
  return { state, fabric }
}

const kind = (name: string, check: Kind['check']): Kind => ({ kind: name, label: name, claim: 'answers', spec: {}, check })

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
    assert.deepEqual(state.deleted, ['p-1'])
    assert.deepEqual([...state.projects], ['someone-elses'])
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
          if (tip === null) throw new Error('answered at slot 5, but there is no node tip to compare it with: the node check failed')
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
    assert.deepEqual(result.steps.at(-1), { ...result.steps.at(-1)!, name: 'delete the project', ok: false, detail: 'DeleteProject: UNAVAILABLE' })
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
