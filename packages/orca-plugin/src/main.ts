/**
 * Orca plugin worker entry (bundled to dist/main.mjs).
 *
 * Orca forks this file's host (plugin-host-entry) with ELECTRON_RUN_AS_NODE,
 * imports us, and calls the default export with the worker API. The renderer
 * injector then calls `window.api.plugins.invokeCommand({pluginKey:
 * 'cpoepke.monaco-lsp', commandId: 'mlp.ensureBridge'})` to get
 * `{port, token}` and connects to ws://127.0.0.1:<port>.
 *
 * Kept to Orca's contract (default `activate`, named `deactivate`); the logic
 * lives in worker-entry.ts and create-controller.ts, which are tested in-process.
 */
import { createController } from './create-controller'
import type { OrcaWorkerApi } from './orca-api'
import { createEntry } from './worker-entry'

const entry = createEntry(process, createController)

export default function activate(orca: OrcaWorkerApi): void {
  entry.activate(orca)
}

export async function deactivate(): Promise<void> {
  await entry.deactivate()
}
