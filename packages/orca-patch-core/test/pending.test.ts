import { spawn, type ChildProcess } from 'node:child_process'
import nodeFs from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  acquirePatchLock,
  applyPending,
  backupPaths,
  buildPatchedArchive,
  ensureBackup,
  fs,
  inspectAsar,
  isProcessAlive,
  liveHelperPid,
  loadInjector,
  lockPath,
  pendingPaths,
  type PendingMeta,
  readPending,
  removePending,
  sha256File,
  silentLogger,
  writePending
} from '../src/index'
import { type FakeOrca, makeFakeOrca } from '../../orca-patcher/test/fake-orca'
import { errno, memoryLogger, tmpDir } from './helpers'

const fakes: FakeOrca[] = []
const children: ChildProcess[] = []
afterEach(() => {
  for (const c of children.splice(0)) c.kill('SIGKILL')
  for (const f of fakes.splice(0)) nodeFs.rmSync(f.root, { recursive: true, force: true })
})

/** A fake Orca plus a patched archive parked as pending, built from the current app.asar. */
async function withPending(
  overrides: Partial<PendingMeta> = {}
): Promise<{ f: FakeOrca; meta: PendingMeta; baseSha: string }> {
  const f = await makeFakeOrca()
  fakes.push(f)
  const built = await buildPatchedArchive({
    asarPath: f.asarPath,
    workDir: tmpDir(),
    injector: loadInjector(f.injectorPath),
    patcherVersion: '0.1.0',
    patchedBy: 'test'
  })
  const baseSha = await sha256File(f.asarPath)
  const meta: PendingMeta = {
    baseSha256: baseSha,
    orcaVersion: '1.4.214',
    injectorVersion: '9.9.9',
    waitPid: 999_999_999,
    createdAt: new Date().toISOString(),
    ...overrides
  }
  writePending(f.asarPath, built.asar, meta)
  return { f, meta, baseSha }
}

function liveChild(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  children.push(child)
  return child
}

const noSleep = async (): Promise<void> => {}

describe('process liveness', () => {
  it('rejects invalid pids, sees itself, and maps EPERM/ESRCH like the OS does', () => {
    for (const pid of [0, -1, 1.5, Number.NaN]) expect(isProcessAlive(pid)).toBe(false)
    expect(isProcessAlive(process.pid)).toBe(true)
    const kill = vi.spyOn(process, 'kill')
    kill.mockImplementationOnce(() => {
      throw errno('EPERM')
    })
    expect(isProcessAlive(4242)).toBe(true) // exists, owned by someone else
    kill.mockImplementationOnce(() => {
      throw errno('ESRCH')
    })
    expect(isProcessAlive(4242)).toBe(false)
  })
})

describe('pending files', () => {
  it('readPending needs the archive and a readable sidecar', async () => {
    const { f, meta } = await withPending()
    expect(readPending(f.asarPath)).toEqual(meta)
    nodeFs.writeFileSync(pendingPaths(f.asarPath).meta, '{ truncated')
    expect(readPending(f.asarPath)).toBeNull()
    nodeFs.rmSync(pendingPaths(f.asarPath).archive)
    expect(readPending(f.asarPath)).toBeNull()
  })

  it('writePending leaves no temp files; removePending removes archive, temp and sidecar', async () => {
    const { f } = await withPending()
    const paths = pendingPaths(f.asarPath)
    expect(nodeFs.readdirSync(nodeFs.realpathSync(f.appDir + '/resources')).sort()).toEqual([
      'app.asar',
      'app.asar.mlp-pending',
      'app.asar.mlp-pending.json',
      'app.asar.unpacked'
    ])
    nodeFs.writeFileSync(`${paths.archive}.mlp-tmp`, 'half')
    removePending(f.asarPath)
    removePending(f.asarPath)
    expect(nodeFs.readdirSync(f.appDir + '/resources').sort()).toEqual([
      'app.asar',
      'app.asar.unpacked'
    ])
  })

  it('an interrupted writePending keeps the previous pending archive', async () => {
    const { f } = await withPending()
    const before = await sha256File(pendingPaths(f.asarPath).archive)
    vi.spyOn(fs, 'copyFileSync').mockImplementation(() => {
      throw errno('ENOSPC')
    })
    expect(() =>
      writePending(f.asarPath, f.asarPath, {
        baseSha256: 'x',
        orcaVersion: null,
        injectorVersion: '1',
        waitPid: 999_999_999,
        createdAt: ''
      })
    ).toThrow(expect.objectContaining({ code: 'ENOSPC' }))
    vi.restoreAllMocks()
    expect(await sha256File(pendingPaths(f.asarPath).archive)).toBe(before)
    expect(nodeFs.existsSync(`${pendingPaths(f.asarPath).archive}.mlp-tmp`)).toBe(false)
  })
})

