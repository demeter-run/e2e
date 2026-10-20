import { ports } from '../ports/index.ts'
import { main } from './main.ts'

// `process.exit` rather than `exitCode`: a gRPC channel or socket left open
// must not keep a finished run alive.
process.exit(await main(process.argv.slice(2), { checks: [ports], suite: { command: 'ports', title: 'Port suite' } }))
