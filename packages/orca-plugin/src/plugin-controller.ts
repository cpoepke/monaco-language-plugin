import { randomBytes } from 'node:crypto'
import { PROTOCOL_VERSION } from '@mlp/protocol'
import type { BridgeStatus } from '@mlp/protocol'
import type { BridgeLogger } from '@mlp/lsp-bridge'
import type { BridgeFactory, BridgeFactoryOptions, BridgeHandle } from './bridge-host'
import type { HostNavigator } from './host-navigator'
import { COMMANDS, PLUGIN_DISPLAY_NAME } from './orca-api'
import type { OrcaWorkerApi } from './orca-api'
import { createPluginLogger } from './plugin-logger'
import type { RepairReport } from './self-repair/decide'
import { AUTO_CHECK_DELAY_MS, type PatchStatus, type SelfRepair } from './self-repair/self-repair'

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
  /** Orca's app.asar patch as seen from this worker (null without self-repair). */
  patch: PatchStatus | null
}

/** What `mlp.repairPatch` returns. */
export type RepairPatchResult = Pick<RepairReport, 'state' | 'action' | 'message'>

export type StopResult = { stopped: boolean }

export type PluginControllerDeps = {
  createBridge: BridgeFactory
  hostNavigator: HostNavigator
  /**
   * The bridge's dynamic containment: Orca's worktree roots. Documents and
   * reads outside them are refused (see README, Security).
   */
  allowedRoots?: BridgeFactoryOptions['allowedRoots']
  trustedRoots?: BridgeFactoryOptions['trustedRoots']
  /** Search dirs for server binaries after PATH (the bundle has no bridge
   *  package, so no node_modules/.bin of its own). */
  extraBinDirs?: readonly string[]
  /** Called on Orca's worktree.created / worktree.removed events. */
  onWorktreesChanged?: () => void
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
  /** Re-applies the renderer patch after Orca updates (see self-repair/). */
  selfRepair?: SelfRepair
  /** Delay of the automatic patch check after activate. */
  autoRepairDelayMs?: number
  /** `mlp.repairPatch` answers after this long even if the repair still runs (Orca's invoke
   *  timeout is 30 s); the outcome then arrives as a notification. */
  repairCommandBudgetMs?: number
}

export const IDLE_STOP_MS = 10 * 60_000
const IDLE_CHECK_INTERVAL_MS = 60_000
const LISTEN_TIMEOUT_MS = 15_000
const SHUTDOWN_BUDGET_MS = 1_500
const REPAIR_COMMAND_BUDGET_MS = 25_000

type Running = { bridge: BridgeHandle; port: number; token: string }

export type PluginController = {
  activate(orca: OrcaWorkerApi): void
  deactivate(): Promise<void>
  ensureBridge(): Promise<EnsureBridgeResult>
  status(options?: { notify?: boolean }): StatusResult
  restart(): Promise<EnsureBridgeResult>
  stop(): Promise<StopResult>
  repairPatch(): Promise<RepairPatchResult>
  /** Synchronous last resort for `process.on('exit')`: SIGTERM servers. */
  killServersSync(): void
}

