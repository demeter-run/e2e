import { apex } from './apex.ts'
import type { Check } from './check.ts'
import { intent } from './intent.ts'
import { pricing } from './pricing.ts'

/** Every contract check, in the order `pnpm check all` runs them. */
export const checks: Check[] = [pricing, intent, apex]
