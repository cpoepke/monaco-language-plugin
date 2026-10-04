import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRealBridge, detectServers, pluginExtraBinDirs } from './bridge-host'
import { createHostNavigator } from './host-navigator'
import { createOrcaRuntimeClient } from './orca-runtime-client'
import { userDataCandidates } from './orca-user-data'
import { createPluginController } from './plugin-controller'
import type { PluginController } from './plugin-controller'
import { createSelfRepair } from './self-repair/self-repair'
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

/** The plugin controller wired to the real bridge, Orca runtime, worktrees and self-repair. */
export function createController(): PluginController {
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
    selfRepair: createSelfRepair({
      execPath: process.execPath,
      platform: process.platform,
      env: process.env,
      homedir: homedir(),
      pluginRoot,
      parentPid: process.ppid,
      pluginVersion: PLUGIN_VERSION
    }),
    prepareEnvironment: (log) => {
      const added = applyExtendedPath()
      if (added.length > 0) {
        log.info('extended PATH for language servers', { added })
      }
    }
  })
}
