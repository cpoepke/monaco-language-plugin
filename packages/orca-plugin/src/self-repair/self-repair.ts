/**
 * Self-repair: Orca updates replace app.asar and drop the injected `<script>`; the plugin folder
 * (in Orca's userData) survives. The worker therefore checks its own Orca install shortly after
 * activation (and on `mlp.repairPatch`) and re-applies the patch with the shared patch core. The
 * decisions are pure (decide.ts); this file gathers facts and performs the effects.
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import {
  acquirePatchLock,
  adHocSign,
  buildPatchedArchive,
  type CommandRunner,
  compareVersions,
  defaultRunCommand,
  ensureBackup,
  errnoCode,
  exists,
  findAnchorFilesInArchive,
  type InjectorAsset,
  inspectAsar,
  liveHelperPid,
  loadInjector,
  LockBusyError,
  type Logger,
  makeTempDir,
  ORCA_PACKAGE_NAME,
  PatcherError,
  patcherHome,
  readAppPackage,
  readJson,
  readPending,
  readUserConfig,
  removeDir,
  removePending,
  replaceAsar,
  sha256File,
  verifyPatched,
  writeJsonAtomic,
  writePending
} from '@mlp/orca-patch-core'
import type { BridgeLogger } from '@mlp/lsp-bridge'
import {
  decideRepair,
  describeOutcome,
  type RepairOutcome,
  type RepairReport,
  type RepairState
} from './decide'
import { EXEC_PATH_OVERRIDE_ENV, type OrcaInstall, orcaInstallFromExecPath } from './locate-orca'

/** Recorded in version.json and the lock file. */
export const PATCHED_BY_PLUGIN = 'cpoepke.monaco-lsp'
/** How long after activate the automatic check runs (activate itself must stay instant). */
export const AUTO_CHECK_DELAY_MS = 1_500

export type HelperLaunch = {
  /** dist/apply-pending.mjs in the plugin folder. */
  script: string
  asarPath: string
  /** Orca's main process. */
  waitPid: number
  logFile: string
}

export type LastRepair = {
  at: string
  trigger: string
  state: RepairState
  action: RepairReport['action']
  message: string
  orcaVersion: string | null
  injectorVersion: string | null
}

export type PatchStatus = {
  state: 'patched' | 'outdated' | 'unpatched' | 'pending' | 'not-found' | 'not-orca' | 'unknown'
  orcaVersion: string | null
  injectorVersion: string | null
  asarPath: string | null
  autoRepair: boolean
  lastRepair: LastRepair | null
}

export type SelfRepairDeps = {
  execPath: string
  platform: NodeJS.Platform
  env: Readonly<Record<string, string | undefined>>
  homedir: string
  /** Folder holding orca-plugin.json, assets/injector.js and dist/apply-pending.mjs. */
  pluginRoot: string | null
  /** Orca's main process (the worker's parent): the pending helper waits for it to exit. */
  parentPid: number
  pluginVersion: string
  runCommand?: CommandRunner
  spawnHelper?: (launch: HelperLaunch) => number | null
  /** Test hook: replace app.asar (default: the core's atomic replace). */
  replaceAsar?: (source: string, asarPath: string) => void
  now?: () => Date
}

export type SelfRepairIo = { notify(body: string): void; log: BridgeLogger }

export type SelfRepair = {
  attach(io: SelfRepairIo): void
  /** Run a check now (serialized with any running one). Never throws. */
  check(options: { forced: boolean; trigger: string }): Promise<RepairReport>
  /** Automatic check, at most once per worker lifetime (again only after `busy`). */
  autoCheck(trigger: string): void
  /** Settles when the running check (if any) is done. */
  idle(): Promise<void>
  /** Cheap synchronous snapshot for `mlp.status`. Never throws. */
  status(): PatchStatus
}

type SelfRepairState = { lastRepair?: LastRepair; notified?: Record<string, string> }