export function createPluginController(deps: PluginControllerDeps): PluginController {
  const now = deps.now ?? Date.now
  const idleStopMs = deps.idleStopMs ?? IDLE_STOP_MS
  const idleCheckIntervalMs = deps.idleCheckIntervalMs ?? IDLE_CHECK_INTERVAL_MS
  const randomToken = deps.randomToken ?? (() => randomBytes(32).toString('hex'))
  const killProcess = deps.killProcess ?? killProcessGroup

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
      ...(deps.allowedRoots ? { allowedRoots: deps.allowedRoots } : {}),
      ...(deps.trustedRoots ? { trustedRoots: deps.trustedRoots } : {}),
      ...(deps.extraBinDirs ? { extraBinDirs: deps.extraBinDirs } : {}),
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
      idleStopInMs: running ? Math.max(0, idleStopMs - (now() - lastActivityAt)) : null,
      patch: safePatchStatus()
    }
    if (options.notify) {
      notify(summarize(result))
    }
    return result
  }

  function safePatchStatus(): PatchStatus | null {
    try {
      return deps.selfRepair?.status() ?? null
    } catch {
      return null
    }
  }

  async function repairPatch(): Promise<RepairPatchResult> {
    const selfRepair = deps.selfRepair
    if (!selfRepair) {
      return { state: 'not-found', action: 'none', message: 'Self-repair is not available.' }
    }
    const running = selfRepair.check({ forced: true, trigger: 'command' })
    const budget = deps.repairCommandBudgetMs ?? REPAIR_COMMAND_BUDGET_MS
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<RepairPatchResult>((resolve) => {
      timer = setTimeout(
        () =>
          resolve({
            state: 'busy',
            action: 'none',
            message: 'The repair is still running; a notification will show the outcome.'
          }),
        budget
      )
    })
    try {
      const report = await Promise.race([running, late])
      return { state: report.state, action: report.action, message: report.message }
    } finally {
      clearTimeout(timer)
    }
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
    api.commands.register(COMMANDS.repairPatch, () => repairPatch())
    const selfRepair = deps.selfRepair
    if (selfRepair) {
      selfRepair.attach({ notify, log })
      // Why: activate has a 10 s budget; the check (which may repack app.asar) runs afterwards.
      const timer = setTimeout(
        () => selfRepair.autoCheck('activate'),
        deps.autoRepairDelayMs ?? AUTO_CHECK_DELAY_MS
      )
      timer.unref?.()
      if (api.grantedCapabilities.includes('events:subscribe')) {
        // Why: after an update the injector is gone, so nothing calls our commands; Orca starts
        // the worker for manifest-declared events, and agent status changes come soon after
        // launch. The check itself runs at most once per worker lifetime.
        api.events.on('agent.status.changed', () => selfRepair.autoCheck('agent.status.changed'))
      }
    }
    if (deps.onWorktreesChanged && api.grantedCapabilities.includes('events:subscribe')) {
      const changed = (): void => {
        try {
          deps.onWorktreesChanged?.()
        } catch (error) {
          log.warn('worktree change handler failed', { error: String(error) })
        }
      }
      // Why: a removed worktree must stop being readable right away, not
      // after the 10 s cache; a created one is picked up on a miss anyway.
      api.events.on('worktree.created', changed)
      api.events.on('worktree.removed', changed)
    }
  }

  return {
    activate,
    deactivate,
    ensureBridge,
    status,
    restart,
    stop,
    repairPatch,
    killServersSync
  }
}

function patchLine(patch: PatchStatus | null): string | null {
  if (!patch || patch.state === 'not-found' || patch.state === 'not-orca') return null
  const label: Record<PatchStatus['state'], string> = {
    patched: 'enabled',
    outdated: 'enabled (older injector; run Language Servers: Repair Orca Patch)',
    unpatched: 'not patched (run Language Servers: Repair Orca Patch)',
    pending: 'applied when you quit Orca',
    'not-found': '',
    'not-orca': '',
    unknown: 'unknown'
  }
  return `Editor patch: ${label[patch.state]}${patch.orcaVersion ? ` (Orca ${patch.orcaVersion})` : ''}`
}

export function summarize(status: StatusResult): string {
  if (!status.running || !status.bridge) {
    return ['Stopped. It starts automatically when an editor needs it.', patchLine(status.patch)]
      .filter((line): line is string => line !== null)
      .join('\n')
  }
  const servers = Object.entries(status.bridge.servers)
  const found = servers.filter(([, exe]) => exe).map(([id]) => id)
  const missing = servers.filter(([, exe]) => !exe).map(([id]) => id)
  return [
    `Running on 127.0.0.1:${status.port}`,
    `${status.bridge.clients} client(s), ${status.bridge.sessions.length} server session(s)`,
    `Installed: ${found.length > 0 ? found.join(', ') : 'none'}`,
    missing.length > 0 ? `Not found: ${missing.join(', ')}` : null,
    status.hostNavigation ? null : 'Orca runtime not found: cross-file jumps stay in a peek view',
    patchLine(status.patch)
  ]
    .filter((line): line is string => line !== null)
    .join('\n')
}

/**
 * SIGTERM a language server and everything it started. The bridge spawns
 * servers detached on POSIX, so each leads its own process group and `-pid`
 * reaches helpers such as tsserver or gopls workers; signalling only the
 * leader would orphan them. Falls back to the pid alone (Windows, or a group
 * that is already gone).
 */
export function killProcessGroup(pid: number, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, signal)
      return
    } catch {
      // Not a group leader (or already gone): try the pid itself.
    }
  }
  process.kill(pid, signal)
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
