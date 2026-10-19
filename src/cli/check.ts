import { main } from './main.ts'

// `process.exit` rather than `exitCode`: a check's browser or socket left open
// must not keep a finished run alive.
process.exit(await main(process.argv.slice(2)))
