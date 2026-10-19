import type { Environment } from '../env.ts'
import type { Run } from '../report.ts'
import type { Sources } from '../sources.ts'

export interface CheckContext {
  /** The live target, or null for a static run. */
  env: Environment | null
  sources: Sources
  run: Run
}

export interface Check {
  name: string
  summary: string
  /**
   * `static`: reads repositories only. `mixed`: static, plus live steps when
   * an environment is given. `live`: needs an environment.
   */
  mode: 'static' | 'mixed' | 'live'
  run(ctx: CheckContext): Promise<void>
}
