import path from 'node:path'
import {
  acquirePatchLockWait,
  adHocSign,
  type BackupAction,
  backupPaths,
  type BackupMeta,
  buildPatchedArchive,
  ensureBackup,
  findAnchorFiles,
  handleAsarIntegrity,
  INJECTOR_ASAR_PATH,
  inspectAsar,
  isWritable,
  makeTempDir,
  type PatchLock,
  PatcherError,
  RENDERER_INDEX,
  readEntries,
  removeDir,
  removePending,
  replaceAsar,
  signingNote,
  type UserConfig,
  VERSION_ASAR_PATH,
  verifyPatched,
  writeUserConfig,
  configPath
} from '@mlp/orca-patch-core'
import { defaultPluginSource, loadInjector } from './assets.js'
import { PATCHER_VERSION } from './constants.js'
import { chownToInvokingUser, type CommonOptions, type Context, createContext } from './context.js'
import { type OrcaTarget, resolveTarget } from './locate.js'
import { installPluginFolder, pluginInstructions, type PluginInstallResult } from './plugin.js'
import { findRunningOrca } from './process.js'
import { recordPatch } from './state.js'

export { findAnchorFiles }

/** Tool name recorded in version.json and the lock file. */
export const PATCHED_BY_CLI = 'monaco-lsp-orca'

export type InstallOptions = CommonOptions & {
  dryRun?: boolean
  /** Patch even if Orca appears to be running. */
  force?: boolean
  /** macOS: remove a stale ElectronAsarIntegrity entry from Info.plist. */
  fixIntegrity?: boolean
  /** Injector bundle to install (default: the copy bundled with this package). */
  injectorPath?: string
  /** Plugin folder to install (default: the copy bundled with this package). */
  pluginSource?: string
  /** Do not install the plugin folder. */
  skipPlugin?: boolean
  /** macOS: ad-hoc re-sign Orca.app after patching (default true; `--no-resign` sets false). */
  resign?: boolean
  /** Let the Orca plugin re-apply the patch after Orca updates (default true). */
  autoRepair?: boolean
  /** How long to wait for the patch lock held by another patcher/the plugin (default 30 s). */
  lockWaitMs?: number
}

export type InstallResult = {
  target: OrcaTarget
  orcaVersion: string | null
  injectorVersion: string
  dryRun: boolean
  /** Renderer chunks that contain the Monaco globalAPI anchor. */
  anchorFiles: string[]
  backup: BackupMeta | null
  backupAction: BackupAction | 'skipped'
  plugin: PluginInstallResult | null
  /** The settings written to config.json (null on a dry run). */
  config: UserConfig | null
  /** macOS: whether the app was re-signed (null elsewhere). */
  resigned: boolean | null
}

export async function assertNotRunning(
  ctx: Context,
  target: OrcaTarget,
  force: boolean | undefined
): Promise<void> {
  const running = await findRunningOrca(ctx, target)
  if (running == null) {
    ctx.logger.warn('Could not read the process list; make sure Orca is not running.')
    return
  }
  if (running.length === 0) return
  if (force) {
    ctx.logger.warn('Orca appears to be running; continuing because of --force.')
    return
  }
  throw new PatcherError(
    `Orca appears to be running (${running.length} process(es), e.g. ${running[0]}).\n` +
      'Quit Orca first, or pass --force if this is a false positive.'
  )
}

export function assertWritable(target: OrcaTarget): void {
  if (isWritable(target.asarPath) && isWritable(target.resourcesDir)) return
  const hint =
    target.kind === 'linux'
      ? 'Re-run with sudo (system-wide deb/rpm install).'
      : target.kind === 'windows'
        ? 'Re-run from an elevated terminal if Orca is installed for all users.'
        : target.kind === 'macos-app'
          ? 'Make sure your user can write to the app (admin account), or use sudo.'
          : 'Check the file permissions.'
  throw new PatcherError(`${target.resourcesDir} is not writable. ${hint}`)
}

/** Take the patch lock shared with the Orca plugin's self-repair (waits while it is busy). */
export function lockForPatching(
  ctx: Context,
  target: OrcaTarget,
  waitMs = 30_000
): Promise<PatchLock> {
  return acquirePatchLockWait(target.asarPath, {
    tool: PATCHED_BY_CLI,
    waitMs,
    onWait: (owner) =>
      ctx.logger.info(
        `Waiting for ${owner ? `${owner.tool} (pid ${owner.pid})` : 'another process'} to finish patching…`
      )
  })
}

