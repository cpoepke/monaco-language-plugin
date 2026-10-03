/**
 * The only module that imports `@mlp/lsp-bridge` at runtime. Everything else
 * depends on the `BridgeFactory` type, so tests inject fakes and never start
 * real language servers.
 */
import {
  BRIDGE_VERSION,
  createBridge,
  defaultExtraBinDirs,
  resolveAllServers
} from '@mlp/lsp-bridge'
import type { Bridge, BridgeOptions } from '@mlp/lsp-bridge'

export type BridgeHandle = Pick<Bridge, 'listen' | 'close' | 'status' | 'serverPids'>
export type BridgeFactoryOptions = BridgeOptions
export type BridgeFactory = (options: BridgeFactoryOptions) => BridgeHandle

export const createRealBridge: BridgeFactory = (options) => createBridge(options)

/**
 * Server search dirs after PATH: ~/go/bin and ~/.cargo/bin. Explicit because
 * the bridge is bundled into dist/main.mjs: its default would also search the
 * bridge package's node_modules/.bin, which does not exist here, and must
 * never turn into a walk up from wherever Orca installed the plugin.
 */
export function pluginExtraBinDirs(): string[] {
  return defaultExtraBinDirs()
}

/** serverId → resolved executable, or null when not installed. */
export function detectServers(): Record<string, string | null> {
  return resolveAllServers({ extraDirs: pluginExtraBinDirs() })
}

export { BRIDGE_VERSION }
