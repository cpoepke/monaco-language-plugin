import { createRequire } from 'node:module'
import nodeFs from 'node:fs'

/**
 * The filesystem module every patch operation must use.
 *
 * Why: the Orca plugin worker (and the pending-swap helper) run inside Orca's Electron binary with
 * ELECTRON_RUN_AS_NODE. Electron's `fs` there still has asar support, so `app.asar` looks like a
 * directory: stat says "directory", copyFile/rename/createReadStream misbehave. Electron ships the
 * unpatched module as the built-in `original-fs` (the same switch @electron/asar makes). Plain Node
 * (the CLI, tests) has no `original-fs` and uses `node:fs`.
 */
const requireBuiltin = createRequire(import.meta.url)

export const fs: typeof nodeFs =
  'electron' in process.versions ? (requireBuiltin('original-fs') as typeof nodeFs) : nodeFs

export type { Dirent, Stats } from 'node:fs'
