import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  acquirePatchLock,
  applyPending,
  buildPatchedArchive,
  compareVersions,
  configPath,
  DEFAULT_CONFIG,
  findAnchorFilesInArchive,
  inspectAsar,
  isProcessAlive,
  loadInjector,
  LOCK_STALE_MS,
  LockBusyError,
  lockPath,
  makeTempDir,
  pendingPaths,
  readAppPackage,
  readPending,
  readUserConfig,
  removeDir,
  sha256File,
  silentLogger,
  writePending,
  writeUserConfig
} from '../src/index'
import { type FakeOrca, makeFakeOrca } from '../../orca-patcher/test/fake-orca'

const cleanup: string[] = []
afterEach(() => {
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})
async function fake(opts?: Parameters<typeof makeFakeOrca>[0]): Promise<FakeOrca> {
  const f = await makeFakeOrca(opts)
  cleanup.push(f.root)
  return f
}
const tmp = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mlp-core-'))
  cleanup.push(dir)
  return dir
}

describe('patch lock', () => {
  it('is exclusive, released only by its owner, and taken over when stale', async () => {
    const f = await fake()
    const first = acquirePatchLock(f.asarPath, { tool: 'monaco-lsp-orca' })
    expect(fs.existsSync(lockPath(f.asarPath))).toBe(true)
    let busy: unknown
    try {
      acquirePatchLock(f.asarPath, { tool: 'cpoepke.monaco-lsp' })
    } catch (error) {
      busy = error
    }
    expect(busy).toBeInstanceOf(LockBusyError)
    expect((busy as LockBusyError).owner).toMatchObject({
      tool: 'monaco-lsp-orca',
      pid: process.pid
    })
    expect((busy as LockBusyError).message).toMatch(/monaco-lsp-orca, pid \d+/)
    first.release()
    expect(fs.existsSync(lockPath(f.asarPath))).toBe(false)

    // A crashed owner's lock (mtime older than 2 min) is taken over.
    const crashed = acquirePatchLock(f.asarPath, { tool: 'cpoepke.monaco-lsp' })
    const old = new Date(Date.now() - LOCK_STALE_MS - 1_000)
    fs.utimesSync(lockPath(f.asarPath), old, old)
    const second = acquirePatchLock(f.asarPath, { tool: 'monaco-lsp-orca' })
    crashed.release() // not ours any more: must not delete the new owner's lock
    expect(fs.existsSync(lockPath(f.asarPath))).toBe(true)
    second.release()
    expect(fs.existsSync(lockPath(f.asarPath))).toBe(false)
  })
})

describe('user config', () => {
  it('defaults when missing or invalid, merges writes, keeps unknown keys', () => {
    const dir = tmp()
    // No file (CLI never ran) → auto-repair stays off; the plugin must not patch on its own.
    expect(readUserConfig(dir)).toEqual({ ...DEFAULT_CONFIG, autoRepair: false, exists: false })
    fs.writeFileSync(configPath(dir), '{ not json')
    expect(readUserConfig(dir)).toEqual({ autoRepair: false, resign: true, exists: false })
    fs.writeFileSync(configPath(dir), JSON.stringify({ resign: 'no', note: 'mine' }))
    expect(readUserConfig(dir)).toEqual({ autoRepair: true, resign: true, exists: true })
    expect(writeUserConfig(dir, { resign: false })).toEqual({ autoRepair: true, resign: false })
    expect(writeUserConfig(dir, { autoRepair: false })).toEqual({
      autoRepair: false,
      resign: false
    })
    expect(JSON.parse(fs.readFileSync(configPath(dir), 'utf8'))).toEqual({
      note: 'mine',
      autoRepair: false,
      resign: false
    })
  })
})

describe('archive helpers', () => {
  it('reads the package name and finds the anchor without extracting', async () => {
    const f = await fake()
    expect(readAppPackage(f.asarPath)).toEqual({ name: 'orca', version: '1.4.214' })
    expect(findAnchorFilesInArchive(f.asarPath)).toEqual([
      'out/renderer/assets/MonacoEditor-def.js'
    ])
    const other = await fake({ name: 'electron-default-app', anchor: false })
    expect(readAppPackage(other.asarPath).name).toBe('electron-default-app')
    expect(findAnchorFilesInArchive(other.asarPath)).toEqual([])
  })

  it('compares versions numerically', () => {
    expect(compareVersions('0.10.0', '0.9.1')).toBeGreaterThan(0)
    expect(compareVersions('0.1.0', '0.1.0-beta')).toBe(0)
    expect(compareVersions('1.2', '1.2.1')).toBeLessThan(0)
  })
})

