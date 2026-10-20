import type { PortSuiteTarget } from '../env.ts'
import { fetchNamingCause } from '../http.ts'
import { unary } from './grpc.ts'
import { queryTip, syncProgress } from './node.ts'
import { messages, varint } from './proto.ts'

/**
 * The port kinds fabric's daily `test/e2e` creates, in its order, with its
 * specs (mainnet, tier 0) and its pass conditions. The node goes first: its
 * slot, less two minutes, is the chain tip every other kind must reach.
 * fabric's Mumak and DbSync blocks are commented out there and stay out here.
 */

/** How far, in slots, a port may trail the node's tip and still be at it: fabric's `NODE_SLOT - 120`. */
export const tipSlack = 120

/** fabric's retry budget: five attempts, three seconds apart. */
export const budget = { attempts: 5, sleepMs: 3_000 }

export interface Probe {
  /** The port's key, from its spec's `authToken`. */
  key: string
  hosts: PortSuiteTarget['hosts']
  /** The node's slot less `tipSlack`, or null when the node's steps found none. */
  tip: number | null
  sleep: (ms: number) => Promise<void>
}

export interface Kind {
  /** fabric's CRD kind. */
  kind: string
  label: string
  /** What the check asserts, as its step is named. */
  claim: string
  spec: Record<string, unknown>
  /**
   * Checks the created port answers as fabric's script requires, within its
   * retry budget, and returns the step's detail. A kind that reads a slot
   * returns it, for the node's tip and the others' comparison.
   */
  check(probe: Probe): Promise<{ detail: string; slot?: number }>
}

/** `fn` until it returns, at most `attempts` times, sleeping `sleepMs(attempt)` before each try; the last error is the failure. */
async function attempt<T>(
  probe: Pick<Probe, 'sleep'>,
  fn: () => Promise<T>,
  { attempts = budget.attempts, sleepMs = (_n: number) => budget.sleepMs } = {},
): Promise<T> {
  let last: unknown
  for (let n = 1; n <= attempts; n++) {
    await probe.sleep(sleepMs(n))
    try {
      return await fn()
    } catch (error) {
      last = error
    }
  }
  throw new Error(`after ${attempts} attempts: ${last instanceof Error ? last.message : String(last)}`)
}

/** What the checks reach the ports with; tests replace them. `now` is unix seconds. */
export interface Reach {
  fetch: typeof fetch
  queryTip: typeof queryTip
  unary: typeof unary
  now: () => number
}

/** GET a port's JSON, as `curl -H 'Accept: application/json' --location`. */
async function getJson(send: typeof fetch, url: string): Promise<unknown> {
  const response = await fetchNamingCause(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) }, send)
  const text = await response.text()
  if (!response.ok) throw new Error(`answered HTTP ${response.status}`)
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`answered HTTP ${response.status} with a body that is not JSON`)
  }
}

/** A slot read from a port, checked against the node's tip. */
function atTip(label: string, slot: number, tip: number | null): { detail: string; slot: number } {
  if (tip === null) throw new Error(`answered at slot ${slot}, but there is no node tip to compare it with`)
  if (slot < tip) throw new Error(`is not at the chain tip: slot ${slot}, the node's tip less ${tipSlack} slots is ${tip}`)
  return { detail: `${label} at slot ${slot}, at or past the node's tip less ${tipSlack} (${tip})`, slot }
}

function slotOf(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error(`answered no ${what}`)
  return value
}

const httpSlot =
  (send: typeof fetch, label: string, url: (p: Probe) => string, read: (body: any) => unknown, what: string): Kind['check'] =>
  async (probe) => {
    const slot = await attempt(probe, async () => slotOf(read(await getJson(send, url(probe))), what))
    return atTip(label, slot, probe.tip)
  }

