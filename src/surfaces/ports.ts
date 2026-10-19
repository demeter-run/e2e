/**
 * One port, three spellings. fabric names a port by its CRD file, the Console
 * by a catalog slug, website2 by a display name; a check compares them through
 * the ids here.
 *
 * A Console slug or website2 name missing from these tables fails the check
 * that meets it: a surface pricing a port no check can place is drift too.
 */

/** fabric `bootstrap/rpc/crds/<stem>.json`. A stem not listed keeps its own name. */
export const fabricStems: Record<string, string> = {
  baliusworker: 'balius',
  blockfrostport: 'blockfrost',
  cardanonodeport: 'node',
  dbsyncport: 'dbsync',
  kupoport: 'kupo',
  marloweport: 'marlowe',
  mumakport: 'mumak',
  ogmiosport: 'ogmios',
  scrollsport: 'scrolls',
  submitapiport: 'submitapi',
  trpport: 'trp',
  utxorpcport: 'utxorpc',
}

/** The Console's `PRICING` keys in `src/app/utils/pricing/values.ts`. */
export const consoleSlugs: Record<string, string> = {
  'cardano-blockfrost-port': 'blockfrost',
  'cardano-dbsync-port': 'dbsync',
  'cardano-kupo-port': 'kupo',
  'cardano-marlowe-port': 'marlowe',
  'cardano-node-port': 'node',
  'cardano-ogmios-port': 'ogmios',
  'cardano-submitapi-port': 'submitapi',
  'cardano-utxorpc': 'utxorpc',
}

/** website2's `ports[].name` in `src/content/portPricing.ts`. */
export const website2Names: Record<string, string> = {
  Blockfrost: 'blockfrost',
  // The table's name for it before the rate card (website2#10).
  'Blockfrost RYO': 'blockfrost',
  Kupo: 'kupo',
  Ogmios: 'ogmios',
  'UTxO RPC': 'utxorpc',
}

/** The ports the published rate card covers, quoted on all three surfaces. */
export const cardPorts = ['ogmios', 'kupo', 'blockfrost', 'utxorpc']

const displayNames: Record<string, string> = {
  balius: 'Balius',
  blockfrost: 'Blockfrost',
  dbsync: 'DB Sync',
  kupo: 'Kupo',
  marlowe: 'Marlowe',
  mumak: 'Mumak',
  node: 'Cardano Node',
  ogmios: 'Ogmios',
  scrolls: 'Scrolls',
  submitapi: 'Submit API',
  trp: 'TRP',
  utxorpc: 'UTxO RPC',
}

export const portName = (id: string): string => displayNames[id] ?? id

/** fabric's throughput tiers, by the names the Console and website2 give them. */
const tierNames: Record<string, string> = { '0': 'Free', '1': 'Flexible', '2': 'Pro I', '3': 'Pro II' }

export const tierName = (tier: string): string => tierNames[tier] ?? `tier ${tier}`
