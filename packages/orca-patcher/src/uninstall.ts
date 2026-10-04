import fs from 'node:fs'
import path from 'node:path'
import {
  adHocSign,
  atomicReplace,
  backupPaths,
  configPath,
  exists,
  INJECTOR_ASAR_PATH,
  inspectAsar,
  makeTempDir,
  PatcherError,
  readBackupMeta,
  readEntries,
  readOrcaVersion,
  readUserConfig,
  rebuildArchive,
  removeBackup,
  removeDir,
  removePending,
  removeScriptBlocks,
  RENDERER_DIR,
  RENDERER_INDEX,
  sha256File,
  TMP_SUFFIX,
  uncache,
  verifyCodeSignature,
  VERSION_ASAR_PATH,
  writeUserConfig
} from '@mlp/orca-patch-core'
import { chownToInvokingUser, type CommonOptions, createContext } from './context.js'
import { assertNotRunning, assertWritable, lockForPatching } from './install.js'
import { type OrcaTarget, resolveTarget } from './locate.js'
import { installedPluginDir } from './plugin.js'
import { forgetPatch } from './state.js'

export type UninstallOptions = CommonOptions & {
  force?: boolean
  /** Also delete the installed plugin folder (~/.monaco-lsp-orca/plugin/...). */
  purge?: boolean
  /** How long to wait for the patch lock held by another patcher/the plugin (default 30 s). */
  lockWaitMs?: number
}

export type UninstallResult = {
  target: OrcaTarget
  action: 'restored' | 'stripped' | 'not-patched'
  pluginRemoved: boolean
}

export async function uninstall(options: UninstallOptions = {}): Promise<UninstallResult> {
  const ctx = createContext(options)
  const { logger } = ctx
  const target = resolveTarget(ctx, options.app)
  logger.info(`Orca: ${target.asarPath}`)
  await assertNotRunning(ctx, target, options.force)
  assertWritable(target)
  const lock = await lockForPatching(ctx, target, options.lockWaitMs)
  try {
    return await uninstallLocked(ctx, target, options)
  } finally {
    lock.release()
  }
}

async function uninstallLocked(
  ctx: ReturnType<typeof createContext>,
  target: OrcaTarget,
  options: UninstallOptions
): Promise<UninstallResult> {
  const { logger } = ctx
  // Why before anything else: inspectAsar reads a truncated or damaged archive as "not patched",
  // and the "not patched" branch below deletes the backup, which would then be the only good copy.
  try {
    readEntries(target.asarPath)
  } catch (error) {
    const { backup } = backupPaths(target.asarPath)
    if (error instanceof PatcherError && exists(backup)) {
      throw new PatcherError(
        `${error.message}\nThe backup ${backup} was left untouched; once you have checked it, ` +
          `copy it over ${target.asarPath} to recover.`,
        error.exitCode,
        error.reason
      )
    }
    throw error
  }
  // Why first: otherwise the plugin's self-repair would patch Orca again on its next start.
  writeUserConfig(ctx.stateDir, { autoRepair: false })
  chownToInvokingUser(ctx, configPath(ctx.stateDir))
  removePending(target.asarPath)

  const current = inspectAsar(target.asarPath)
  const patched = current.injectedBlocks > 0 || current.versionInfo != null
  const { backup } = backupPaths(target.asarPath)
  const meta = readBackupMeta(target.asarPath)
  let action: UninstallResult['action']

  if (!patched) {
    logger.info('Orca is not patched; nothing to restore.')
    if (exists(backup)) {
      logger.info(`Removing leftover backup ${backup}`)
      removeBackup(target.asarPath)
    }
    action = 'not-patched'
  } else {
    let restored = false
    if (exists(backup) && meta) {
      const sha = await sha256File(backup)
      const backupVersion = readOrcaVersion(backup)
      if (sha !== meta.sha256) {
        logger.warn('Backup checksum does not match its sidecar; removing the injection in place.')
      } else if (backupVersion !== current.orcaVersion) {
        logger.warn(
          `Backup is Orca ${backupVersion ?? '?'} but the installed Orca is ${current.orcaVersion ?? '?'}; ` +
            'not restoring an old version, removing the injection in place.'
        )
      } else {
        atomicReplace(backup, target.asarPath, `${target.asarPath}${TMP_SUFFIX}`)
        uncache(target.asarPath)
        const restoredSha = await sha256File(target.asarPath)
        if (restoredSha !== meta.sha256) {
          throw new PatcherError(
            `Restored ${target.asarPath} does not match the backup checksum. The backup is kept at ${backup}.`
          )
        }
        removeBackup(target.asarPath)
        logger.info(`Restored the original app.asar from ${backup}`)
        restored = true
      }
    } else {
      logger.warn('No backup found; removing the injection in place.')
    }
    if (!restored) {
      await stripInjection(target)
      logger.info('Removed the injection from app.asar')
    }
    action = restored ? 'restored' : 'stripped'
    if (target.appBundle && ctx.platform === 'darwin') {
      const { resign } = readUserConfig(ctx.stateDir)
      // Why: in --no-resign mode the Developer ID signature was never replaced, so restoring the
      // original app.asar makes it valid again; only re-sign if it still does not verify.
      const check = resign ? null : await verifyCodeSignature(ctx, target.appBundle)
      if (check?.valid === true) {
        logger.info(
          'macOS: the original Developer ID signature verifies again (codesign --verify).'
        )
      } else {
        await adHocSign(ctx, target.appBundle)
        logger.info(
          'macOS: Orca.app is still ad-hoc signed (app.asar is restored, the Developer ID signature is ' +
            'not). Reinstall Orca from the official download to fully revert, including keychain ' +
            'access, privacy (TCC) grants and auto-update.'
        )
      }
    }
  }
  forgetPatch(ctx, target.asarPath)

  let pluginRemoved = false
  const pluginDir = installedPluginDir(ctx)
  if (options.purge) {
    if (exists(pluginDir)) {
      fs.rmSync(pluginDir, { recursive: true, force: true })
      pluginRemoved = true
      logger.info(`Removed ${pluginDir}`)
    }
    logger.info(
      'If you installed the plugin in Orca, remove it there too: Settings → Plugins → cpoepke.monaco-lsp → Remove.'
    )
  } else if (exists(pluginDir)) {
    logger.info(`Plugin folder kept at ${pluginDir} (use --purge to delete it).`)
  }
  return { target, action, pluginRemoved }
}

/** Remove the marker block and our files from app.asar (used when no usable backup exists). */
async function stripInjection(target: OrcaTarget): Promise<void> {
  const originalEntries = readEntries(target.asarPath)
  const touched = new Set([RENDERER_INDEX, INJECTOR_ASAR_PATH, VERSION_ASAR_PATH])
  const workDir = makeTempDir('mlp-unpatch-')
  try {
    const rebuilt = await rebuildArchive({
      asarPath: target.asarPath,
      workDir,
      originalEntries,
      touched,
      mutate: (dir) => {
        const indexAbs = path.join(dir, ...RENDERER_INDEX.split('/'))
        fs.writeFileSync(indexAbs, removeScriptBlocks(fs.readFileSync(indexAbs, 'utf8')))
        fs.rmSync(path.join(dir, ...RENDERER_DIR.split('/'), 'mlp'), {
          recursive: true,
          force: true
        })
      }
    })
    atomicReplace(rebuilt.asar, target.asarPath, `${target.asarPath}${TMP_SUFFIX}`)
    uncache(target.asarPath)
  } finally {
    removeDir(workDir)
  }
}