describe('helper single-instance lock', () => {
  it('liveHelperPid only reports a live helper other than ourselves', async () => {
    const { f } = await withPending()
    const { helperLock } = pendingPaths(f.asarPath)
    expect(liveHelperPid(f.asarPath)).toBeNull() // no lock
    nodeFs.writeFileSync(helperLock, 'garbage')
    expect(liveHelperPid(f.asarPath)).toBeNull()
    nodeFs.writeFileSync(helperLock, JSON.stringify({ pid: process.pid }))
    expect(liveHelperPid(f.asarPath)).toBeNull() // that is us
    nodeFs.writeFileSync(helperLock, JSON.stringify({ pid: 999_999_999 }))
    expect(liveHelperPid(f.asarPath)).toBeNull() // dead
    const child = liveChild()
    nodeFs.writeFileSync(helperLock, JSON.stringify({ pid: child.pid }))
    expect(liveHelperPid(f.asarPath)).toBe(child.pid)
  })

  it('exits as busy while another helper is alive, and leaves its lock alone', async () => {
    const { f } = await withPending()
    const child = liveChild()
    const { helperLock } = pendingPaths(f.asarPath)
    nodeFs.writeFileSync(helperLock, JSON.stringify({ pid: child.pid }))
    const { logger, text } = memoryLogger()
    const result = await applyPending({
      asarPath: f.asarPath,
      waitPid: 999_999_999,
      logger,
      sleep: noSleep
    })
    expect(result).toBe('busy')
    expect(JSON.parse(nodeFs.readFileSync(helperLock, 'utf8'))).toEqual({ pid: child.pid })
    expect(text()).toMatch(/already waiting/)
    expect(inspectAsar(f.asarPath).injectedBlocks).toBe(0)
  })

  it('takes over the lock of a helper that died', async () => {
    const { f } = await withPending()
    nodeFs.writeFileSync(pendingPaths(f.asarPath).helperLock, JSON.stringify({ pid: 999_999_999 }))
    const result = await applyPending({
      asarPath: f.asarPath,
      waitPid: 999_999_999,
      logger: silentLogger,
      sleep: noSleep
    })
    expect(result).toBe('applied')
    expect(nodeFs.existsSync(pendingPaths(f.asarPath).helperLock)).toBe(false)
  })

  it('does not swallow permission errors creating the lock', async () => {
    const { f } = await withPending()
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw errno('EACCES')
    })
    await expect(
      applyPending({
        asarPath: f.asarPath,
        waitPid: 999_999_999,
        logger: silentLogger,
        sleep: noSleep
      })
    ).rejects.toMatchObject({ code: 'EACCES' })
  })
})

