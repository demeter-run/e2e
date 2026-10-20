import { main } from './agent.ts'

// `process.exit` rather than `exitCode`: a browser or socket left open must
// not keep a finished run alive.
process.exit(await main('j0', process.argv.slice(2)))
