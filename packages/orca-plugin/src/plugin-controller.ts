import { randomBytes } from 'node:crypto'
import { PROTOCOL_VERSION } from '@mlp/protocol'
import type { BridgeStatus } from '@mlp/protocol'
import type { BridgeLogger } from '@mlp/lsp-bridge'
import type { BridgeFactory, BridgeHandle } from './bridge-host'
import type { HostNavigator } from './host-navigator'
import { COMMANDS, PLUGIN_DISPLAY_NAME } from './orca-api'
import type { OrcaWorkerApi } from './orca-api'
import { createPluginLogger } from './plugin-logger'

/** What `mlp.ensureBridge` (and `mlp.restart`) return to the renderer. */
export type EnsureBridgeResult = {
  port: number
  token: string
  protocolVersion: number
  pluginVersion: string
  /** True when Orca's runtime metadata was found, i.e. `host/openLocation`
   *  can open files in Orca's editor. */
  hostNavigation: boolean
}

export type StatusResult = {
  running: boolean
  port: number | null
  protocolVersion: number
  pluginVersion: string
  hostNavigation: boolean
  /** Null while the bridge is stopped. */
  bridge: BridgeStatus | null
  /** Milliseconds until the idle stop fires, or null when not running. */
  idleStopInMs: number | null
}

export type StopResult = { stopped: boolean }

export type PluginControllerDeps = {
  createBridge: BridgeFactory
  hostNavigator: HostNavigator
  /** Cheap, synchronous: is Orca's runtime metadata reachable? */
  hostNavigationAvailable: () => boolean
  pluginVersion: string
  /** Runs once, right before the first bridge starts (PATH extension). */
  prepareEnvironment?: (log: BridgeLogger) => void
  /** Logs installed servers on bridge start; optional (fs probing). */
  detectServers?: () => Record<string, string | null>
  randomToken?: () => string
  now?: () => number
  killProcess?: (pid: number) => void
  /** Stop the bridge after this long with no clients and no heartbeat. */
  idleStopMs?: number
  idleCheckIntervalMs?: number
  listenTimeoutMs?: number
  /** Budget for closing on shutdown; Orca SIGKILLs 2 s after `shutdown`. */
  shutdownBudgetMs?: number
}

export const IDLE_STOP_MS = 10 * 60_000
const IDLE_CHECK_INTERVAL_MS = 60_000
const LISTEN_TIMEOUT_MS = 15_000
const SHUTDOWN_BUDGET_MS = 1_500

type Running = { bridge: BridgeHandle; port: number; token: string }

export type PluginController = {
  activate(orca: OrcaWorkerApi): void
  deactivate(): Promise<void>
  ensureBridge(): Promise<EnsureBridgeResult>
  status(options?: { notify?: boolean }): StatusResult
  restart(): Promise<EnsureBridgeResult>
  stop(): Promise<StopResult>
  /** Synchronous last resort for `process.on('exit')`: SIGTERM servers. */
  killServersSync(): void
}

