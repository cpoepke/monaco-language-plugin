/**
 * Deferred swap for Windows, where a running Orca keeps app.asar open without FILE_SHARE_DELETE so
 * it cannot be replaced: the patched archive is parked next to it as `app.asar.mlp-pending` and a
 * detached helper swaps it in once Orca's main process has exited.
 */
import { randomBytes } from 'node:crypto'
import { uncache } from './asar.js'
import { backupPaths, readBackupMeta } from './backup.js'
import {
  PENDING_HELPER_LOCK_SUFFIX,
  PENDING_META_SUFFIX,
  PENDING_SUFFIX,
  TMP_SUFFIX
} from './constants.js'
import { errnoCode } from './errors.js'
import { fs } from './fs.js'
import { atomicReplace, exists, readJson, sha256File, writeJsonAtomic } from './fsutil.js'
import { inspectAsar } from './inspect.js'
import { acquirePatchLockWait, type PatchLock } from './lock.js'
import type { Logger } from './logger.js'

export type PendingMeta = {
  /** sha256 of app.asar the pending archive was built from; a different app.asar means stale. */
  baseSha256: string
  orcaVersion: string | null
  injectorVersion: string
  /** Orca main process the helper waits for. */
  waitPid: number
  createdAt: string
  /** Set once the helper is running. */
  helperPid?: number
}

export const pendingPaths = (
  asarPath: string
): { archive: string; meta: string; helperLock: string } => ({
  archive: `${asarPath}${PENDING_SUFFIX}`,
  meta: `${asarPath}${PENDING_META_SUFFIX}`,
  helperLock: `${asarPath}${PENDING_HELPER_LOCK_SUFFIX}`
})

/** True while `pid` exists (EPERM: exists but owned by someone else). */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return errnoCode(error) === 'EPERM'
  }
}

/** Park `rebuiltAsar` as `<asar>.mlp-pending` (temp + rename, so it is never half-written). */
export function writePending(asarPath: string, rebuiltAsar: string, meta: PendingMeta): void {
  const { archive, meta: metaFile } = pendingPaths(asarPath)
  atomicReplace(rebuiltAsar, archive, `${archive}${TMP_SUFFIX}`)
  writeJsonAtomic(metaFile, meta)
}

export function readPending(asarPath: string): PendingMeta | null {
  const { archive, meta } = pendingPaths(asarPath)
  if (!exists(archive)) return null
  return readJson<PendingMeta>(meta)
}

export function removePending(asarPath: string): void {
  const { archive, meta } = pendingPaths(asarPath)
  fs.rmSync(archive, { force: true })
  fs.rmSync(`${archive}${TMP_SUFFIX}`, { force: true })
  fs.rmSync(meta, { force: true })
}

/** Pid of a live helper holding the helper lock, or null. */
export function liveHelperPid(asarPath: string): number | null {
  const pid = readJson<{ pid?: unknown }>(pendingPaths(asarPath).helperLock)?.pid
  return typeof pid === 'number' && pid !== process.pid && isProcessAlive(pid) ? pid : null
}

export type ApplyPendingResult =
  | 'applied'
  /** app.asar changed since the pending archive was built (Orca updated again, CLI ran): dropped. */
  | 'stale'
  | 'missing'
  /** Another helper is already waiting. */
  | 'busy'
  /** Orca did not exit within the timeout; the pending archive stays for a later helper. */
  | 'timeout'
  | 'failed'

export type ApplyPendingOptions = {
  asarPath: string
  waitPid: number
  logger: Logger
  /** Give up waiting for Orca after this long (default 24 h). */
  timeoutMs?: number
  pollMs?: number
  /** Retry the final rename this long while the file is still locked (default 5 min). */
  swapRetryMs?: number
  /** Wait for the shared patch lock this long (default 5 min). */
  lockWaitMs?: number
  isAlive?: (pid: number) => boolean
  sleep?: (ms: number) => Promise<void>
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * The helper's job: wait for `waitPid` (Orca's main process) to exit, then swap the pending
 * archive in with one rename and verify it. Never leaves a half-written app.asar: the archive is
 * validated before the swap and the swap is a single rename in the same directory.
 */
