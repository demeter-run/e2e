import { main } from './agent.ts'

// `process.exit` rather than `exitCode`: a socket left open must not keep a
// finished run alive. A run that breaks outside its steps exits 3, which a
// workflow tells apart from 1, a failure its results and alerts report.
process.exit(
  await main('contract', process.argv.slice(2)).catch((error: unknown) => {
    console.error(error)
    return 3
  }),
)
