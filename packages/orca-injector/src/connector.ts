import { PROTOCOL_VERSION } from '@mlp/protocol'

export const PLUGIN_KEY = 'cpoepke.monaco-lsp'
export const ENSURE_BRIDGE_COMMAND = 'mlp.ensureBridge'
/** Backoff for retrying ensureBridge after a failure: 5 s doubling up to 2 min. */
export const RETRY_INITIAL_MS = 5_000
export const RETRY_MAX_MS = 120_000
/** Re-invoke ensureBridge this often while in use (Orca reaps idle plugin workers after 5 min). */
export const HEARTBEAT_MS = 120_000
/** Reuse a successful ensureBridge result for this long when the client asks for its URL. */
export const FRESH_MS = 5_000

export type BridgeInfo = {
  port: number
  token: string
  protocolVersion: number
  pluginVersion: string | null
  hostNavigation: boolean
}

export type InvokeCommand = (args: {
  pluginKey: string
  commandId: string
  args?: unknown
}) => Promise<unknown>

/** What went wrong, mapped to a fix the user can apply. */
export type BridgeErrorKind =
  | 'api-missing'
  | 'plugin-not-enabled'
  | 'plugin-outdated'
  | 'protocol-mismatch'
  | 'bad-response'
  | 'error'

export class BridgeError extends Error {
  constructor(
    readonly kind: BridgeErrorKind,
    message: string
  ) {
    super(message)
    this.name = 'BridgeError'
  }
}

export type ConnectorState = 'idle' | 'pending' | 'available' | 'unavailable'