describe('applyPending', () => {
  it('reports missing when there is no pending archive (and releases its lock)', async () => {
    const f = await makeFakeOrca()
    fakes.push(f)
    const { logger, text } = memoryLogger()
    expect(
      await applyPending({ asarPath: f.asarPath, waitPid: 999_999_999, logger, sleep: noSleep })
    ).toBe('missing')
    expect(text()).toMatch(/no pending archive/)
    expect(nodeFs.existsSync(pendingPaths(f.asarPath).helperLock)).toBe(false)
  })

  it('keeps polling while the parent runs and swaps as soon as it exits', async () => {
    const { f } = await withPending({ waitPid: 4242 })
    const alive = [true, true, true, false]
    const sleeps: number[] = []
    const result = await applyPending({
      asarPath: f.asarPath,
      waitPid: 4242,
      logger: silentLogger,
      pollMs: 25,
      isAlive: () => alive.shift() ?? false,
      sleep: async (ms) => void sleeps.push(ms)
    })
    expect(result).toBe('applied')
    // three polls while alive, then the short grace period for released file handles
    expect(sleeps).toEqual([25, 25, 25, 25])
    expect(inspectAsar(f.asarPath).injectedBlocks).toBe(1)
    expect(readPending(f.asarPath)).toBeNull()
  })

  it('times out without touching anything while the parent keeps running', async () => {
    const { f } = await withPending()
    const { logger, text } = memoryLogger()
    const result = await applyPending({
      asarPath: f.asarPath,
      waitPid: process.pid,
      logger,
      pollMs: 5,
      timeoutMs: 20
    })
    expect(result).toBe('timeout')
    expect(text()).toMatch(/timed out waiting for Orca/)
    expect(inspectAsar(f.asarPath).injectedBlocks).toBe(0)
    expect(nodeFs.existsSync(pendingPaths(f.asarPath).archive)).toBe(true)
    expect(nodeFs.existsSync(lockPath(f.asarPath))).toBe(false)
  })

  it('discards a pending archive when app.asar changed since it was built', async () => {
    const { f } = await withPending({ baseSha256: 'old' })
    const { logger, text } = memoryLogger()
    expect(
      await applyPending({ asarPath: f.asarPath, waitPid: 999_999_999, logger, sleep: noSleep })
    ).toBe('stale')
    expect(text()).toMatch(/changed since the pending archive was built/)
    expect(nodeFs.existsSync(pendingPaths(f.asarPath).archive)).toBe(false)
    expect(inspectAsar(f.asarPath).injectedBlocks).toBe(0)
  })

  it('notices a pending archive that vanished while it waited', async () => {
    const { f } = await withPending()
    const { logger, text } = memoryLogger()
    const result = await applyPending({
      asarPath: f.asarPath,
      waitPid: 4242,
      logger,
      isAlive: () => {
        removePending(f.asarPath)
        return false
      },
      sleep: noSleep
    })
    expect(result).toBe('missing')
    expect(text()).toMatch(/disappeared/)
  })

  it('rejects a pending archive that is not patched or has the wrong injector version', async () => {
    const f = await makeFakeOrca()
    fakes.push(f)
    // pending = a copy of the unpatched archive
    nodeFs.copyFileSync(f.asarPath, `${f.asarPath}.copy`)
    writePending(f.asarPath, `${f.asarPath}.copy`, {
      baseSha256: await sha256File(f.asarPath),
      orcaVersion: '1.4.214',
      injectorVersion: '9.9.9',
      waitPid: 999_999_999,
      createdAt: ''
    })
    const { logger, text } = memoryLogger()
    expect(
      await applyPending({ asarPath: f.asarPath, waitPid: 999_999_999, logger, sleep: noSleep })
    ).toBe('failed')
    expect(text()).toMatch(/failed validation/)
    expect(nodeFs.existsSync(pendingPaths(f.asarPath).archive)).toBe(false)

    const { f: g } = await withPending({ injectorVersion: '1.0.0' })
    expect(
      await applyPending({
        asarPath: g.asarPath,
        waitPid: 999_999_999,
        logger: silentLogger,
        sleep: noSleep
      })
    ).toBe('failed')
    expect(inspectAsar(g.asarPath).injectedBlocks).toBe(0)
  })

  it('a damaged (truncated) pending archive fails without touching app.asar', async () => {
    const { f, baseSha } = await withPending()
    const archive = pendingPaths(f.asarPath).archive
    nodeFs.truncateSync(archive, 40)
    const { logger, text } = memoryLogger()
    const result = await applyPending({
      asarPath: f.asarPath,
      waitPid: 999_999_999,
      logger,
      sleep: noSleep
    })
    expect(result).toBe('failed')
    expect(text()).toMatch(/error: /)
    expect(await sha256File(f.asarPath)).toBe(baseSha)
    expect(nodeFs.existsSync(pendingPaths(f.asarPath).helperLock)).toBe(false)
    expect(nodeFs.existsSync(lockPath(f.asarPath))).toBe(false)
  })

  it('fails when another process holds the patch lock for too long', async () => {
    const { f } = await withPending()
    const holder = acquirePatchLock(f.asarPath, { tool: 'monaco-lsp-orca' })
    try {
      const { logger, text } = memoryLogger()
      const result = await applyPending({
        asarPath: f.asarPath,
        waitPid: 999_999_999,
        logger,
        sleep: noSleep,
        lockWaitMs: 30
      })
      expect(result).toBe('failed')
      expect(text()).toMatch(/Another process is patching Orca/)
      // the holder's lock is untouched, the pending archive survives for a later helper
      expect(nodeFs.existsSync(lockPath(f.asarPath))).toBe(true)
      expect(nodeFs.existsSync(pendingPaths(f.asarPath).archive)).toBe(true)
    } finally {
      holder.release()
    }
  })

  describe('the final rename', () => {
    function failRenameOnto(asarPath: string, failures: string[]): { calls: () => number } {
      const real = fs.renameSync
      let calls = 0
      vi.spyOn(fs, 'renameSync').mockImplementation(((from: string, to: string) => {
        if (to === asarPath) {
          calls++
          const code = failures.shift()
          if (code) throw errno(code)
        }
        return real(from, to)
      }) as never)
      return { calls: () => calls }
    }

    it('retries while the file is still locked (EBUSY/EPERM/EACCES), then swaps', async () => {
      const { f } = await withPending()
      const rename = failRenameOnto(f.asarPath, ['EBUSY', 'EPERM', 'EACCES'])
      const sleeps: number[] = []
      const result = await applyPending({
        asarPath: f.asarPath,
        waitPid: 999_999_999,
        logger: silentLogger,
        sleep: async (ms) => void sleeps.push(ms)
      })
      expect(result).toBe('applied')
      expect(rename.calls()).toBe(4)
      expect(sleeps.filter((ms) => ms === 2_000)).toHaveLength(3)
      expect(inspectAsar(f.asarPath).injectedBlocks).toBe(1)
    })

    it('gives up after swapRetryMs and keeps the pending archive for a later helper', async () => {
      const { f, baseSha } = await withPending()
      failRenameOnto(f.asarPath, Array(50).fill('EBUSY'))
      const { logger, text } = memoryLogger()
      const result = await applyPending({
        asarPath: f.asarPath,
        waitPid: 999_999_999,
        logger,
        swapRetryMs: 0,
        sleep: noSleep
      })
      expect(result).toBe('failed')
      expect(text()).toMatch(/could not swap the pending archive in: .*EBUSY/)
      expect(await sha256File(f.asarPath)).toBe(baseSha)
      expect(nodeFs.existsSync(pendingPaths(f.asarPath).archive)).toBe(true)
    })

    it('does not retry other errors', async () => {
      const { f } = await withPending()
      const rename = failRenameOnto(f.asarPath, ['EROFS'])
      expect(
        await applyPending({
          asarPath: f.asarPath,
          waitPid: 999_999_999,
          logger: silentLogger,
          sleep: noSleep
        })
      ).toBe('failed')
      expect(rename.calls()).toBe(1)
    })
  })

  describe('verification after the swap', () => {
    /** Make the swap install an unpatched archive, as if the file had been replaced meanwhile. */
    function swapInUnpatched(f: FakeOrca): void {
      const unpatched = `${f.asarPath}.unpatched-copy`
      nodeFs.copyFileSync(f.asarPath, unpatched)
      const real = fs.renameSync
      vi.spyOn(fs, 'renameSync').mockImplementation(((from: string, to: string) => {
        if (to === f.asarPath && from === pendingPaths(f.asarPath).archive) {
          return real(unpatched, to)
        }
        return real(from, to)
      }) as never)
    }

    it('restores the pristine backup when the swapped archive does not verify', async () => {
      const { f } = await withPending()
      await ensureBackup(silentLogger, f.asarPath, inspectAsar(f.asarPath))
      const pristine = await sha256File(backupPaths(f.asarPath).backup)
      swapInUnpatched(f)
      const { logger, text } = memoryLogger()
      const result = await applyPending({
        asarPath: f.asarPath,
        waitPid: 999_999_999,
        logger,
        sleep: noSleep
      })
      expect(result).toBe('failed')
      expect(text()).toMatch(/verification after the swap failed/)
      expect(text()).toMatch(/restored the pristine app\.asar/)
      expect(await sha256File(f.asarPath)).toBe(pristine)
      expect(nodeFs.existsSync(pendingPaths(f.asarPath).meta)).toBe(false)
      expect(nodeFs.existsSync(`${f.asarPath}.mlp-tmp`)).toBe(false)
    })

    it('without a trustworthy backup it only reports the failure', async () => {
      const { f } = await withPending()
      swapInUnpatched(f)
      const { logger, text } = memoryLogger()
      expect(
        await applyPending({ asarPath: f.asarPath, waitPid: 999_999_999, logger, sleep: noSleep })
      ).toBe('failed')
      expect(text()).not.toMatch(/restored the pristine/)
      // a backup file whose sidecar is missing is not trusted either
      vi.restoreAllMocks()
      const { f: g } = await withPending()
      nodeFs.writeFileSync(backupPaths(g.asarPath).backup, 'unverified')
      swapInUnpatched(g)
      const second = memoryLogger()
      expect(
        await applyPending({
          asarPath: g.asarPath,
          waitPid: 999_999_999,
          logger: second.logger,
          sleep: noSleep
        })
      ).toBe('failed')
      expect(second.text()).not.toMatch(/restored the pristine/)
    })

    it('logs when restoring the backup fails too', async () => {
      const { f } = await withPending()
      await ensureBackup(silentLogger, f.asarPath, inspectAsar(f.asarPath))
      swapInUnpatched(f)
      vi.spyOn(fs, 'copyFileSync').mockImplementation(() => {
        throw errno('ENOSPC')
      })
      const { logger, text } = memoryLogger()
      expect(
        await applyPending({ asarPath: f.asarPath, waitPid: 999_999_999, logger, sleep: noSleep })
      ).toBe('failed')
      expect(text()).toMatch(/could not restore the backup: .*ENOSPC/)
    })
  })

  it('turns unexpected errors into a failed result and releases both locks', async () => {
    const { f } = await withPending()
    const real = fs.writeFileSync
    vi.spyOn(fs, 'writeFileSync').mockImplementation(((file: string, ...rest: unknown[]) => {
      if (String(file).includes('.mlp-pending.json')) throw errno('EACCES')
      return (real as (...a: unknown[]) => void)(file, ...rest)
    }) as never)
    const { logger, text } = memoryLogger()
    expect(
      await applyPending({ asarPath: f.asarPath, waitPid: 999_999_999, logger, sleep: noSleep })
    ).toBe('failed')
    expect(text()).toMatch(/apply-pending failed: .*EACCES/)
    expect(nodeFs.existsSync(pendingPaths(f.asarPath).helperLock)).toBe(false)
    expect(nodeFs.existsSync(lockPath(f.asarPath))).toBe(false)
  })
})