export function portKinds({
  fetch: send = fetch,
  queryTip: tipOf = queryTip,
  unary: call = unary,
  now = () => Date.now() / 1000,
}: Partial<Reach> = {}): Kind[] {
  return [
    {
      kind: 'CardanoNodePort',
      label: 'Node',
      claim: 'synced: syncProgress within 99–100',
      spec: { network: 'mainnet', version: 'stable', throughputTier: '0' },
      // fabric's `node_port_expect`: sleeps of 3 s doubling, `syncProgress` within 99–100.
      async check(probe) {
        let last = ''
        const tip = await attempt(
          probe,
          async () => {
            const tip = await tipOf(`${probe.key}.${probe.hosts.node}`)
            const progress = syncProgress(tip.slot, now())
            last = `syncProgress ${progress.toFixed(2)} at slot ${tip.slot}`
            if (progress < 99 || progress > 100) throw new Error(`${last}, not within 99–100`)
            return tip
          },
          { sleepMs: (n) => budget.sleepMs * 2 ** (n - 1) },
        )
        return { detail: `${last}, block ${tip.block}`, slot: tip.slot }
      },
    },
    {
      kind: 'BlockfrostPort',
      label: 'Blockfrost',
      claim: 'answers at the chain tip',
      spec: { network: 'mainnet', throughputTier: '0', operatorVersion: '1' },
      check: httpSlot(send, '/blocks/latest', (p) => `https://${p.key}.${p.hosts.blockfrost}/blocks/latest`, (b) => b?.slot, 'slot'),
    },
    {
      kind: 'KupoPort',
      label: 'Kupo',
      claim: 'answers at the chain tip',
      spec: { network: 'mainnet', throughputTier: '0', pruneUtxo: true, operatorVersion: '1' },
      check: httpSlot(send, '/health', (p) => `https://${p.key}.${p.hosts.kupo}/health`, (b) => b?.most_recent_checkpoint, 'most_recent_checkpoint'),
    },
    {
      kind: 'OgmiosPort',
      label: 'Ogmios',
      claim: 'answers at the chain tip',
      spec: { network: 'mainnet', throughputTier: '0', version: 6 },
      check: httpSlot(send, '/health', (p) => `https://${p.key}.${p.hosts.ogmios}/health`, (b) => b?.lastKnownTip?.slot, 'lastKnownTip.slot'),
    },
    {
      kind: 'UtxoRpcPort',
      label: 'UTxO RPC',
      claim: 'answers at the chain tip',
      spec: { network: 'mainnet', throughputTier: '0', operatorVersion: '1' },
      // `QueryService.ReadParams` → `ReadParamsResponse { ledger_tip = 2 }`, `ChainPoint { slot = 1 }`.
      async check(probe) {
        const slot = await attempt(probe, async () => {
          const response = await call({
            address: probe.hosts.utxorpc,
            method: '/utxorpc.v1alpha.query.QueryService/ReadParams',
            request: new Uint8Array(),
            headers: { 'dmtr-api-key': probe.key },
          })
          const [ledgerTip] = messages(response, 2)
          return slotOf(ledgerTip ? varint(ledgerTip, 1) : null, 'ledger tip')
        })
        return atTip('ReadParams', slot, probe.tip)
      },
    },
    {
      kind: 'SubmitApiPort',
      label: 'Submit API',
      claim: 'refuses an empty transaction with 400',
      spec: { network: 'mainnet', throughputTier: '0', operatorVersion: '1' },
      // fabric's `submit_api_port_expect`: an empty CBOR body is refused with 400 by the
      // submit API itself, past the proxy's key check. It sleeps between tries, not before the first.
      async check(probe) {
        await attempt(
          probe,
          async () => {
            const response = await fetchNamingCause(
              `https://${probe.key}.${probe.hosts.submitapi}/api/submit/tx`,
              { method: 'POST', headers: { 'content-type': 'application/cbor' }, body: '', signal: AbortSignal.timeout(15_000) },
              send,
            )
            await response.body?.cancel()
            if (response.status !== 400) throw new Error(`POST /api/submit/tx with an empty body answered HTTP ${response.status}, wanted 400`)
          },
          { sleepMs: (n) => (n === 1 ? 0 : budget.sleepMs) },
        )
        return { detail: 'POST /api/submit/tx with an empty body answered 400' }
      },
    },
  ]
}

export const kinds = portKinds()