export type ConnectorDeps = {
  /** Resolves `window.api.plugins.invokeCommand` (null when Orca exposes no plugin API). */
  getInvoke(): InvokeCommand | null
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  /** True while the window is visible. */
  isVisible(): boolean
  /**
   * True while the LSP client is connected to the bridge. Heartbeats continue while connected even
   * when the window is hidden (a reaped worker takes every language server with it); they pause
   * only when hidden and disconnected.
   */
  isClientConnected?(): boolean
  log?(message: string): void
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function classifyBridgeError(error: unknown): BridgeError {
  if (error instanceof BridgeError) return error
  const message = errorText(error)
  if (/is not enabled|No handler registered|plugin system/i.test(message)) {
    return new BridgeError('plugin-not-enabled', message)
  }
  if (/registered no handler|not a (worker )?command|unknown command|not declared/i.test(message)) {
    return new BridgeError('plugin-outdated', message)
  }
  return new BridgeError('error', message)
}

export function parseBridgeInfo(value: unknown): BridgeInfo {
  const v = (value ?? {}) as Partial<Record<keyof BridgeInfo, unknown>>
  const port = v.port
  const token = v.token
  if (
    typeof port !== 'number' ||
    !Number.isInteger(port) ||
    port <= 0 ||
    port > 65_535 ||
    typeof token !== 'string' ||
    token.length === 0
  ) {
    throw new BridgeError('bad-response', 'mlp.ensureBridge returned no port/token')
  }
  const protocolVersion = typeof v.protocolVersion === 'number' ? v.protocolVersion : NaN
  if (protocolVersion !== PROTOCOL_VERSION) {
    throw new BridgeError(
      'protocol-mismatch',
      `plugin speaks protocol ${String(v.protocolVersion)}, injector speaks ${PROTOCOL_VERSION}`
    )
  }
  return {
    port,
    token,
    protocolVersion,
    pluginVersion: typeof v.pluginVersion === 'string' ? v.pluginVersion : null,
    hostNavigation: v.hostNavigation === true
  }
}

export const sameEndpoint = (a: BridgeInfo | null, b: BridgeInfo | null): boolean =>
  a != null && b != null && a.port === b.port && a.token === b.token

/** User-facing fix for a failure (shown once per session). */
export function noticeFor(error: BridgeError): { title: string; body: string } {
  switch (error.kind) {
    case 'api-missing':
    case 'plugin-not-enabled':
      return {
        title: 'Code navigation is not active',
        body:
          'Enable Orca → Settings → Plugins → "Plugin system", install the plugin folder printed by ' +
          '`monaco-lsp-orca install` (~/.monaco-lsp-orca/plugin/cpoepke.monaco-lsp) and click ' +
          '"Review & enable".'
      }
    case 'plugin-outdated':
    case 'protocol-mismatch':
      return {
        title: 'Code navigation: version mismatch',
        body:
          'The Monaco LSP plugin and the Orca patch do not match. Re-run `monaco-lsp-orca install` ' +
          `and reinstall the plugin folder. (${error.message})`
      }
    default:
      return {
        title: 'Code navigation: bridge unavailable',
        body: `The Monaco LSP plugin did not start its bridge: ${error.message}. Retrying in the background.`
      }
  }
}

/**
 * Wakes the plugin worker through Orca's plugin API (`mlp.ensureBridge`) and tracks the bridge
 * endpoint. Retries with backoff while unavailable, and heartbeats while the window is visible or
 * the client is connected so Orca does not reap the idle worker.
 */
export class BridgeConnector {
  state: ConnectorState = 'idle'
  info: BridgeInfo | null = null
  lastError: BridgeError | null = null
  private infoAt = 0
  private inflight: Promise<BridgeInfo> | null = null
  private retryTimer: unknown = null
  private heartbeatTimer: unknown = null
  private retryDelay = RETRY_INITIAL_MS
  private lastHeartbeat = 0
  private heartbeating = false
  private disposed = false
  private waiters: ((info: BridgeInfo) => void)[] = []
  private readonly listeners = new Set<(c: BridgeConnector, previous: BridgeInfo | null) => void>()

  constructor(private readonly deps: ConnectorDeps) {}

  /** Called after every state/info change with the previous info. */
  onChange(listener: (c: BridgeConnector, previous: BridgeInfo | null) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** First attempt; failures schedule retries. */
  start(): void {
    if (this.state === 'idle') void this.refresh().catch(() => {})
  }

  /**
   * Invoke ensureBridge (single flight). Reuses a result younger than `maxAgeMs`.
   * Rejects with BridgeError; failure schedules a retry.
   */
  refresh(maxAgeMs = 0): Promise<BridgeInfo> {
    if (this.disposed) return Promise.reject(new BridgeError('error', 'disposed'))
    if (this.info && this.state === 'available' && this.deps.now() - this.infoAt <= maxAgeMs) {
      return Promise.resolve(this.info)
    }
    if (this.inflight) return this.inflight
    if (this.state !== 'available') this.setState('pending', this.info)
    const run = async (): Promise<BridgeInfo> => {
      const invoke = this.deps.getInvoke()
      if (!invoke) {
        throw new BridgeError('api-missing', "Orca's plugin API (window.api.plugins) is missing")
      }
      let raw: unknown
      try {
        raw = await invoke({
          pluginKey: PLUGIN_KEY,
          commandId: ENSURE_BRIDGE_COMMAND,
          args: { v: 1 }
        })
      } catch (error) {
        throw classifyBridgeError(error)
      }
      return parseBridgeInfo(raw)
    }
    const promise = run().then(
      (info) => {
        this.inflight = null
        this.succeed(info)
        return info
      },
      (error: unknown) => {
        this.inflight = null
        const err = classifyBridgeError(error)
        this.fail(err)
        throw err
      }
    )
    this.inflight = promise
    return promise
  }

  /**
   * Resolve with a working endpoint, waiting through retries if necessary. Used as the client's
   * URL resolver, so every client (re)connect re-wakes the plugin worker.
   */
  waitForInfo(maxAgeMs = FRESH_MS): Promise<BridgeInfo> {
    return this.refresh(maxAgeMs).catch(
      () =>
        new Promise<BridgeInfo>((resolve) => {
          if (this.state === 'available' && this.info) resolve(this.info)
          else this.waiters.push(resolve)
        })
    )
  }

  /** Begin periodic heartbeats (call once Monaco is in use). */
  startHeartbeat(): void {
    if (this.heartbeating || this.disposed) return
    this.heartbeating = true
    this.lastHeartbeat = this.deps.now()
    this.scheduleHeartbeat(HEARTBEAT_MS)
  }

  /** Visibility changed: catch up on a missed heartbeat when the window becomes visible. */
  handleVisibilityChange(): void {
    if (!this.heartbeating || this.disposed || !this.deps.isVisible()) return
    if (this.deps.now() - this.lastHeartbeat >= HEARTBEAT_MS) {
      this.deps.clearTimeout(this.heartbeatTimer)
      this.heartbeat()
    }
  }

  dispose(): void {
    this.disposed = true
    this.deps.clearTimeout(this.retryTimer)
    this.deps.clearTimeout(this.heartbeatTimer)
    this.listeners.clear()
    this.waiters = []
  }

  private heartbeat(): void {
    if (this.disposed) return
    if (!this.deps.isVisible() && !this.isClientConnected()) {
      // Paused while hidden and disconnected: skip this beat but keep checking, so a client that
      // reconnects while hidden is kept alive too; handleVisibilityChange catches up on show.
      this.scheduleHeartbeat(HEARTBEAT_MS)
      return
    }
    this.lastHeartbeat = this.deps.now()
    void this.refresh(0).catch(() => {})
    this.scheduleHeartbeat(HEARTBEAT_MS)
  }

  private isClientConnected(): boolean {
    try {
      return this.deps.isClientConnected?.() === true
    } catch {
      return false
    }
  }

  private scheduleHeartbeat(ms: number): void {
    this.deps.clearTimeout(this.heartbeatTimer)
    this.heartbeatTimer = this.deps.setTimeout(() => this.heartbeat(), ms)
  }

  private succeed(info: BridgeInfo): void {
    const previous = this.info
    this.info = info
    this.infoAt = this.deps.now()
    this.lastError = null
    this.retryDelay = RETRY_INITIAL_MS
    this.deps.clearTimeout(this.retryTimer)
    this.retryTimer = null
    for (const resolve of this.waiters.splice(0)) resolve(info)
    this.setState('available', previous)
  }

  private fail(error: BridgeError): void {
    this.lastError = error
    this.deps.log?.(`ensureBridge failed (${error.kind}): ${error.message}`)
    if (this.retryTimer == null && !this.disposed) {
      const delay = this.retryDelay
      this.retryDelay = Math.min(RETRY_MAX_MS, this.retryDelay * 2)
      this.retryTimer = this.deps.setTimeout(() => {
        this.retryTimer = null
        void this.refresh(0).catch(() => {})
      }, delay)
    }
    this.setState('unavailable', this.info)
  }

  private setState(state: ConnectorState, previous: BridgeInfo | null): void {
    this.state = state
    for (const listener of [...this.listeners]) {
      try {
        listener(this, previous)
      } catch {
        // listeners must not break the connector
      }
    }
  }
}
