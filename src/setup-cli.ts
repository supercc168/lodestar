/**
 * CLI entry for `lodestar-setup` bin. Separate from daemon.ts so
 * importing it does NOT trigger config.ts's synchronous loadConfig() —
 * fresh installs have no config.toml yet, so loading config eagerly
 * would crash the wizard before it could write one.
 */

import { runSetup } from './setup'

runSetup().catch((e: any) => {
  console.error(`\nlodestar-setup: ${e?.message ?? e}`)
  process.exit(1)
})