export function createSelfRepair(deps: SelfRepairDeps): SelfRepair {
  const now = deps.now ?? (() => new Date())
  const runCommand = deps.runCommand ?? defaultRunCommand
  const stateDir = patcherHome(deps.env, deps.homedir)
  const stateFile = path.join(stateDir, 'self-repair.json')
  let io: SelfRepairIo | null = null
  let queue: Promise<unknown> = Promise.resolve()
  let autoChecked = false

  const log = {
    info: (message: string, meta?: Record<string, unknown>) =>
      io?.log.info(`self-repair: ${message}`, meta),
    warn: (message: string, meta?: Record<string, unknown>) =>
      io?.log.warn(`self-repair: ${message}`, meta),
    error: (message: string, meta?: Record<string, unknown>) =>
      io?.log.error(`self-repair: ${message}`, meta)
  }
  const coreLogger: Logger = { info: log.info, warn: log.warn, error: log.error }

  function locate(): OrcaInstall | null {
    const execPath = deps.env[EXEC_PATH_OVERRIDE_ENV] || deps.execPath
    return orcaInstallFromExecPath(execPath, deps.platform)
  }

  function bundledInjector(): InjectorAsset | null {
    if (!deps.pluginRoot) return null
    try {
      const asset = loadInjector(path.join(deps.pluginRoot, 'assets', 'injector.js'))
      return asset.version === 'unknown' ? null : asset
    } catch {
      return null
    }
  }

  function readState(): SelfRepairState {
    return readJson<SelfRepairState>(stateFile) ?? {}
  }

  function writeState(state: SelfRepairState): void {
    try {
      writeJsonAtomic(stateFile, state)
    } catch (error) {
      log.warn('could not save state', { error: String(error) })
    }
  }

  async function gatherAndAct(forced: boolean): Promise<RepairOutcome> {
    const config = readUserConfig(stateDir)
    if (!forced && !config.autoRepair) return { kind: 'skipped', state: 'disabled' }
    const install = locate()
    if (!install || !exists(install.asarPath)) {
      return {
        kind: 'skipped',
        state: 'not-found',
        detail: install?.asarPath ?? deps.execPath
      }
    }
    const pkg = readAppPackage(install.asarPath)
    if (pkg.name !== ORCA_PACKAGE_NAME) {
      return {
        kind: 'skipped',
        state: 'not-orca',
        detail: `package "${pkg.name ?? 'unknown'}" at ${install.asarPath}`
      }
    }
    const injector = bundledInjector()
    const inspection = inspectAsar(install.asarPath)
    const pendingWaiting =
      inspection.injectedBlocks === 0 ? await pendingIsWaiting(install.asarPath) : false
    const decision = decideRepair({
      forced,
      autoRepair: config.autoRepair,
      install: 'found',
      bundledInjectorVersion: injector?.version ?? null,
      inspection: {
        orcaVersion: inspection.orcaVersion,
        injectedBlocks: inspection.injectedBlocks,
        injectorVersion: inspection.versionInfo?.injectorVersion ?? null
      },
      anchorPresent:
        inspection.injectedBlocks === 0 && !pendingWaiting
          ? findAnchorFilesInArchive(install.asarPath).length > 0
          : null,
      pendingWaiting
    })
    log.info('decision', { decision, orcaVersion: inspection.orcaVersion, asar: install.asarPath })
    switch (decision.kind) {
      case 'skip':
        return { kind: 'skipped', state: decision.state }
      case 'up-to-date':
        return {
          kind: 'up-to-date',
          orcaVersion: inspection.orcaVersion,
          injectorVersion: inspection.versionInfo?.injectorVersion ?? null
        }
      case 'unsupported':
        return { kind: 'unsupported', orcaVersion: inspection.orcaVersion }
      case 'patch':
        return patch(install, injector!, decision.reason, config.resign, inspection.orcaVersion)
    }
  }

  /**
   * A pending archive built from the current app.asar with a live helper → nothing to do. A stale
   * one (Orca changed since) is dropped; a valid one whose helper died gets a new helper.
   */
  async function pendingIsWaiting(asarPath: string): Promise<boolean> {
    const pending = readPending(asarPath)
    if (!pending) return false
    if ((await sha256File(asarPath)) !== pending.baseSha256) {
      log.info('dropping a stale pending archive')
      removePending(asarPath)
      return false
    }
    if (liveHelperPid(asarPath) === null) {
      log.info('pending archive has no helper; starting one')
      launchHelper(asarPath)
    }
    return true
  }

  function launchHelper(asarPath: string): void {
    const launch: HelperLaunch = {
      script: path.join(deps.pluginRoot ?? '', 'dist', 'apply-pending.mjs'),
      asarPath,
      waitPid: deps.parentPid,
      logFile: path.join(stateDir, 'logs', 'apply-pending.log')
    }
    const pid = (deps.spawnHelper ?? spawnDetachedHelper)(launch)
    log.info('started the pending-swap helper', { pid, waitPid: launch.waitPid })
  }

  async function patch(
    install: OrcaInstall,
    injector: InjectorAsset,
    reason: 'unpatched' | 'upgrade' | 'reinject',
    resign: boolean,
    orcaVersion: string | null
  ): Promise<RepairOutcome> {
    const elevation = (): RepairOutcome => ({
      kind: 'needs-elevation',
      orcaVersion,
      platform: deps.platform,
      appRoot: install.appRoot,
      dir: install.resourcesDir,
      appImage: install.appImage
    })
    const isReadOnly = (error: unknown): boolean =>
      ['EACCES', 'EROFS', 'EPERM'].includes(errnoCode(error) ?? '')

    let lock: ReturnType<typeof acquirePatchLock>
    try {
      lock = acquirePatchLock(install.asarPath, { tool: PATCHED_BY_PLUGIN })
    } catch (error) {
      if (error instanceof LockBusyError) {
        return {
          kind: 'busy',
          owner: error.owner ? `${error.owner.tool}, pid ${error.owner.pid}` : null
        }
      }
      if (isReadOnly(error)) return elevation()
      return { kind: 'failed', orcaVersion, error: String(error) }
    }
    const workDir = makeTempDir('mlp-repair-')
    try {
      log.info('patching', { reason, asar: install.asarPath, injector: injector.version })
      const built = await buildPatchedArchive({
        asarPath: install.asarPath,
        workDir,
        injector,
        patcherVersion: deps.pluginVersion,
        patchedBy: PATCHED_BY_PLUGIN,
        now
      })
      try {
        await ensureBackup(coreLogger, install.asarPath, built.before)
      } catch (error) {
        if (isReadOnly(error)) return elevation()
        throw error
      }
      try {
        ;(deps.replaceAsar ?? replaceAsar)(built.asar, install.asarPath)
      } catch (error) {
        const code = errnoCode(error)
        if (code === 'EBUSY' || (code === 'EPERM' && deps.platform === 'win32')) {
          log.info('app.asar is locked by the running Orca; deferring the swap', { code })
          writePending(install.asarPath, built.asar, {
            baseSha256: await sha256File(install.asarPath),
            orcaVersion: built.orcaVersion,
            injectorVersion: injector.version,
            waitPid: deps.parentPid,
            createdAt: now().toISOString()
          })
          launchHelper(install.asarPath)
          return {
            kind: 'pending',
            orcaVersion: built.orcaVersion,
            injectorVersion: injector.version
          }
        }
        if (isReadOnly(error)) return elevation()
        throw error
      }
      verifyPatched(install.asarPath, injector.version)
      removePending(install.asarPath)
      let resigned: boolean | null = null
      let signError: string | undefined
      if (install.appBundle && deps.platform === 'darwin') {
        resigned = resign
        if (resign) {
          try {
            await adHocSign({ runCommand, logger: coreLogger }, install.appBundle)
          } catch (error) {
            signError = error instanceof Error ? error.message.split('\n')[0] : String(error)
          }
        }
      }
      return {
        kind: 'patched',
        reason,
        orcaVersion: built.orcaVersion,
        injectorVersion: injector.version,
        resigned,
        ...(signError ? { signError } : {})
      }
    } catch (error) {
      if (error instanceof PatcherError && error.reason === 'anchor-missing') {
        return { kind: 'unsupported', orcaVersion }
      }
      return {
        kind: 'failed',
        orcaVersion,
        error: error instanceof Error ? error.message.split('\n')[0]! : String(error)
      }
    } finally {
      removeDir(workDir)
      lock.release()
    }
  }

  async function run(forced: boolean, trigger: string): Promise<RepairReport> {
    let outcome: RepairOutcome
    try {
      outcome = await gatherAndAct(forced)
    } catch (error) {
      outcome = { kind: 'failed', orcaVersion: null, error: String(error) }
    }
    const report = describeOutcome(outcome, forced)
    const level = report.action === 'failed' ? 'error' : 'info'
    log[level]('result', { trigger, state: report.state, action: report.action })
    const state = readState()
    const notified = state.notified ?? {}
    const shouldNotify =
      report.notify && (forced || report.dedupeKey === null || !notified[report.dedupeKey])
    if (shouldNotify) {
      io?.notify(report.message)
      if (report.dedupeKey) notified[report.dedupeKey] = now().toISOString()
    }
    const changed = report.action !== 'none' || report.state === 'unsupported'
    if (changed || forced) {
      state.lastRepair = {
        at: now().toISOString(),
        trigger,
        state: report.state,
        action: report.action,
        message: report.message,
        orcaVersion: 'orcaVersion' in outcome ? outcome.orcaVersion : null,
        injectorVersion: 'injectorVersion' in outcome ? outcome.injectorVersion : null
      }
    }
    if (changed || forced || shouldNotify) writeState({ ...state, notified })
    return report
  }

  function check(options: { forced: boolean; trigger: string }): Promise<RepairReport> {
    const next = queue.then(() => run(options.forced, options.trigger))
    queue = next.catch(() => {})
    return next
  }

  function autoCheck(trigger: string): void {
    if (autoChecked) return
    autoChecked = true
    void check({ forced: false, trigger }).then((report) => {
      if (report.state === 'busy') autoChecked = false
    })
  }

  function status(): PatchStatus {
    let config = { autoRepair: true }
    let lastRepair: LastRepair | null = null
    try {
      config = readUserConfig(stateDir)
      lastRepair = readState().lastRepair ?? null
    } catch {
      // defaults
    }
    const base = { autoRepair: config.autoRepair, lastRepair }
    try {
      const install = locate()
      if (!install || !exists(install.asarPath)) {
        return {
          ...base,
          state: 'not-found',
          orcaVersion: null,
          injectorVersion: null,
          asarPath: install?.asarPath ?? null
        }
      }
      const pkg = readAppPackage(install.asarPath)
      if (pkg.name !== ORCA_PACKAGE_NAME) {
        return {
          ...base,
          state: 'not-orca',
          orcaVersion: pkg.version,
          injectorVersion: null,
          asarPath: install.asarPath
        }
      }
      const info = inspectAsar(install.asarPath)
      const injectorVersion = info.versionInfo?.injectorVersion ?? null
      const bundled = bundledInjector()?.version ?? null
      const state: PatchStatus['state'] =
        info.injectedBlocks === 1
          ? bundled && (!injectorVersion || compareVersions(injectorVersion, bundled) < 0)
            ? 'outdated'
            : 'patched'
          : readPending(install.asarPath)
            ? 'pending'
            : 'unpatched'
      return {
        ...base,
        state,
        orcaVersion: info.orcaVersion,
        injectorVersion,
        asarPath: install.asarPath
      }
    } catch {
      return { ...base, state: 'unknown', orcaVersion: null, injectorVersion: null, asarPath: null }
    }
  }

  return {
    attach: (value) => {
      io = value
    },
    check,
    autoCheck,
    idle: () => queue.then(() => undefined),
    status
  }
}

/** Start dist/apply-pending.mjs with Orca's own binary in Node mode, detached from the worker. */
export function spawnDetachedHelper(launch: HelperLaunch): number | null {
  const child = spawn(
    process.execPath,
    [
      launch.script,
      '--asar',
      launch.asarPath,
      '--wait-pid',
      String(launch.waitPid),
      '--log',
      launch.logFile
    ],
    {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    }
  )
  child.on('error', () => {})
  child.unref()
  return child.pid ?? null
}
