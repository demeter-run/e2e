import { readdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { Card } from './card.ts'
import { fabricStems } from './ports.ts'

/** Where fabric keeps the per-kind metadata its RPC serves. */
export const crdDir = 'bootstrap/rpc/crds'

/**
 * One tier of one port kind, from `plan.<tier>` in its CRD metadata
 * (`ResourceMetadataPlan`, `src/domain/metadata/mod.rs`). `cost.minimum` is
 * USD per month; `cost.delta` is USD per metered unit.
 */
export interface FabricTier {
  port: string
  /** The CRD file's stem, e.g. `blockfrostport`. */
  kind: string
  tier: string
  dns: string
  cost: { minimum: number; delta: number } | null
}

interface CrdMetadata {
  plan?: Record<string, { dns?: unknown; cost?: { minimum?: unknown; delta?: unknown } | null }>
}

/** Every tier of every `bootstrap/rpc/crds/*.json` in a fabric tree. */
export async function readFabricTiers(fabricDir: string): Promise<FabricTier[]> {
  const dir = join(fabricDir, crdDir)
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort()
  if (files.length === 0) throw new Error(`${dir}: no CRD metadata`)
  const tiers: FabricTier[] = []
  for (const file of files) {
    const kind = basename(file, '.json')
    const metadata = JSON.parse(await readFile(join(dir, file), 'utf8')) as CrdMetadata
    if (!metadata.plan || Object.keys(metadata.plan).length === 0) throw new Error(`${file}: no plan tiers`)
    for (const [tier, plan] of Object.entries(metadata.plan)) {
      if (typeof plan.dns !== 'string') throw new Error(`${file}: plan.${tier}.dns is not a string`)
      let cost: FabricTier['cost'] = null
      if (plan.cost) {
        const { minimum, delta } = plan.cost
        if (typeof minimum !== 'number' || typeof delta !== 'number') {
          throw new Error(`${file}: plan.${tier}.cost needs numeric minimum and delta`)
        }
        cost = { minimum, delta }
      }
      tiers.push({ port: fabricStems[kind] ?? kind, kind, tier, dns: plan.dns, cost })
    }
  }
  return tiers
}

/** fabric's price, which is what it bills: `delta` per unit is `delta × 100000` per 100k. */
export function fabricCards(tiers: FabricTier[]): Card[] {
  return tiers.map(({ port, tier, cost }) => ({
    port,
    tier,
    minimum_usd: cost ? cost.minimum : null,
    per_100k_usd: cost ? cost.delta * 100_000 : null,
  }))
}
