/**
 * The port kinds the mock knows and the networks each offers, as fabric's
 * catalog (`bootstrap/rpc/crds/<kind>.json`, fabric `d887e2b`, 2026-10-18)
 * lists them. The Console reads the same catalog from fabric's metadata: a
 * kind that is not here is `400 invalid_request`, and a kind with no option on
 * the requested network is `403 pre_claim_limit`. Marlowe, Mumak and Scrolls
 * name their networks without the `cardano-` prefix, so a `cardano-preprod`
 * request finds no option for them, as it does in production.
 */
export const catalog: Record<string, string[]> = {
  BlockfrostPort: ['cardano-mainnet', 'cardano-preprod', 'cardano-preview', 'prime-testnet', 'vector-mainnet', 'vector-testnet'],
  CardanoNodePort: ['cardano-mainnet', 'cardano-preprod', 'cardano-preview', 'prime-testnet', 'vector-mainnet', 'vector-testnet'],
  DbSyncPort: ['cardano-mainnet', 'cardano-preprod', 'cardano-preview', 'prime-testnet', 'vector-mainnet', 'vector-testnet'],
  KupoPort: ['cardano-mainnet', 'cardano-preprod', 'cardano-preview'],
  MarlowePort: ['mainnet', 'preprod', 'preview'],
  MumakPort: ['mainnet', 'preprod', 'preview'],
  OgmiosPort: ['cardano-mainnet', 'cardano-preprod', 'cardano-preview', 'prime-testnet', 'vector-testnet'],
  ScrollsPort: ['mainnet', 'preprod', 'preview'],
  SubmitApiPort: ['cardano-mainnet', 'cardano-preprod', 'cardano-preview', 'prime-testnet', 'vector-mainnet', 'vector-testnet'],
  TrpPort: ['cardano-mainnet', 'cardano-preprod', 'cardano-preview'],
  UtxoRpcPort: ['cardano-mainnet', 'cardano-preprod', 'cardano-preview', 'vector-testnet'],
}

/** The only networks an unclaimed project may use (the contract's `pre_claim_limit`). */
export const preClaimNetworks = ['cardano-preprod', 'cardano-preview']

/** The canonical spelling of `kind`, matched without regard to case as the Console does; undefined when unknown. */
export const canonicalKind = (kind: string): string | undefined =>
  Object.keys(catalog).find((known) => known.toLowerCase() === kind.toLowerCase())

/** `OgmiosPort` on `cardano-preprod` → `DEMETER_OGMIOS_PREPROD`, the prefix of a port's dotenv lines. */
export const variablePrefix = (kind: string, network: string): string =>
  `DEMETER_${kind.toUpperCase().replace(/PORT$/, '')}_${network.replace(/^cardano-/, '').toUpperCase()}`
