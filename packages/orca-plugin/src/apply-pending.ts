/**
 * Detached helper (bundled to dist/apply-pending.mjs), started by the self-repair when a running
 * Orca keeps app.asar locked (Windows). Runs with Orca's own binary and ELECTRON_RUN_AS_NODE:
 *
 *   <Orca binary> apply-pending.mjs --asar <app.asar> --wait-pid <Orca main pid> --log <file>
 *     [--timeout-ms <ms>] [--poll-ms <ms>]
 *
 * Waits for Orca's main process to exit, then swaps `app.asar.mlp-pending` in with one rename,
 * verifies it and exits. Logs to ~/.monaco-lsp-orca/logs/apply-pending.log.
 *
 * Thin wrapper: the logic is in apply-pending-run.ts, tested in-process.
 */
import { runApplyPending } from './apply-pending-run'

runApplyPending(process.argv.slice(2)).then(
  (code) => process.exit(code),
  () => process.exit(1)
)