describe('pending swap (Windows: app.asar locked while Orca runs)', () => {
  it('waits for the Orca main process to exit, then swaps the patched archive in', async () => {
    const f = await fake()
    const workDir = makeTempDir('mlp-core-test-')
    cleanup.push(workDir)
    const built = await buildPatchedArchive({
      asarPath: f.asarPath,
      workDir,
      injector: loadInjector(f.injectorPath),
      patcherVersion: '0.1.0',
      patchedBy: 'test'
    })
    // A child process stands in for Orca's main process.
    const orca = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    try {
      expect(isProcessAlive(orca.pid!)).toBe(true)
      writePending(f.asarPath, built.asar, {
        baseSha256: await sha256File(f.asarPath),
        orcaVersion: '1.4.214',
        injectorVersion: '9.9.9',
        waitPid: orca.pid!,
        createdAt: new Date().toISOString()
      })
      removeDir(workDir)
      expect(inspectAsar(f.asarPath).injectedBlocks).toBe(0)

      const logs: string[] = []
      const logger = {
        info: (m: string) => logs.push(m),
        warn: (m: string) => logs.push(m),
        error: (m: string) => logs.push(m)
      }
      const result = applyPending({ asarPath: f.asarPath, waitPid: orca.pid!, logger, pollMs: 50 })
      await new Promise((resolve) => setTimeout(resolve, 300))
      // Still waiting: nothing is swapped while "Orca" runs.
      expect(inspectAsar(f.asarPath).injectedBlocks).toBe(0)
      expect(readPending(f.asarPath)?.helperPid).toBe(process.pid)
      orca.kill('SIGKILL')
      expect(await result).toBe('applied')
      expect(inspectAsar(f.asarPath)).toMatchObject({
        injectedBlocks: 1,
        versionInfo: { injectorVersion: '9.9.9', patchedBy: 'test' }
      })
      const paths = pendingPaths(f.asarPath)
      for (const leftover of [paths.archive, paths.meta, paths.helperLock, lockPath(f.asarPath)]) {
        expect(fs.existsSync(leftover), leftover).toBe(false)
      }
      expect(logs.join('\n')).toMatch(/waiting for Orca[\s\S]*Orca exited[\s\S]*applied/)
    } finally {
      orca.kill('SIGKILL')
    }
  })

  it('drops a pending archive built from an app.asar that changed since, and times out', async () => {
    const f = await fake()
    fs.copyFileSync(f.asarPath, `${f.asarPath}.copy`)
    writePending(f.asarPath, `${f.asarPath}.copy`, {
      baseSha256: 'not-the-current-sha',
      orcaVersion: '1.4.214',
      injectorVersion: '9.9.9',
      waitPid: 999_999_999,
      createdAt: new Date().toISOString()
    })
    const stale = await applyPending({
      asarPath: f.asarPath,
      waitPid: 999_999_999,
      logger: silentLogger,
      pollMs: 10
    })
    expect(stale).toBe('stale')
    expect(fs.existsSync(pendingPaths(f.asarPath).archive)).toBe(false)

    writePending(f.asarPath, `${f.asarPath}.copy`, {
      baseSha256: await sha256File(f.asarPath),
      orcaVersion: '1.4.214',
      injectorVersion: '9.9.9',
      waitPid: process.pid,
      createdAt: new Date().toISOString()
    })
    const timedOut = await applyPending({
      asarPath: f.asarPath,
      waitPid: process.pid,
      logger: silentLogger,
      pollMs: 10,
      timeoutMs: 50
    })
    expect(timedOut).toBe('timeout')
    expect(fs.existsSync(pendingPaths(f.asarPath).archive)).toBe(true)
    expect(fs.existsSync(pendingPaths(f.asarPath).helperLock)).toBe(false)
  })
})
