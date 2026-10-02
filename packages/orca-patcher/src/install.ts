import fs from 'node:fs'
import path from 'node:path'
import { readAsarFile, readEntries, uncache } from './asar.js'
import { defaultPluginSource, loadInjector } from './assets.js'
import { backupPaths, type BackupMeta, ensureBackup } from './backup.js'
import {
  INJECTOR_ASAR_PATH,
  MONACO_GLOBAL_API_ANCHOR,
  PATCHER_VERSION,
  RENDERER_ASSETS_DIR,
  RENDERER_INDEX,
  TMP_SUFFIX,
  VERSION_ASAR_PATH
} from './constants.js'
import { type CommonOptions, type Context, createContext } from './context.js'
import { PatcherError } from './errors.js'
import { atomicReplace, isWritable, makeTempDir, removeDir } from './fsutil.js'
import { countInjectedBlocks, injectScriptBlock } from './html.js'
import { inspectAsar } from './inspect.js'
import { type OrcaTarget, resolveTarget } from './locate.js'
import { adHocSign, GATEKEEPER_NOTE, handleAsarIntegrity } from './macos.js'
import { installPluginFolder, pluginInstructions, type PluginInstallResult } from './plugin.js'
import { findRunningOrca } from './process.js'
import { rebuildArchive } from './repack.js'
import { recordPatch } from './state.js'

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
}

export type InstallResult = {
  target: OrcaTarget
  orcaVersion: string | null
  injectorVersion: string
  dryRun: boolean
  /** Renderer chunks that contain the Monaco globalAPI anchor. */
  anchorFiles: string[]
  backup: BackupMeta | null
  backupAction: 'created' | 'kept' | 'refreshed' | 'none' | 'skipped'
  plugin: PluginInstallResult | null
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

/** Renderer chunks (relative paths) containing the Monaco globalAPI anchor. */
export function findAnchorFiles(extractedDir: string): string[] {
  const assetsDir = path.join(extractedDir, ...RENDERER_ASSETS_DIR.split('/'))
  let names: string[]
  try {
    names = fs.readdirSync(assetsDir).filter((n) => n.endsWith('.js'))
  } catch {
    return []
  }
  return names
    .filter((n) =>
      fs.readFileSync(path.join(assetsDir, n), 'utf8').includes(MONACO_GLOBAL_API_ANCHOR)
    )
    .map((n) => `${RENDERER_ASSETS_DIR}/${n}`)
}

export async function install(options: InstallOptions = {}): Promise<InstallResult> {
  const ctx = createContext(options)
  const { logger } = ctx
  const dryRun = options.dryRun === true
  const target = resolveTarget(ctx, options.app)
  const injector = loadInjector(options.injectorPath)
  logger.info(`Orca: ${target.asarPath}`)

  await assertNotRunning(ctx, target, options.force)
  if (dryRun) {
    if (!isWritable(target.resourcesDir)) logger.warn(`${target.resourcesDir} is not writable.`)
  } else {
    assertWritable(target)
  }

  const originalEntries = readEntries(target.asarPath)
  const index = originalEntries.get(RENDERER_INDEX)
  if (!index || index.type !== 'file') {
    throw new PatcherError(
      `${RENDERER_INDEX} not found in ${target.asarPath}. This Orca build has an unexpected layout; ` +
        'nothing was changed.'
    )
  }
  const before = inspectAsar(target.asarPath)
  const orcaVersion = before.orcaVersion
  logger.info(
    `Orca version ${orcaVersion ?? 'unknown'}; injector ${injector.version}` +
      (before.injectedBlocks > 0 ? ' (already patched, updating)' : '')
  )

  const workDir = makeTempDir('mlp-patch-')
  try {
    let anchorFiles: string[] = []
    const touched = new Set([RENDERER_INDEX, INJECTOR_ASAR_PATH, VERSION_ASAR_PATH])
    const rebuilt = await rebuildArchive({
      asarPath: target.asarPath,
      workDir,
      originalEntries,
      touched,
      mutate: (dir) => {
        anchorFiles = findAnchorFiles(dir)
        if (anchorFiles.length === 0) {
          throw new PatcherError(
            `None of ${RENDERER_ASSETS_DIR}/*.js contains the Monaco anchor\n` +
              `  ${MONACO_GLOBAL_API_ANCHOR}\n` +
              'This Orca version bundles Monaco differently, so the injector could not capture it. ' +
              'Nothing was changed. Please report this together with your Orca version.'
          )
        }
        const indexAbs = path.join(dir, ...RENDERER_INDEX.split('/'))
        const html = fs.readFileSync(indexAbs, 'utf8')
        fs.writeFileSync(indexAbs, injectScriptBlock(html))
        const injectorAbs = path.join(dir, ...INJECTOR_ASAR_PATH.split('/'))
        fs.mkdirSync(path.dirname(injectorAbs), { recursive: true })
        fs.writeFileSync(injectorAbs, injector.source)
        fs.writeFileSync(
          path.join(dir, ...VERSION_ASAR_PATH.split('/')),
          `${JSON.stringify(
            {
              injectorVersion: injector.version,
              orcaVersion,
              patcherVersion: PATCHER_VERSION,
              patchedAt: new Date().toISOString()
            },
            null,
            2
          )}\n`
        )
      }
    })

    const newHtml = readAsarFile(rebuilt.asar, RENDERER_INDEX)?.toString('utf8') ?? ''
    if (countInjectedBlocks(newHtml) !== 1 || !readAsarFile(rebuilt.asar, INJECTOR_ASAR_PATH)) {
      throw new PatcherError('Rebuilt archive is missing the injection; nothing was changed.')
    }
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
          ...(target.appBundle ? [`  ad-hoc re-sign ${target.appBundle}`] : []),
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
        plugin: null
      }
    }

    const backup = await ensureBackup(ctx, target, before)
    atomicReplace(rebuilt.asar, target.asarPath, `${target.asarPath}${TMP_SUFFIX}`)
    uncache(target.asarPath)
    const after = inspectAsar(target.asarPath)
    if (after.injectedBlocks !== 1) {
      throw new PatcherError(
        `Verification after writing failed (found ${after.injectedBlocks} injected blocks). ` +
          'Run `monaco-lsp-orca uninstall` to restore the backup.'
      )
    }
    logger.info(`Patched ${target.asarPath}`)

    if (target.appBundle && ctx.platform === 'darwin') {
      await handleAsarIntegrity(ctx, target.appBundle, options.fixIntegrity === true)
      await adHocSign(ctx, target.appBundle)
      logger.info(GATEKEEPER_NOTE)
    }

    recordPatch(ctx, target.asarPath, {
      orcaVersion,
      injectorVersion: injector.version,
      patcherVersion: PATCHER_VERSION,
      patchedAt: new Date().toISOString()
    })

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
      'Orca updates replace app.asar and remove the patch; run `monaco-lsp-orca status` after ' +
        'updating and `install` again if needed.'
    )
    return {
      target,
      orcaVersion,
      injectorVersion: injector.version,
      dryRun,
      anchorFiles,
      backup: backup.meta,
      backupAction: backup.action,
      plugin
    }
  } finally {
    removeDir(workDir)
  }
}