export function createPluginController(deps: PluginControllerDeps): PluginController {
  const now = deps.now ?? Date.now
  const idleStopMs = deps.idleStopMs ?? IDLE_STOP_MS
  const idleCheckIntervalMs = deps.idleCheckIntervalMs ?? IDLE_CHECK_INTERVAL_MS
  const randomToken = deps.randomToken ?? (() => randomBytes(32).toString('hex'))
  const killProcess = deps.killProcess ?? ((pid: number) => process.kill(pid, 'SIGTERM'))

  let orca: OrcaWorkerApi | null = null
  let running: Running | null = null
  let starting: Promise<Running> | null = null
  let stopping: Promise<void> | null = null
  /** The bridge being closed, so a shutdown can still kill its servers. */
  let closingBridge: BridgeHandle | null = null
  let environmentPrepared = false
  let lastActivityAt = now()
  let idleTimer: ReturnType<typeof setInterval> | null = null

  const log = createPluginLogger(
    (line) => (orca ? orca.log(line) : console.error(line)),
    () => (running ? [running.token] : [])
  )

  function connectionInfo(state: Running): EnsureBridgeResult {
    return {
      port: state.port,
      token: state.token,
      protocolVersion: PROTOCOL_VERSION,
      pluginVersion: deps.pluginVersion,
      hostNavigation: safeHostNavigationAvailable()
    }
  }

  function safeHostNavigationAvailable(): boolean {
    try {
      return deps.hostNavigationAvailable()
    } catch {
      return false
    }
  }

  async function start(): Promise<Running> {
    if (!environmentPrepared) {
      environmentPrepared = true
      deps.prepareEnvironment?.(log)
    }
    const token = randomToken()
    const bridge = deps.createBridge({
      port: 0,
      host: '127.0.0.1',
      token,
      hostNavigator: deps.hostNavigator,
      logger: log,
      // Why: opening a file in an untrusted repo must never run its binaries.
      trustProjectBinaries: false
    })
    let port: number
    try {
      ;({ port } = await withTimeout(bridge.listen(), deps.listenTimeoutMs ?? LISTEN_TIMEOUT_MS))
    } catch (error) {
      await bridge.close().catch(() => {})
      throw error
    }
    const state: Running = { bridge, port, token }
    running = state
    lastActivityAt = now()
    startIdleTimer()
    log.info('bridge listening', { port })
    logServers()
    return state
  }

  function logServers(): void {
    if (!deps.detectServers) {
      return
    }
    try {
      const servers = deps.detectServers()
      const found = Object.entries(servers).filter(([, exe]) => exe)
      const missing = Object.entries(servers).filter(([, exe]) => !exe)
      log.info('language servers', {
        found: Object.fromEntries(found),
        missing: missing.map(([id]) => id)
      })
    } catch (error) {
      log.warn('server detection failed', { error: String(error) })
    }
  }

  async function ensureBridge(): Promise<EnsureBridgeResult> {
    // Why: every call doubles as the renderer's heartbeat (see README).
    lastActivityAt = now()
    if (stopping) {
      await stopping
    }
    if (running) {
      return connectionInfo(running)
    }
    if (!starting) {
      starting = start().finally(() => {
        starting = null
      })
    }
    return connectionInfo(await starting)
  }

  async function stop(): Promise<StopResult> {
    if (starting) {
      await starting.catch(() => {})
    }
    if (stopping) {
      await stopping
      return { stopped: false }
    }
    const state = running
    if (!state) {
      return { stopped: false }
    }
    running = null
    closingBridge = state.bridge
    stopIdleTimer()
    stopping = state.bridge
      .close()
      .catch((error: unknown) => log.error('bridge close failed', { error: String(error) }))
      .finally(() => {
        stopping = null
        closingBridge = null
      })
    await stopping
    log.info('bridge stopped')
    return { stopped: true }
  }

  async function restart(): Promise<EnsureBridgeResult> {
    await stop()
    return ensureBridge()
  }

  function status(options: { notify?: boolean } = {}): StatusResult {
    const bridgeStatus = running ? running.bridge.status() : null
    const result: StatusResult = {
      running: running !== null,
      port: running?.port ?? null,
      protocolVersion: PROTOCOL_VERSION,
      pluginVersion: deps.pluginVersion,
      hostNavigation: safeHostNavigationAvailable(),
      bridge: bridgeStatus,
      idleStopInMs: running ? Math.max(0, idleStopMs - (now() - lastActivityAt)) : null
    }
    if (options.notify) {
      notify(summarize(result))
    }
    return result
  }

  function notify(body: string): void {
    if (!orca?.grantedCapabilities.includes('notifications:show')) {
      return
    }
    // Why: fire-and-forget; the command result must not wait on the desktop
    // notification round trip (nor fail when the host refuses it).
    orca.host
      .call('notifications.show', { title: PLUGIN_DISPLAY_NAME, body: body.slice(0, 1000) })
      .catch((error: unknown) => log.warn('notification failed', { error: String(error) }))
  }

  function startIdleTimer(): void {
    stopIdleTimer()
    idleTimer = setInterval(checkIdle, idleCheckIntervalMs)
    // Why: the timer alone must never keep a dying worker alive.
    idleTimer.unref?.()
  }

  function stopIdleTimer(): void {
    if (idleTimer) {
      clearInterval(idleTimer)
      idleTimer = null
    }
  }

  function checkIdle(): void {
    if (!running || stopping) {
      return
    }
    let clients = 0
    try {
      clients = running.bridge.status().clients
    } catch {
      clients = 0
    }
    if (clients > 0) {
      lastActivityAt = now()
      return
    }
    if (now() - lastActivityAt >= idleStopMs) {
      log.info('stopping idle bridge (no clients and no heartbeat)', {
        idleMinutes: Math.round(idleStopMs / 60_000)
      })
      void stop()
    }
  }

  function killServersSync(): void {
    const bridge = running?.bridge ?? closingBridge
    if (!bridge) {
      return
    }
    let pids: number[] = []
    try {
      pids = bridge.serverPids()
    } catch {
      return
    }
    for (const pid of pids) {
      try {
        killProcess(pid)
      } catch {
        // Already gone.
      }
    }
  }

  async function deactivate(): Promise<void> {
    try {
      await withTimeout(stop(), deps.shutdownBudgetMs ?? SHUTDOWN_BUDGET_MS)
    } catch {
      // Out of budget: make sure no language server outlives us.
      killServersSync()
    }
  }

  function activate(api: OrcaWorkerApi): void {
    orca = api
    // Why: activate must stay instant (Orca waits ≤10 s for `ready`); all
    // real work happens on the first `mlp.ensureBridge`.
    api.commands.register(COMMANDS.ensureBridge, () => ensureBridge())
    api.commands.register(COMMANDS.status, (args) =>
      status({ notify: !(isRecord(args) && args.silent === true) })
    )
    api.commands.register(COMMANDS.restart, () => restart())
    api.commands.register(COMMANDS.stop, () => stop())
  }

  return { activate, deactivate, ensureBridge, status, restart, stop, killServersSync }
}

export function summarize(status: StatusResult): string {
  if (!status.running || !status.bridge) {
    return 'Stopped. It starts automatically when an editor needs it.'
  }
  const servers = Object.entries(status.bridge.servers)
  const found = servers.filter(([, exe]) => exe).map(([id]) => id)
  const missing = servers.filter(([, exe]) => !exe).map(([id]) => id)
  return [
    `Running on 127.0.0.1:${status.port}`,
    `${status.bridge.clients} client(s), ${status.bridge.sessions.length} server session(s)`,
    `Installed: ${found.length > 0 ? found.join(', ') : 'none'}`,
    missing.length > 0 ? `Not found: ${missing.join(', ')}` : null,
    status.hostNavigation ? null : 'Orca runtime not found: cross-file jumps stay in a peek view'
  ]
    .filter((line): line is string => line !== null)
    .join('\n')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}
