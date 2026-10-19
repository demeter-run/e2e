import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type Card, importModule } from './card.ts'
import { consoleSlugs } from './ports.ts'

/** The Console's price list, by catalog slug. */
export const pricingModule = 'src/app/utils/pricing/values.ts'
/** The route a sign-up or sign-in CTA lands on. */
export const loginRoute = 'src/app/routes/login.tsx'

/** The shape of `PRICING` (`src/app/utils/pricing/types.ts`), as far as prices go. */
export type ConsolePricing = Record<
  string,
  {
    tiers: Record<
      string,
      {
        plans: Record<
          string,
          { cost: { fixed: number; usageBased: number; usageBasedLabel?: string } } | undefined
        >
      }
    >
  }
>

/** The Console's plan ids, as fabric's throughput tiers. */
const planTiers: Record<string, string> = { FREE: '0', FLEXIBLE: '1', PRO_1: '2', PRO_2: '3' }

/**
 * How many metered units each `usageBasedLabel` prices. fabric meters an open
 * connection by the second, so a day of it is 86,400 units.
 */
const labelUnits: Record<string, number> = {
  '100k requests': 100_000,
  '100k messages': 100_000,
  '1000 submits': 1_000,
  '24hs of open connection': 86_400,
}

export async function loadConsolePricing(webuiDir: string): Promise<ConsolePricing> {
  const module = await importModule<{ PRICING?: ConsolePricing }>(join(webuiDir, pricingModule))
  if (!module.PRICING) throw new Error(`${pricingModule}: no PRICING export`)
  return module.PRICING
}

/** The Console's quote for every port and plan it prices. */
export function consoleCards(pricing: ConsolePricing): Card[] {
  const cards: Card[] = []
  for (const [slug, resource] of Object.entries(pricing)) {
    const port = consoleSlugs[slug]
    if (!port) throw new Error(`the Console prices "${slug}", a port this check cannot place: add it to src/surfaces/ports.ts`)
    for (const tier of Object.values(resource.tiers)) {
      for (const [planId, plan] of Object.entries(tier.plans)) {
        if (!plan) continue
        const fabricTier = planTiers[planId]
        if (!fabricTier) throw new Error(`${slug}: unknown plan "${planId}"`)
        const { fixed, usageBased, usageBasedLabel } = plan.cost
        let perUnit = 0
        if (usageBased !== 0) {
          const units = usageBasedLabel === undefined ? undefined : labelUnits[usageBasedLabel]
          if (!units) throw new Error(`${slug} ${planId}: cannot convert "${usageBasedLabel ?? '(no label)'}" to units`)
          perUnit = usageBased / units
        }
        cards.push({ port, tier: fabricTier, minimum_usd: fixed, per_100k_usd: perUnit * 100_000 })
      }
    }
  }
  return cards
}

export async function readLoginRoute(webuiDir: string): Promise<string> {
  return readFile(join(webuiDir, loginRoute), 'utf8')
}

/**
 * The `intent` values the login route acts on, read from its source: every
 * `intent === <value>` comparison and every `case` of a `switch (intent)`,
 * with a constant resolved to the string it holds.
 */
export function recognisedIntents(source: string): string[] {
  const constants = new Map<string, string>()
  for (const m of source.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*(['"`])([^'"`]*)\2/g)) {
    constants.set(m[1]!, m[3]!)
  }
  const value = (token: string): string | undefined => {
    const literal = /^(['"`])(.*)\1$/.exec(token)
    return literal ? literal[2] : constants.get(token)
  }
  const found = new Set<string>()
  const operand = `(['"\`][^'"\`]*['"\`]|[A-Za-z_$][\\w$]*)`
  for (const m of source.matchAll(new RegExp(`\\bintent\\s*===?\\s*${operand}`, 'g'))) {
    const v = value(m[1]!)
    if (v !== undefined) found.add(v)
  }
  for (const m of source.matchAll(new RegExp(`${operand}\\s*===?\\s*intent\\b`, 'g'))) {
    const v = value(m[1]!)
    if (v !== undefined) found.add(v)
  }
  const switchBlock = /switch\s*\(\s*intent\s*\)\s*\{([\s\S]*?)\n\s*\}/.exec(source)
  if (switchBlock) {
    for (const m of switchBlock[1]!.matchAll(new RegExp(`case\\s+${operand}\\s*:`, 'g'))) {
      const v = value(m[1]!)
      if (v !== undefined) found.add(v)
    }
  }
  return [...found].sort()
}
