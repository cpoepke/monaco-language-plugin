import nodeFs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  acquirePatchLock,
  acquirePatchLockWait,
  backupPaths,
  buildPatchedArchive,
  ensureBackup,
  fs,
  inspectAsar,
  loadInjector,
  LOCK_STALE_MS,
  LockBusyError,
  lockPath,
  readBackupMeta,
  readLockOwner,
  removeBackup,
  replaceAsar,
  sha256File
} from '../src/index'
import { type FakeOrca, makeFakeOrca, packFakeOrca } from '../../orca-patcher/test/fake-orca'
import { errno, memoryLogger, tmpDir } from './helpers'

const fakes: FakeOrca[] = []
async function fake(opts?: Parameters<typeof makeFakeOrca>[0]): Promise<FakeOrca> {
  const f = await makeFakeOrca(opts)
  fakes.push(f)
  return f
}
afterEach(() => {
  for (const f of fakes.splice(0)) nodeFs.rmSync(f.root, { recursive: true, force: true })
})

describe('patch lock edge cases', () => {
  it('reports an unreadable lock as an unknown owner', async () => {
    const f = await fake()
    nodeFs.writeFileSync(lockPath(f.asarPath), 'not json')
    expect(readLockOwner(lockPath(f.asarPath))).toBeNull()
    try {
      acquirePatchLock(f.asarPath, { tool: 'x' })
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(LockBusyError)
      expect((error as LockBusyError).owner).toBeNull()
      expect((error as Error).message).toMatch(/unknown owner/)
      expect((error as LockBusyError).reason).toBe('lock-busy')
    }
    // JSON without pid/token is also not an owner
    nodeFs.writeFileSync(lockPath(f.asarPath), '{"pid":"1"}')
    expect(readLockOwner(lockPath(f.asarPath))).toBeNull()
  })

  it.each(['EACCES', 'EROFS', 'EPERM'])(
    'rethrows %s when the directory is not writable (not "busy")',
    async (code) => {
      const f = await fake()
      vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
        throw errno(code)
      })
      expect(() => acquirePatchLock(f.asarPath, { tool: 'x' })).toThrow(
        expect.objectContaining({ code })
      )
    }
  )

  it('retries when the lock vanishes between the failed create and the stat', async () => {
    const f = await fake()
    const holder = acquirePatchLock(f.asarPath, { tool: 'holder' })
    const realStat = fs.statSync
    let first = true
    vi.spyOn(fs, 'statSync').mockImplementation(((p: nodeFs.PathLike, ...rest: unknown[]) => {
      if (first && String(p) === lockPath(f.asarPath)) {
        first = false
        holder.release() // owner released just now
        throw errno('ENOENT')
      }
      return (realStat as (...a: unknown[]) => unknown)(p, ...rest)
    }) as never)
    const lock = acquirePatchLock(f.asarPath, { tool: 'second' })
    expect(lock.owner.tool).toBe('second')
    lock.release()
  })

  it('gives up (busy) when a stale lock cannot be removed', async () => {
    const f = await fake()
    const holder = acquirePatchLock(f.asarPath, { tool: 'holder' })
    const old = new Date(Date.now() - LOCK_STALE_MS - 5_000)
    nodeFs.utimesSync(lockPath(f.asarPath), old, old)
    vi.spyOn(fs, 'rmSync').mockImplementation(() => {
      throw errno('EPERM')
    })
    expect(() => acquirePatchLock(f.asarPath, { tool: 'second' })).toThrow(LockBusyError)
    vi.restoreAllMocks()
    holder.release()
  })

  it('treats a fresh lock as busy and honours an injected clock for staleness', async () => {
    const f = await fake()
    const holder = acquirePatchLock(f.asarPath, { tool: 'holder' })
    expect(() => acquirePatchLock(f.asarPath, { tool: 'second' })).toThrow(LockBusyError)
    const later = Date.now() + 10 * 60_000
    const taken = acquirePatchLock(f.asarPath, { tool: 'second', now: () => later })
    expect(taken.owner.tool).toBe('second')
    taken.release()
    holder.release()
  })

  it('the heartbeat keeps a long-held lock from going stale', async () => {
    const f = await fake()
    const lock = acquirePatchLock(f.asarPath, { tool: 'slow', heartbeatMs: 20 })
    try {
      const old = new Date(Date.now() - 60_000)
      nodeFs.utimesSync(lockPath(f.asarPath), old, old)
      await new Promise((resolve) => setTimeout(resolve, 150))
      expect(Date.now() - nodeFs.statSync(lockPath(f.asarPath)).mtimeMs).toBeLessThan(10_000)
    } finally {
      lock.release()
    }
    // release is idempotent and the heartbeat tolerates a vanished file
    lock.release()
  })

  it('the heartbeat survives the lock file being removed under it', async () => {
    const f = await fake()
    const lock = acquirePatchLock(f.asarPath, { tool: 'slow', heartbeatMs: 10 })
    nodeFs.rmSync(lockPath(f.asarPath))
    await new Promise((resolve) => setTimeout(resolve, 60))
    lock.release()
    expect(nodeFs.existsSync(lockPath(f.asarPath))).toBe(false)
  })

  describe('acquirePatchLockWait', () => {
    it('waits for the holder, reporting the owner once', async () => {
      const f = await fake()
      const holder = acquirePatchLock(f.asarPath, { tool: 'holder' })
      const waits: (string | undefined)[] = []
      setTimeout(() => holder.release(), 120)
      const lock = await acquirePatchLockWait(f.asarPath, {
        tool: 'waiter',
        waitMs: 5_000,
        pollMs: 20,
        onWait: (owner) => waits.push(owner?.tool)
      })
      expect(waits).toEqual(['holder'])
      lock.release()
    })

    it('throws LockBusyError when the wait runs out', async () => {
      const f = await fake()
      const holder = acquirePatchLock(f.asarPath, { tool: 'holder' })
      await expect(
        acquirePatchLockWait(f.asarPath, { tool: 'waiter', waitMs: 60, pollMs: 20 })
      ).rejects.toBeInstanceOf(LockBusyError)
      holder.release()
    })

    it('does not keep waiting on permission errors', async () => {
      const f = await fake()
      vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
        throw errno('EROFS')
      })
      await expect(
        acquirePatchLockWait(f.asarPath, { tool: 'waiter', waitMs: 60_000 })
      ).rejects.toMatchObject({ code: 'EROFS' })
    })
  })
})

