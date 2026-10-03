/**
 * Orca plugin worker entry (bundled to dist/main.mjs).
 *
 * Orca forks this file's host (plugin-host-entry) with ELECTRON_RUN_AS_NODE,
 * imports us, and calls the default export with the worker API. The renderer
 * injector then calls `window.api.plugins.invokeCommand({pluginKey:
 * 'cpoepke.monaco-lsp', commandId: 'mlp.ensureBridge'})` to get
 * `{port, token}` and connects to ws://127.0.0.1:<port>.
 */
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRealBridge, detectServers, pluginExtraBinDirs } from './bridge-host'
import { createHostNavigator } from './host-navigator'
import type { OrcaWorkerApi } from './orca-api'
import { createOrcaRuntimeClient } from './orca-runtime-client'
import { userDataCandidates } from './orca-user-data'
import { createPluginController } from './plugin-controller'
import type { PluginController } from './plugin-controller'
import { applyExtendedPath } from './server-path'
import { PLUGIN_VERSION } from './version'
import { createWorktreeRoots } from './worktree-roots'

/** dist/main.mjs → plugin root (the folder holding orca-plugin.json). */
function pluginRootFromEntry(): string | null {
  try {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  } catch {
    return null
  }
}

function createController(): PluginController {
  const pluginRoot = pluginRootFromEntry()
  const runtime = createOrcaRuntimeClient({
    userDataCandidates: () =>
      userDataCandidates({
        pluginRoot,
        env: process.env,
        platform: process.platform,
        homedir: homedir()
      })
  })
  const worktrees = createWorktreeRoots({ runtime })
  return createPluginController({
    createBridge: createRealBridge,
    hostNavigator: createHostNavigator({ runtime, worktrees }),
    // Why: without this the bridge would open and read any local file a
    // client names; Orca's worktrees are exactly what its editor shows.
    allowedRoots: ({ path: file }) => worktrees.forPath(file),
    extraBinDirs: pluginExtraBinDirs(),
    onWorktreesChanged: () => worktrees.invalidate(),
    hostNavigationAvailable: () => runtime.metadataPath() !== null,
    pluginVersion: PLUGIN_VERSION,
    detectServers,
    prepareEnvironment: (log) => {
      const added = applyExtendedPath()
      if (added.length > 0) {
        log.info('extended PATH for language servers', { added })
      }
    }
  })
}

let controller: PluginController | null = null
let processHooksInstalled = false

/**
 * Why these hooks: Orca's normal stop path is the `shutdown` message, which
 * awaits our `deactivate` export (2 s before SIGKILL). If Orca instead drops
 * the IPC channel, its plugin-host-entry calls `process.exit(0)` from its own
 * `disconnect` listener before ours could run anything async, so the reliable
 * place to stop language servers is the synchronous `exit` event.
 */
function installProcessHooks(target: PluginController): void {
  if (processHooksInstalled) {
    return
  }
  processHooksInstalled = true
  process.on('exit', () => target.killServersSync())
  process.once('disconnect', () => target.killServersSync())
  process.once('SIGTERM', () => {
    void target.deactivate().finally(() => process.exit(0))
  })
  process.once('beforeExit', () => {
    void target.deactivate()
  })
}

export default function activate(orca: OrcaWorkerApi): void {
  controller ??= createController()
  installProcessHooks(controller)
  controller.activate(orca)
}

export async function deactivate(): Promise<void> {
  await controller?.deactivate()
}
