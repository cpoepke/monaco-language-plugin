import fs from 'node:fs'
import { BACKUP_META_SUFFIX, BACKUP_SUFFIX } from './constants.js'
import type { Context } from './context.js'
import { exists, readJson, sha256File, writeJsonAtomic } from './fsutil.js'
import { type AsarInspection, readOrcaVersion } from './inspect.js'
import type { OrcaTarget } from './locate.js'

export type BackupMeta = {
  sha256: string
  size: number
  orcaVersion: string | null
  createdAt: string
}

export const backupPaths = (asarPath: string): { backup: string; meta: string } => ({
  backup: `${asarPath}${BACKUP_SUFFIX}`,
  meta: `${asarPath}${BACKUP_META_SUFFIX}`
})

export function readBackupMeta(asarPath: string): BackupMeta | null {
  return readJson<BackupMeta>(backupPaths(asarPath).meta)
}

async function writeBackup(asarPath: string): Promise<BackupMeta> {
  const { backup, meta } = backupPaths(asarPath)
  const tmp = `${backup}.tmp-${process.pid}`
  fs.rmSync(tmp, { force: true })
  fs.copyFileSync(asarPath, tmp)
  const sha256 = await sha256File(tmp)
  const record: BackupMeta = {
    sha256,
    size: fs.statSync(tmp).size,
    orcaVersion: readOrcaVersion(tmp),
    createdAt: new Date().toISOString()
  }
  // Write the sidecar first: a backup file without metadata is never trusted for restore.
  writeJsonAtomic(meta, record)
  fs.renameSync(tmp, backup)
  return record
}

export function removeBackup(asarPath: string): void {
  const { backup, meta } = backupPaths(asarPath)
  fs.rmSync(backup, { force: true })
  fs.rmSync(meta, { force: true })
}

/**
 * Make sure a pristine (unpatched) backup of app.asar exists.
 *  - No backup and the current archive is unpatched → create one.
 *  - Backup exists and the current archive is patched → keep it (it is the pristine copy).
 *  - Backup exists, current archive is unpatched but differs → Orca was updated since the backup
 *    was taken; the old backup is stale, so it is replaced by the current (pristine) archive.
 *  - Current archive is patched but there is no backup → none can be made; uninstall will strip
 *    the injection instead of restoring.
 */
export async function ensureBackup(
  ctx: Context,
  target: OrcaTarget,
  current: AsarInspection
): Promise<{ action: 'created' | 'kept' | 'refreshed' | 'none'; meta: BackupMeta | null }> {
  const { backup } = backupPaths(target.asarPath)
  const meta = readBackupMeta(target.asarPath)
  const currentPatched = current.injectedBlocks > 0 || current.versionInfo != null
  if (exists(backup) && meta) {
    if (currentPatched) {
      ctx.logger.info(`Keeping existing backup ${backup}`)
      return { action: 'kept', meta }
    }
    const sha = await sha256File(target.asarPath)
    if (sha === meta.sha256) return { action: 'kept', meta }
    ctx.logger.info(
      `Orca changed since the last backup (${meta.orcaVersion ?? '?'} → ${current.orcaVersion ?? '?'}); ` +
        'refreshing the backup.'
    )
    return { action: 'refreshed', meta: await writeBackup(target.asarPath) }
  }
  if (currentPatched) {
    ctx.logger.warn(
      'Orca is already patched but no backup exists; uninstall will remove the injection in place.'
    )
    return { action: 'none', meta: null }
  }
  const created = await writeBackup(target.asarPath)
  ctx.logger.info(`Backup: ${backup} (sha256 ${created.sha256.slice(0, 12)}…)`)
  return { action: 'created', meta: created }
}