describe('backup: ensureBackup', () => {
  it('creates a pristine backup with a checksum sidecar and no leftovers', async () => {
    const f = await fake()
    const { logger, text } = memoryLogger()
    const result = await ensureBackup(logger, f.asarPath, inspectAsar(f.asarPath))
    expect(result.action).toBe('created')
    const { backup, meta } = backupPaths(f.asarPath)
    expect(await sha256File(backup)).toBe(await sha256File(f.asarPath))
    expect(readBackupMeta(f.asarPath)).toMatchObject({
      sha256: await sha256File(f.asarPath),
      orcaVersion: '1.4.214'
    })
    expect(nodeFs.readdirSync(path.dirname(f.asarPath)).sort()).toEqual([
      'app.asar',
      'app.asar.mlp-backup',
      'app.asar.mlp-backup.json',
      'app.asar.unpacked'
    ])
    expect(text()).toMatch(/Backup: .*mlp-backup \(sha256 [0-9a-f]{12}…\)/)
    expect(meta).toMatch(/mlp-backup\.json$/)
  })

  it('keeps an identical backup, refreshes a stale one after an Orca update', async () => {
    const f = await fake()
    const { logger, text } = memoryLogger()
    await ensureBackup(logger, f.asarPath, inspectAsar(f.asarPath))
    expect((await ensureBackup(logger, f.asarPath, inspectAsar(f.asarPath))).action).toBe('kept')

    await packFakeOrca(f.root, f.appDir, { version: '1.4.215' })
    const refreshed = await ensureBackup(logger, f.asarPath, inspectAsar(f.asarPath))
    expect(refreshed.action).toBe('refreshed')
    expect(refreshed.meta?.orcaVersion).toBe('1.4.215')
    expect(await sha256File(backupPaths(f.asarPath).backup)).toBe(await sha256File(f.asarPath))
    expect(text()).toMatch(/1\.4\.214 → 1\.4\.215/)
  })

  it('never overwrites the pristine backup with a patched archive', async () => {
    const f = await fake()
    const { logger } = memoryLogger()
    await ensureBackup(logger, f.asarPath, inspectAsar(f.asarPath))
    const pristine = await sha256File(backupPaths(f.asarPath).backup)
    const built = await buildPatchedArchive({
      asarPath: f.asarPath,
      workDir: tmpDir(),
      injector: loadInjector(f.injectorPath),
      patcherVersion: '0',
      patchedBy: 'test'
    })
    replaceAsar(built.asar, f.asarPath)
    const kept = await ensureBackup(logger, f.asarPath, inspectAsar(f.asarPath))
    expect(kept.action).toBe('kept')
    expect(await sha256File(backupPaths(f.asarPath).backup)).toBe(pristine)
  })

  it('cannot back up an already patched archive without a backup', async () => {
    const f = await fake()
    const built = await buildPatchedArchive({
      asarPath: f.asarPath,
      workDir: tmpDir(),
      injector: loadInjector(f.injectorPath),
      patcherVersion: '0',
      patchedBy: 'test'
    })
    replaceAsar(built.asar, f.asarPath)
    const { logger, text } = memoryLogger()
    const result = await ensureBackup(logger, f.asarPath, inspectAsar(f.asarPath))
    expect(result).toEqual({ action: 'none', meta: null })
    expect(nodeFs.existsSync(backupPaths(f.asarPath).backup)).toBe(false)
    expect(text()).toMatch(/already patched but no backup exists/)
  })

  it('a backup file without its sidecar is not trusted: it is recreated', async () => {
    const f = await fake()
    const { logger } = memoryLogger()
    nodeFs.writeFileSync(backupPaths(f.asarPath).backup, 'garbage from an interrupted backup')
    const result = await ensureBackup(logger, f.asarPath, inspectAsar(f.asarPath))
    expect(result.action).toBe('created')
    expect(await sha256File(backupPaths(f.asarPath).backup)).toBe(await sha256File(f.asarPath))
  })

  it('a failing copy leaves neither a sidecar nor a temp file nor a backup', async () => {
    const f = await fake()
    const { logger } = memoryLogger()
    vi.spyOn(fs, 'copyFileSync').mockImplementation(() => {
      throw errno('ENOSPC')
    })
    await expect(ensureBackup(logger, f.asarPath, inspectAsar(f.asarPath))).rejects.toMatchObject({
      code: 'ENOSPC'
    })
    vi.restoreAllMocks()
    expect(nodeFs.readdirSync(path.dirname(f.asarPath)).sort()).toEqual([
      'app.asar',
      'app.asar.unpacked'
    ])
  })

  it('removeBackup deletes both files and tolerates missing ones', async () => {
    const f = await fake()
    const { logger } = memoryLogger()
    await ensureBackup(logger, f.asarPath, inspectAsar(f.asarPath))
    removeBackup(f.asarPath)
    removeBackup(f.asarPath)
    expect(readBackupMeta(f.asarPath)).toBeNull()
    expect(nodeFs.existsSync(backupPaths(f.asarPath).backup)).toBe(false)
  })
})
