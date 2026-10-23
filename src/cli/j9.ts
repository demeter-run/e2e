import { main } from './mock-journey.ts'

// As `pnpm j0`: `process.exit` so nothing left open keeps a finished run
// alive, and 3 for a run that breaks outside its steps.
process.exit(
  await main('j9', process.argv.slice(2)).catch((error: unknown) => {
    console.error(error)
    return 3
  }),
)
