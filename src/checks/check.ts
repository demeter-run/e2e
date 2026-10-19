import type { Environment } from '../env.ts'
import type { Run } from '../report.ts'

export interface CheckContext {
  /** The deployed surfaces under test. */
  env: Environment
  run: Run
}

/** A contract check: browserless (save intent's last two steps), live only, reading no product source. */
export interface Check {
  name: string
  summary: string
  run(ctx: CheckContext): Promise<void>
}
