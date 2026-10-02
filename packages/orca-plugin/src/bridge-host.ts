/**
 * The only module that imports `@mlp/lsp-bridge` at runtime. Everything else
 * depends on the `BridgeFactory` type, so tests inject fakes and never start
 * real language servers.
 */
import { BRIDGE_VERSION, createBridge, resolveAllServers } from '@mlp/lsp-bridge'
import type { Bridge, BridgeOptions } from '@mlp/lsp-bridge'

export type BridgeHandle = Pick<Bridge, 'listen' | 'close' | 'status' | 'serverPids'>
export type BridgeFactoryOptions = BridgeOptions
export type BridgeFactory = (options: BridgeFactoryOptions) => BridgeHandle

export const createRealBridge: BridgeFactory = (options) => createBridge(options)

/** serverId → resolved executable, or null when not installed. */
export function detectServers(): Record<string, string | null> {
  return resolveAllServers()
}

export { BRIDGE_VERSION }
