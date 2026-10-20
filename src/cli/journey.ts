import { main } from './journeys.ts'

// `process.exit` rather than `exitCode`, as in `check.ts`: nothing left open
// may keep a finished run alive.
process.exit(await main(process.argv.slice(2)))
