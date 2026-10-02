import { isAbsolute } from 'node:path'
import type { BridgeLogger } from '../logger'
import { silentLogger } from '../logger'
import type { ServerOverrides } from '../lsp/server-catalog'
import { realpathLenient } from '../workspace/path-policy'
import { isLoopbackHost } from './auth'

export type HostNavigationTarget = { path: string; line: number; character: number }
export type HostNavigationResult = { opened: boolean; reason?: string }
export type HostNavigator = (target: HostNavigationTarget) => Promise<HostNavigationResult>

export type BridgeOptions = {
  /** TCP port; 0 picks an ephemeral port (see `listen()`'s result). */
  port: number
  /** Interface to bind. Defaults to 127.0.0.1; non-loopback needs allowRemote. */
  host?: string
  /** Lets `host` be a non-loopback interface. The token is then the only guard. */
  allowRemote?: boolean
  /** Shared secret clients pass as `?token=`. Required and non-empty. */
  token: string
  /** Absolute directories; when set, documents and reads outside them are refused. */
  allowedRoots?: readonly string[]
  /** Per-serverId replacement command/args (e.g. a pinned server binary). */
  serverOverrides?: ServerOverrides
  /** Backs `host/openLocation`; absent means the client must navigate itself. */
  hostNavigator?: HostNavigator
  logger?: BridgeLogger
  /** Doc-less sessions are stopped after this long. Default 3 minutes. */
  idleShutdownMs?: number
  /** Per-request timeout towards language servers. Default 15 s. */
  requestTimeoutMs?: number
  /** Concurrent language-server processes. Default 8. */
  maxSessions?: number
  /** Largest accepted WebSocket frame. Default 16 MiB. */
  maxMessageBytes?: number
  /**
   * Also look for server binaries in the opened project's `node_modules/.bin`.
   * Off by default: opening a file in an untrusted repository must never run
   * an executable that repository ships.
   */
  trustProjectBinaries?: boolean
}

export type NormalizedBridgeOptions = {
  port: number
  host: string
  token: string
  allowedRoots: string[]
  serverOverrides: ServerOverrides
  hostNavigator: HostNavigator | null
  logger: BridgeLogger
  idleShutdownMs: number
  requestTimeoutMs: number
  maxSessions: number
  maxMessageBytes: number
  trustProjectBinaries: boolean
}

function positiveNumber(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) {
    return fallback
  }
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive number`)
  }
  return value
}

export function normalizeBridgeOptions(options: BridgeOptions): NormalizedBridgeOptions {
  if (typeof options.token !== 'string' || options.token.length === 0) {
    throw new TypeError('token is required and must be a non-empty string')
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535) {
    throw new TypeError(`invalid port: ${options.port}`)
  }
  const host = options.host ?? '127.0.0.1'
  if (!isLoopbackHost(host) && !options.allowRemote) {
    throw new Error(`refusing to listen on non-loopback host ${host} without allowRemote`)
  }
  const allowedRoots = (options.allowedRoots ?? []).map((root) => {
    if (!isAbsolute(root)) {
      throw new TypeError(`allowedRoots entries must be absolute: ${root}`)
    }
    // Why: containment checks compare realpaths, so the roots must be realpaths
    // too (macOS /tmp → /private/tmp would otherwise reject everything).
    return realpathLenient(root)
  })
  return {
    port: options.port,
    host,
    token: options.token,
    allowedRoots,
    serverOverrides: options.serverOverrides ?? {},
    hostNavigator: options.hostNavigator ?? null,
    logger: options.logger ?? silentLogger,
    idleShutdownMs: positiveNumber(options.idleShutdownMs, 3 * 60_000, 'idleShutdownMs'),
    requestTimeoutMs: positiveNumber(options.requestTimeoutMs, 15_000, 'requestTimeoutMs'),
    maxSessions: positiveNumber(options.maxSessions, 8, 'maxSessions'),
    maxMessageBytes: positiveNumber(options.maxMessageBytes, 16 * 1024 * 1024, 'maxMessageBytes'),
    trustProjectBinaries: options.trustProjectBinaries === true
  }
}
