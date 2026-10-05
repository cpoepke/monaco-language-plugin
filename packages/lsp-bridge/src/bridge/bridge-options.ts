import { isAbsolute } from 'node:path'
import type { BridgeLogger } from '../logger'
import { silentLogger } from '../logger'
import type { ServerOverrides } from '../lsp/server-catalog'
import { realpathLenient } from '../workspace/path-policy'
import { isLoopbackHost } from './auth'

export type HostNavigationTarget = { path: string; line: number; character: number }
export type HostNavigationResult = { opened: boolean; reason?: string }
export type HostNavigator = (target: HostNavigationTarget) => Promise<HostNavigationResult>

/** What an allowed-roots provider is asked about: the realpath of the file a
 *  client wants to open or read. Providers may use it to refresh a cache on a
 *  miss (e.g. a worktree created since the last refresh). */
export type AllowedRootsQuery = { path: string }

/**
 * Dynamic allowed roots, evaluated on every `document/open` and `fs/readFile`.
 * Return absolute directories (they are realpath'd by the bridge). Returning
 * an empty list refuses everything; a throw is treated as an empty list.
 * Return the same array instance while nothing changed: the bridge reuses its
 * realpath'd copy then.
 */
export type AllowedRootsProvider = (
  query: AllowedRootsQuery
) => readonly string[] | Promise<readonly string[]>

export type BridgeOptions = {
  /** TCP port; 0 picks an ephemeral port (see `listen()`'s result). */
  port: number
  /** Interface to bind. Defaults to 127.0.0.1; non-loopback needs allowRemote. */
  host?: string
  /** Lets `host` be a non-loopback interface. The token is then the only guard. */
  allowRemote?: boolean
  /** Shared secret clients pass as `?token=`. Required and non-empty. */
  token: string
  /**
   * Absolute directories; when set, documents and reads outside them are
   * refused. A non-empty array is fixed for the bridge's lifetime; a function
   * is asked on every `document/open` and `fs/readFile` (see
   * AllowedRootsProvider) and always enables containment, even when it
   * returns no roots.
   */
  allowedRoots?: readonly string[] | AllowedRootsProvider
  /** Explicitly trusted workspace roots. Empty/omitted means no language
   * servers may start: servers can execute workspace SDKs and build scripts. */
  trustedRoots?: readonly string[] | AllowedRootsProvider
  /**
   * Directories searched for server binaries after PATH. Defaults to
   * ~/go/bin, ~/.cargo/bin and the bridge package's own node_modules/.bin.
   * Embedders that bundle the bridge pass their own list.
   */
  extraBinDirs?: readonly string[]
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
   * Off by default. This only controls executable lookup; trustedRoots is the
   * separate authorization to run servers and their workspace-supplied code.
   */
  trustProjectBinaries?: boolean
}

export type NormalizedBridgeOptions = {
  port: number
  host: string
  token: string
  /** Null when containment is off (no allowedRoots configured). */
  allowedRoots: AllowedRootsResolver | null
  trustedRoots: AllowedRootsResolver
  allowRemote: boolean
  extraBinDirs: readonly string[] | undefined
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
  return {
    port: options.port,
    host,
    token: options.token,
    allowedRoots: allowedRootsResolver(options.allowedRoots, options.logger ?? silentLogger),
    trustedRoots: allowedRootsResolver(
      typeof options.trustedRoots === 'function'
        ? options.trustedRoots
        : () => (options.trustedRoots as readonly string[] | undefined) ?? [],
      options.logger ?? silentLogger
    )!,
    allowRemote: options.allowRemote === true,
    extraBinDirs: options.extraBinDirs,
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

/** Realpath'd allowed roots for one containment check. */
export type AllowedRootsResolver = (query: AllowedRootsQuery) => Promise<readonly string[]>

function canonicalRoots(roots: readonly string[]): string[] {
  return roots.map((root) => {
    if (!isAbsolute(root)) {
      throw new TypeError(`allowedRoots entries must be absolute: ${root}`)
    }
    // Why: containment checks compare realpaths, so the roots must be realpaths
    // too (macOS /tmp → /private/tmp would otherwise reject everything).
    return realpathLenient(root)
  })
}

function allowedRootsResolver(
  allowedRoots: BridgeOptions['allowedRoots'],
  logger: BridgeLogger
): AllowedRootsResolver | null {
  if (allowedRoots === undefined) {
    return null
  }
  if (typeof allowedRoots !== 'function') {
    if (allowedRoots.length === 0) {
      return null
    }
    const fixed = canonicalRoots(allowedRoots)
    return () => Promise.resolve(fixed)
  }
  const provider = allowedRoots
  let lastInput: readonly string[] | null = null
  let lastOutput: readonly string[] = []
  return async (query) => {
    let roots: readonly string[]
    try {
      roots = await provider(query)
    } catch (error) {
      // Why: fail closed — a provider that cannot answer allows nothing.
      logger.warn('allowedRoots provider failed; refusing', {
        error: error instanceof Error ? error.message : String(error)
      })
      return []
    }
    if (!Array.isArray(roots)) {
      return []
    }
    if (roots !== lastInput) {
      // Why: a relative entry is a provider bug; skip it rather than resolve it
      // against the bridge's cwd.
      lastOutput = canonicalRoots(
        roots.filter((root) => typeof root === 'string' && isAbsolute(root))
      )
      lastInput = roots
    }
    return lastOutput
  }
}
