/**
 * One port, several spellings. fabric names a port by its CRD kind, website2
 * by a display name; a check compares them through the ids here.
 *
 * A website2 name missing from these tables fails the check that meets it: a
 * surface pricing a port no check can place is drift too.
 */

/** fabric's CRD kinds, as `FetchMetadata` serves them. A kind not listed keeps its own name, lowercased. */
export const fabricKinds: Record<string, string> = {
  BaliusWorker: 'balius',
  BlockfrostPort: 'blockfrost',
  CardanoNodePort: 'node',
  DbSyncPort: 'dbsync',
  KupoPort: 'kupo',
  MarlowePort: 'marlowe',
  MumakPort: 'mumak',
  OgmiosPort: 'ogmios',
  ScrollsPort: 'scrolls',
  SubmitApiPort: 'submitapi',
  TrpPort: 'trp',
  UtxoRpcPort: 'utxorpc',
}

/** The port names in the `/pricing` table on website2. */
export const website2Names: Record<string, string> = {
  Blockfrost: 'blockfrost',
  // The table's name for it before the rate card (website2#10).
  'Blockfrost RYO': 'blockfrost',
  Kupo: 'kupo',
  Ogmios: 'ogmios',
  'UTxO RPC': 'utxorpc',
}

/** The ports the published rate card covers, quoted on every surface. */
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