export async function applyPending(options: ApplyPendingOptions): Promise<ApplyPendingResult> {
  const { asarPath, logger } = options
  const isAlive = options.isAlive ?? isProcessAlive
  const sleep = options.sleep ?? realSleep
  const pollMs = options.pollMs ?? 1_000
  const paths = pendingPaths(asarPath)

  // Single instance per app.asar.
  try {
    fs.writeFileSync(paths.helperLock, JSON.stringify({ pid: process.pid }), { flag: 'wx' })
  } catch (error) {
    if (errnoCode(error) !== 'EEXIST') throw error
    const other = liveHelperPid(asarPath)
    if (other !== null) {
      logger.info(`another helper (pid ${other}) is already waiting; exiting`)
      return 'busy'
    }
    fs.writeFileSync(paths.helperLock, JSON.stringify({ pid: process.pid }))
  }
  const releaseHelperLock = (): void => {
    const pid = readJson<{ pid?: unknown }>(paths.helperLock)?.pid
    if (pid === process.pid) fs.rmSync(paths.helperLock, { force: true })
  }

  let patchLock: PatchLock | null = null
  try {
    const initial = readPending(asarPath)
    if (!initial) {
      logger.warn(`no pending archive at ${paths.archive}`)
      return 'missing'
    }
    writeJsonAtomic(paths.meta, { ...initial, helperPid: process.pid })
    logger.info(`waiting for Orca (pid ${options.waitPid}) to exit`)
    const deadline = Date.now() + (options.timeoutMs ?? 24 * 60 * 60_000)
    while (isAlive(options.waitPid)) {
      if (Date.now() >= deadline) {
        logger.warn('timed out waiting for Orca to exit; leaving the pending archive in place')
        return 'timeout'
      }
      await sleep(pollMs)
    }
    logger.info('Orca exited')
    // Why: give Windows a moment to release the file handles of the exited process.
    await sleep(Math.min(pollMs, 1_000))

    patchLock = await acquirePatchLockWait(asarPath, {
      tool: 'apply-pending',
      waitMs: options.lockWaitMs ?? 5 * 60_000
    })
    const meta = readPending(asarPath)
    if (!meta) {
      logger.warn('pending archive disappeared')
      return 'missing'
    }
    const currentSha = await sha256File(asarPath)
    if (currentSha !== meta.baseSha256) {
      logger.warn('app.asar changed since the pending archive was built; discarding it')
      removePending(asarPath)
      return 'stale'
    }
    const pending = inspectAsar(paths.archive)
    if (
      pending.injectedBlocks !== 1 ||
      pending.versionInfo?.injectorVersion !== meta.injectorVersion
    ) {
      logger.error('pending archive failed validation; discarding it')
      removePending(asarPath)
      return 'failed'
    }

    const swapDeadline = Date.now() + (options.swapRetryMs ?? 5 * 60_000)
    for (;;) {
      try {
        fs.renameSync(paths.archive, asarPath)
        break
      } catch (error) {
        const code = errnoCode(error)
        if (
          (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') &&
          Date.now() < swapDeadline
        ) {
          await sleep(2_000)
          continue
        }
        logger.error(`could not swap the pending archive in: ${String(error)}`)
        return 'failed'
      }
    }
    uncache(asarPath)
    const after = inspectAsar(asarPath)
    if (after.injectedBlocks !== 1) {
      logger.error('verification after the swap failed')
      restoreBackup(asarPath, logger)
      fs.rmSync(paths.meta, { force: true })
      return 'failed'
    }
    fs.rmSync(paths.meta, { force: true })
    logger.info(
      `applied: Orca ${after.orcaVersion ?? '?'} patched with injector ${
        after.versionInfo?.injectorVersion ?? '?'
      }`
    )
    return 'applied'
  } catch (error) {
    logger.error(`apply-pending failed: ${error instanceof Error ? error.message : String(error)}`)
    return 'failed'
  } finally {
    patchLock?.release()
    releaseHelperLock()
  }
}

function restoreBackup(asarPath: string, logger: Logger): void {
  const { backup } = backupPaths(asarPath)
  if (!exists(backup) || !readBackupMeta(asarPath)) return
  try {
    atomicReplace(backup, asarPath, `${asarPath}${TMP_SUFFIX}-${randomBytes(4).toString('hex')}`)
    logger.warn('restored the pristine app.asar from the backup')
  } catch (error) {
    logger.error(`could not restore the backup: ${String(error)}`)
  }
}
