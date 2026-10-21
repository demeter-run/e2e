import { firstLine } from '../journeys/browser.ts'
import { main } from './journeys.ts'

// `process.exit` rather than `exitCode`, as in `check.ts`: nothing left open
// may keep a finished run alive. A break outside `main`'s verdict (Playwright
// that cannot start, a result directory that cannot be written) exits 3, not
// Node's 1, which a workflow would read as a failure the journey reported.
process.exit(
  await main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(`the journey broke before it reported: ${firstLine(error)}`)
    return 3
  }),
)