export async function install(options: InstallOptions = {}): Promise<InstallResult> {
  const ctx = createContext(options)
  const { logger } = ctx
  const dryRun = options.dryRun === true
  const resign = options.resign !== false
  const autoRepair = options.autoRepair !== false
  const target = resolveTarget(ctx, options.app)
  const injector = loadInjector(options.injectorPath)
  const signsApp = target.appBundle != null && ctx.platform === 'darwin'
  logger.info(`Orca: ${target.asarPath}`)
  if (ctx.invokingUser) {
    logger.info(
      `Running under sudo: state and plugin folder go to ${ctx.stateDir} (owned by ${ctx.invokingUser.name})`
    )
  }

  await assertNotRunning(ctx, target, options.force)
  if (dryRun) {
    if (!isWritable(target.resourcesDir)) logger.warn(`${target.resourcesDir} is not writable.`)
  } else {
    assertWritable(target)
  }

  const entries = readEntries(target.asarPath)
  const index = entries.get(RENDERER_INDEX)
  if (!index || index.type !== 'file') {
    throw new PatcherError(
      `${RENDERER_INDEX} not found in ${target.asarPath}. This Orca build has an unexpected layout; ` +
        'nothing was changed.'
    )
  }
  const lock = dryRun ? null : await lockForPatching(ctx, target, options.lockWaitMs)
  const workDir = makeTempDir('mlp-patch-')
  try {
    const current = inspectAsar(target.asarPath)
    logger.info(
      `Orca version ${current.orcaVersion ?? 'unknown'}; injector ${injector.version}` +
        (current.injectedBlocks > 0 ? ' (already patched, updating)' : '')
    )
    const rebuilt = await buildPatchedArchive({
      asarPath: target.asarPath,
      workDir,
      injector,
      patcherVersion: PATCHER_VERSION,
      patchedBy: PATCHED_BY_CLI
    })
    const { anchorFiles, orcaVersion, before } = rebuilt
    logger.info(`Monaco anchor found in ${anchorFiles.join(', ')}`)

    if (dryRun) {
      const { backup } = backupPaths(target.asarPath)
      logger.info(
        [
          'Dry run — would:',
          `  back up ${target.asarPath} → ${backup} (unless a pristine backup exists)`,
          `  inject <script src="./mlp/injector.js"> into ${RENDERER_INDEX}`,
          `  add ${INJECTOR_ASAR_PATH} and ${VERSION_ASAR_PATH}`,
          `  replace ${target.asarPath} atomically (unpacked entries unchanged)`,
          ...(target.appBundle
            ? [
                resign
                  ? `  ad-hoc re-sign ${target.appBundle}`
                  : '  leave the code signature alone (--no-resign)'
              ]
            : []),
          `  write ${configPath(ctx.stateDir)} (autoRepair: ${autoRepair}, resign: ${resign})`,
          ...(options.skipPlugin
            ? []
            : [`  install the plugin folder into ${path.join(ctx.stateDir, 'plugin')}`])
        ].join('\n')
      )
      return {
        target,
        orcaVersion,
        injectorVersion: injector.version,
        dryRun,
        anchorFiles,
        backup: null,
        backupAction: 'skipped',
        plugin: null,
        config: null,
        resigned: null
      }
    }

    const backup = await ensureBackup(logger, target.asarPath, before)
    replaceAsar(rebuilt.asar, target.asarPath)
    verifyPatched(target.asarPath)
    // A pending archive (Windows self-repair waiting for Orca to quit) is obsolete now.
    removePending(target.asarPath)
    logger.info(`Patched ${target.asarPath}`)

    let resigned: boolean | null = null
    if (signsApp && target.appBundle) {
      await handleAsarIntegrity(ctx, target.appBundle, options.fixIntegrity === true)
      if (resign) await adHocSign(ctx, target.appBundle)
      resigned = resign
      logger.info(signingNote(resign))
    }

    recordPatch(ctx, target.asarPath, {
      orcaVersion,
      injectorVersion: injector.version,
      patcherVersion: PATCHER_VERSION,
      patchedAt: new Date().toISOString()
    })
    const config = writeUserConfig(ctx.stateDir, { autoRepair, resign })
    chownToInvokingUser(ctx, configPath(ctx.stateDir))

    let plugin: PluginInstallResult | null = null
    if (!options.skipPlugin) {
      plugin = installPluginFolder(ctx, options.pluginSource ?? defaultPluginSource())
      if (plugin.installed) {
        logger.info(`Plugin folder installed: ${plugin.dir}\n\n${pluginInstructions(plugin.dir)}`)
      } else {
        logger.warn(plugin.reason)
      }
    }
    if (target.kind === 'appimage-extracted') {
      logger.info(
        `Start Orca with ${path.join(target.appRoot, 'AppRun')} (not the original AppImage).`
      )
    }
    logger.info(
      autoRepair
        ? 'Orca updates replace app.asar and remove the patch. The Orca plugin re-applies it ' +
            'automatically after an update (restart Orca once when it tells you). Turn that off with ' +
            '`install --no-auto-repair`.'
        : 'Auto-repair is off: Orca updates remove the patch; run `monaco-lsp-orca install` again ' +
            'after updating (`status` tells you when).'
    )
    return {
      target,
      orcaVersion,
      injectorVersion: injector.version,
      dryRun,
      anchorFiles,
      backup: backup.meta,
      backupAction: backup.action,
      plugin,
      config,
      resigned
    }
  } finally {
    removeDir(workDir)
    lock?.release()
  }
}
