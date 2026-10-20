import { main } from './agent.ts'

// `process.exit` rather than `exitCode`: a socket left open must not keep a
// finished run alive.
process.exit(await main('contract', process.argv.slice(2)))
