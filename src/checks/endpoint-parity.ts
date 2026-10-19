import { crdDir, type FabricTier, readFabricTiers } from '../surfaces/fabric.ts'
import type { Check } from './check.ts'

/**
 * website2 promises "Switching plan or port never changes your endpoints"
 * (`src/content/portPricing.ts:34`). In fabric that holds because an endpoint
 * host is rendered from `bootstrap/rpc/crds/<kind>.hbs` with the tier's
 * `plan.<tier>.dns` and an `authToken` fixed when the port is created
 * (`src/domain/resource/command.rs:125-133`); a tier change only merge-patches
 * the spec. So the promise is exactly this: every tier of a kind carries the
 * same `dns`. Checked statically, so no paid tier is bought to prove it.
 */
export const endpointParity: Check = {
  name: 'endpoint-parity',
  summary: 'every tier of every port kind renders the same endpoint host',
  mode: 'static',
  async run({ sources, run }) {
    let tiers: FabricTier[] = []
    await run.step('read fabric', async () => {
      tiers = await readFabricTiers(await sources.dir('fabric'))
      return `${await sources.describe('fabric')}: ${new Set(tiers.map((t) => t.kind)).size} kinds in ${crdDir}`
    })

    const kinds = [...new Set(tiers.map((t) => t.kind))].sort()
    for (const kind of kinds) {
      const plans = tiers.filter((t) => t.kind === kind)
      await run.step(`${kind}: one dns on every tier`, () => {
        const hosts = new Set(plans.map((t) => t.dns))
        const listing = plans.map((t) => `${t.tier} → ${t.dns}`).join(', ')
        if (hosts.size !== 1) throw new Error(`tiers disagree: ${listing}`)
        return listing
      })
    }
  },
}
