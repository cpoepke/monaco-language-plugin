import fs from 'node:fs'
import path from 'node:path'
import { createPackageWithOptions } from '@electron/asar'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  acquirePatchLock,
  backupPaths,
  type CommandResult,
  ExitCode,
  fs as coreFs,
  injectScriptBlock,
  inspectAsar,
  LOCK_STALE_MS,
  LockBusyError,
  lockPath,
  PatcherError,
  pendingPaths,
  readBackupMeta,
  readUserConfig,
  sha256File,
  writePending,
  writeUserConfig
} from '@mlp/orca-patch-core'
import { install } from '../src/install'
import { uninstall } from '../src/uninstall'
import { formatStatus, status } from '../src/status'
import { readState } from '../src/state'
import { createContext } from '../src/context'
import { type FakeOrca, makeFakeOrca, ORIGINAL_INDEX_HTML } from './fake-orca'

const fakes: FakeOrca[] = []
async function fake(opts?: Parameters<typeof makeFakeOrca>[0]): Promise<FakeOrca> {
  const f = await makeFakeOrca(opts)
  fakes.push(f)
  return f
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const f of fakes.splice(0)) fs.rmSync(f.root, { recursive: true, force: true })
})

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: simulated`), { code })
}

function logTo(lines: string[]) {
  return {
    info: (m: string) => void lines.push(m),
    warn: (m: string) => void lines.push(`warning: ${m}`),
    error: (m: string) => void lines.push(`error: ${m}`)
  }
}

/** Make `rename*Sync` fail with `code` whenever it targets `dest`. */
function failRenameOnto(dest: string, code: string): void {
  const real = coreFs.renameSync
  vi.spyOn(coreFs, 'renameSync').mockImplementation(((from: string, to: string) => {
    if (to === dest) throw errno(code)
    return real(from, to)
  }) as never)
}

const siblings = (f: FakeOrca): string[] => fs.readdirSync(path.dirname(f.asarPath)).sort()
const PRISTINE_SIBLINGS = ['app.asar', 'app.asar.unpacked']

/** A macOS-style bundle around the fake Orca, plus a recording codesign/plutil/ps runner. */
function macBundle(f: FakeOrca): string {
  const bundle = path.join(f.root, 'Orca.app')
  fs.mkdirSync(path.join(bundle, 'Contents'), { recursive: true })
  fs.cpSync(path.join(f.appDir, 'resources'), path.join(bundle, 'Contents', 'Resources'), {
    recursive: true
  })
  return bundle
}
type Call = string[]
function macRunner(reply: (call: Call) => Partial<CommandResult> | undefined = () => undefined): {
  calls: Call[]
  runCommand: (c: string, a: string[]) => Promise<CommandResult>
} {
  const calls: Call[] = []
  return {
    calls,
    runCommand: async (command, args) => {
      const call = [command, ...args]
      calls.push(call)
      const custom = reply(call)
      if (custom) return { code: 0, stdout: '', stderr: '', ...custom }
      // plutil -extract: key absent; everything else succeeds
      return {
        code: command === 'plutil' && args[0] === '-extract' ? 1 : 0,
        stdout: '',
        stderr: ''
      }
    }
  }
}

describe('install: permission failures', () => {
  it.each([
    ['linux', /is not writable\. Re-run with sudo \(system-wide deb\/rpm install\)\./],
    ['win32', /is not writable\. Re-run from an elevated terminal/],
    ['freebsd', /is not writable\. Check the file permissions\./]
  ] as const)('refuses an unwritable install on %s with a targeted hint', async (platform, re) => {
    const f = await fake()
    vi.spyOn(coreFs, 'accessSync').mockImplementation(() => {
      throw errno('EACCES')
    })
    const before = await sha256File(f.asarPath)
    await expect(install({ ...f.options, platform })).rejects.toThrow(re)
    vi.restoreAllMocks()
    expect(await sha256File(f.asarPath)).toBe(before)
    expect(siblings(f)).toEqual(PRISTINE_SIBLINGS)
    expect(fs.existsSync(f.stateDir)).toBe(false)
  })

  it('suggests an admin account for a macOS bundle', async () => {
    const f = await fake()
    const bundle = macBundle(f)
    vi.spyOn(coreFs, 'accessSync').mockImplementation(() => {
      throw errno('EACCES')
    })
    await expect(
      install({ ...f.options, app: bundle, platform: 'darwin', runCommand: macRunner().runCommand })
    ).rejects.toThrow(/\(admin account\), or use sudo/)
  })

  it('a dry run only warns about an unwritable directory', async () => {
    const f = await fake()
    const lines: string[] = []
    vi.spyOn(coreFs, 'accessSync').mockImplementation(() => {
      throw errno('EROFS')
    })
    const result = await install({ ...f.options, dryRun: true, logger: logTo(lines) })
    expect(result.dryRun).toBe(true)
    expect(lines.join('\n')).toMatch(/warning: .*resources is not writable/)
  })

  it.each(['EACCES', 'EROFS', 'EPERM', 'EBUSY'])(
    'a %s while replacing app.asar leaves it untouched, cleans up and releases the lock',
    async (code) => {
      const f = await fake()
      const before = await sha256File(f.asarPath)
      failRenameOnto(f.asarPath, code)
      await expect(install(f.options)).rejects.toMatchObject({ code })
      vi.restoreAllMocks()
      expect(await sha256File(f.asarPath)).toBe(before)
      // no temp archive, no lock; the pristine backup made before the swap is kept
      expect(siblings(f)).toEqual([
        'app.asar',
        'app.asar.mlp-backup',
        'app.asar.mlp-backup.json',
        'app.asar.unpacked'
      ])
      expect(readBackupMeta(f.asarPath)?.sha256).toBe(before)
      expect(readState(createContext(f.options)).installs).toEqual({})
      // the install can simply be retried
      expect((await install(f.options)).backupAction).toBe('kept')
    }
  )
})

describe('install/uninstall: lock contention', () => {
  it('waits up to lockWaitMs for a running patcher, then reports who holds the lock', async () => {
    const f = await fake()
    const holder = acquirePatchLock(f.asarPath, { tool: 'cpoepke.monaco-lsp' })
    const lines: string[] = []
    try {
      await expect(install({ ...f.options, lockWaitMs: 60, logger: logTo(lines) })).rejects.toThrow(
        LockBusyError
      )
      expect(lines.join('\n')).toMatch(/Waiting for cpoepke\.monaco-lsp \(pid \d+\) to finish/)
      await expect(uninstall({ ...f.options, lockWaitMs: 60, logger: logTo([]) })).rejects.toThrow(
        /Another process is patching Orca right now \(cpoepke\.monaco-lsp/
      )
    } finally {
      holder.release()
    }
    expect(fs.existsSync(lockPath(f.asarPath))).toBe(false)
    expect(siblings(f)).toEqual(PRISTINE_SIBLINGS)
  }, 60_000)

  it('takes over a stale lock left by a crashed patcher and releases its own', async () => {
    const f = await fake()
    acquirePatchLock(f.asarPath, { tool: 'crashed' })
    const old = new Date(Date.now() - LOCK_STALE_MS - 5_000)
    fs.utimesSync(lockPath(f.asarPath), old, old)
    await install(f.options)
    expect(fs.existsSync(lockPath(f.asarPath))).toBe(false)
    expect(inspectAsar(f.asarPath).injectedBlocks).toBe(1)
  })
})

describe('install: other failure modes', () => {
  it('names a missing injector bundle', async () => {
    const f = await fake()
    await expect(
      install({ ...f.options, injectorPath: path.join(f.root, 'missing-injector.js') })
    ).rejects.toThrow(/Injector bundle not found/)
    expect(siblings(f)).toEqual(PRISTINE_SIBLINGS)
  })

  it('refuses an archive without the renderer index.html and writes nothing', async () => {
    const f = await fake()
    const src = path.join(f.root, 'odd-src')
    fs.mkdirSync(src)
    fs.writeFileSync(path.join(src, 'package.json'), '{"name":"orca","version":"2"}')
    await createPackageWithOptions(src, f.asarPath, {})
    fs.rmSync(`${f.asarPath}.unpacked`, { recursive: true, force: true })
    await expect(install(f.options)).rejects.toThrow(/unexpected layout; nothing was changed/)
    expect(fs.existsSync(f.stateDir)).toBe(false)
  })

  it('a damaged app.asar is explained, not crashed on', async () => {
    const f = await fake()
    fs.truncateSync(f.asarPath, 40)
    await expect(install(f.options)).rejects.toThrow(/not a readable asar archive/)
    await expect(uninstall(f.options)).rejects.toThrow(PatcherError)
  })

  // Regression: a truncated app.asar looked "not patched", so uninstall deleted the backup - the
  // only good copy left.
  it('uninstall never deletes the backup because app.asar is damaged', async () => {
    const f = await fake()
    await install(f.options)
    const { backup, meta } = backupPaths(f.asarPath)
    const backupSha = await sha256File(backup)
    fs.truncateSync(f.asarPath, 40)
    await expect(uninstall(f.options)).rejects.toThrow(
      /not a readable asar archive[\s\S]*backup .*mlp-backup was left untouched/
    )
    expect(await sha256File(backup)).toBe(backupSha)
    expect(fs.existsSync(meta)).toBe(true)
    // nothing else was changed either: auto-repair stays as configured, the lock is released
    expect(readUserConfig(f.stateDir).autoRepair).toBe(true)
    expect(fs.existsSync(lockPath(f.asarPath))).toBe(false)
  })

  it('continues with a warning when the process list cannot be read', async () => {
    const f = await fake()
    const lines: string[] = []
    await install({
      ...f.options,
      logger: logTo(lines),
      runCommand: async () => ({ code: 1, stdout: '', stderr: 'ps: not found' })
    })
    expect(lines.join('\n')).toMatch(/warning: Could not read the process list/)
  })

  it('replaces a pending (Windows) archive and updates an already patched install', async () => {
    const f = await fake()
    await install(f.options)
    // an older self-repair parked a pending archive; installing makes it obsolete
    fs.copyFileSync(f.asarPath, `${f.asarPath}.pending-src`)
    writePending(f.asarPath, `${f.asarPath}.pending-src`, {
      baseSha256: 'x',
      orcaVersion: '1.4.214',
      injectorVersion: '9.9.9',
      waitPid: 1,
      createdAt: ''
    })
    fs.rmSync(`${f.asarPath}.pending-src`)
    expect(fs.existsSync(pendingPaths(f.asarPath).archive)).toBe(true)
    const lines: string[] = []
    const again = await install({ ...f.options, logger: logTo(lines) })
    expect(again.backupAction).toBe('kept')
    expect(lines.join('\n')).toMatch(/already patched, updating/)
    expect(fs.existsSync(pendingPaths(f.asarPath).archive)).toBe(false)
    expect(fs.existsSync(pendingPaths(f.asarPath).meta)).toBe(false)
  })

  it('warns when the plugin bundle is missing but still patches', async () => {
    const f = await fake()
    const lines: string[] = []
    const result = await install({
      ...f.options,
      pluginSource: path.join(f.root, 'no-plugin'),
      logger: logTo(lines)
    })
    expect(result.plugin).toMatchObject({ installed: false })
    expect(lines.join('\n')).toMatch(/warning: plugin bundle not found at .*orca-plugin\.json/)
    expect(inspectAsar(f.asarPath).injectedBlocks).toBe(1)
  })

  it('tells AppImage users to start Orca through AppRun', async () => {
    const f = await fake()
    fs.writeFileSync(path.join(f.appDir, 'AppRun'), '#!/bin/sh\n')
    const lines: string[] = []
    const result = await install({ ...f.options, logger: logTo(lines) })
    expect(result.target.kind).toBe('appimage-extracted')
    expect(lines.join('\n')).toContain(`Start Orca with ${path.join(f.appDir, 'AppRun')}`)
  })
})

describe('macOS: signing and Info.plist integrity', () => {
  async function mac(f: FakeOrca, runner = macRunner()) {
    const bundle = macBundle(f)
    return {
      bundle,
      runner,
      options: {
        ...f.options,
        app: bundle,
        platform: 'darwin' as const,
        runCommand: runner.runCommand
      }
    }
  }

  it('a failing codesign aborts with the recovery steps; the patch itself is already on disk', async () => {
    const f = await fake()
    const { options, bundle } = await mac(
      f,
      macRunner((call) =>
        call[0] === 'codesign' ? { code: 1, stderr: 'bundle format unrecognized' } : undefined
      )
    )
    const error = await install(options).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PatcherError)
    expect((error as Error).message).toMatch(
      /^codesign failed \(exit 1\): bundle format unrecognized/
    )
    expect((error as Error).message).toContain(`codesign --force --deep --sign - "${bundle}"`)
    const asar = path.join(bundle, 'Contents', 'Resources', 'app.asar')
    expect(inspectAsar(asar).injectedBlocks).toBe(1)
    // not recorded as a completed install
    expect(readState(createContext(options)).installs).toEqual({})
  })

  it('--fix-integrity removes ElectronAsarIntegrity; without it install only warns', async () => {
    const f = await fake()
    const present = macRunner((call) =>
      call[0] === 'plutil' && call[1] === '-extract' ? { code: 0, stdout: '{}' } : undefined
    )
    const lines: string[] = []
    const { options } = await mac(f, present)
    await install({ ...options, logger: logTo(lines) })
    expect(present.calls.some((c) => c[1] === '-remove')).toBe(false)
    expect(lines.join('\n')).toMatch(/warning: Info\.plist contains ElectronAsarIntegrity/)

    await install({ ...options, fixIntegrity: true, logger: logTo([]) })
    expect(present.calls).toContainEqual([
      'plutil',
      '-remove',
      'ElectronAsarIntegrity',
      expect.stringMatching(/Info\.plist$/)
    ])
  })

  it('a plutil failure while fixing integrity surfaces as an error', async () => {
    const f = await fake()
    const failing = macRunner((call) => {
      if (call[0] !== 'plutil') return undefined
      return call[1] === '-extract' ? { code: 0, stdout: '{}' } : { code: 1, stderr: 'read-only' }
    })
    const { options } = await mac(f, failing)
    await expect(install({ ...options, fixIntegrity: true })).rejects.toThrow(
      /Could not remove ElectronAsarIntegrity.*read-only/
    )
  })

  describe('uninstall', () => {
    it('re-signs ad hoc after restoring when the install re-signed', async () => {
      const f = await fake()
      const { options, runner, bundle } = await mac(f)
      await install(options)
      runner.calls.length = 0
      const lines: string[] = []
      await uninstall({ ...options, logger: logTo(lines) })
      expect(runner.calls).toContainEqual(['codesign', '--force', '--deep', '--sign', '-', bundle])
      expect(lines.join('\n')).toMatch(/still ad-hoc signed/)
    })

    it('--no-resign install: keeps the Developer ID signature when it verifies again', async () => {
      const f = await fake()
      const { options, runner } = await mac(f)
      await install({ ...options, resign: false })
      runner.calls.length = 0
      const lines: string[] = []
      await uninstall({ ...options, logger: logTo(lines) })
      expect(runner.calls.some((c) => c.includes('--sign'))).toBe(false)
      expect(lines.join('\n')).toMatch(/original Developer ID signature verifies again/)
    })

    it('--no-resign install: re-signs only if the original signature no longer verifies', async () => {
      const f = await fake()
      const invalid = macRunner((call) =>
        call[0] === 'codesign' && call[1] === '--verify'
          ? { code: 1, stderr: 'a sealed resource is missing or invalid' }
          : undefined
      )
      const { options, runner } = await mac(f, invalid)
      await install({ ...options, resign: false })
      runner.calls.length = 0
      await uninstall({ ...options, logger: logTo([]) })
      expect(runner.calls.some((c) => c.includes('--sign'))).toBe(true)
    })

    it('a codesign failure while uninstalling is reported (the archive is already restored)', async () => {
      const f = await fake()
      const base = await mac(f)
      const sha = await sha256File(f.asarPath).catch(() => '')
      void sha
      await install(base.options)
      const failing = macRunner((call) =>
        call[0] === 'codesign' ? { code: 1, stderr: 'no identity' } : undefined
      )
      await expect(uninstall({ ...base.options, runCommand: failing.runCommand })).rejects.toThrow(
        /codesign failed \(exit 1\): no identity/
      )
    })
  })
})

describe('uninstall: backup safety', () => {
  it('does not restore a backup from a different Orca version (downgrade protection)', async () => {
    const f = await fake()
    await install(f.options)
    const { backup, meta } = backupPaths(f.asarPath)
    const oldBackup = fs.readFileSync(backup)
    const oldMeta = fs.readFileSync(meta)

    // Orca updates to 1.4.215 and gets patched again; then a stale 1.4.214 backup reappears.
    const { packFakeOrca } = await import('./fake-orca')
    await packFakeOrca(f.root, f.appDir, { version: '1.4.215' })
    await install(f.options)
    fs.writeFileSync(backup, oldBackup)
    fs.writeFileSync(meta, oldMeta)

    const lines: string[] = []
    const result = await uninstall({ ...f.options, logger: logTo(lines) })
    expect(result.action).toBe('stripped')
    expect(lines.join('\n')).toMatch(/Backup is Orca 1\.4\.214 but the installed Orca is 1\.4\.215/)
    expect(inspectAsar(f.asarPath)).toMatchObject({ orcaVersion: '1.4.215', injectedBlocks: 0 })
  })

  it('a backup that no longer matches its sidecar is never restored', async () => {
    const f = await fake()
    await install(f.options)
    const { backup } = backupPaths(f.asarPath)
    fs.writeFileSync(backup, Buffer.alloc(64, 7))
    const lines: string[] = []
    const result = await uninstall({ ...f.options, logger: logTo(lines) })
    expect(result.action).toBe('stripped')
    expect(lines.join('\n')).toMatch(/Backup checksum does not match its sidecar/)
    expect(inspectAsar(f.asarPath).injectedBlocks).toBe(0)
  })

  it('a backup without its sidecar counts as no backup', async () => {
    const f = await fake()
    await install(f.options)
    fs.rmSync(backupPaths(f.asarPath).meta)
    const lines: string[] = []
    expect((await uninstall({ ...f.options, logger: logTo(lines) })).action).toBe('stripped')
    expect(lines.join('\n')).toMatch(/No backup found; removing the injection in place/)
  })

  it('fails loudly if the restored file does not match the backup, and keeps the backup', async () => {
    const f = await fake()
    await install(f.options)
    const real = coreFs.copyFileSync
    vi.spyOn(coreFs, 'copyFileSync').mockImplementation(((from: string, to: string) => {
      real(from, to)
      if (String(to).endsWith('.mlp-tmp')) fs.appendFileSync(to, 'bit rot')
    }) as never)
    await expect(uninstall(f.options)).rejects.toThrow(
      /Restored .*app\.asar does not match the backup checksum\. The backup is kept at/
    )
    expect(fs.existsSync(backupPaths(f.asarPath).backup)).toBe(true)
    expect(fs.existsSync(lockPath(f.asarPath))).toBe(false)
  })

  it.each(['EBUSY', 'EACCES'])(
    'a %s during the restore keeps the patched archive, the backup and a clean directory',
    async (code) => {
      const f = await fake()
      await install(f.options)
      const patchedSha = await sha256File(f.asarPath)
      failRenameOnto(f.asarPath, code)
      await expect(uninstall(f.options)).rejects.toMatchObject({ code })
      vi.restoreAllMocks()
      expect(await sha256File(f.asarPath)).toBe(patchedSha)
      expect(siblings(f)).toEqual([
        'app.asar',
        'app.asar.mlp-backup',
        'app.asar.mlp-backup.json',
        'app.asar.unpacked'
      ])
      // auto-repair was turned off first, so the plugin will not patch Orca again meanwhile
      expect(readUserConfig(f.stateDir).autoRepair).toBe(false)
    }
  )

  it('cleans up a leftover backup of an unpatched Orca', async () => {
    const f = await fake()
    await install(f.options)
    // user restored by hand: archive is pristine again, backup files linger
    fs.copyFileSync(backupPaths(f.asarPath).backup, f.asarPath)
    const lines: string[] = []
    const result = await uninstall({ ...f.options, logger: logTo(lines) })
    expect(result.action).toBe('not-patched')
    expect(lines.join('\n')).toMatch(/Removing leftover backup/)
    expect(fs.existsSync(backupPaths(f.asarPath).backup)).toBe(false)
  })

  it('refuses while Orca runs, and when the install is not writable', async () => {
    const f = await fake()
    await install(f.options)
    const running = async (): Promise<CommandResult> => ({
      code: 0,
      stdout: `  4242 ${f.appDir}/orca-ide\n`,
      stderr: ''
    })
    await expect(uninstall({ ...f.options, runCommand: running })).rejects.toThrow(
      /Orca appears to be running/
    )
    vi.spyOn(coreFs, 'accessSync').mockImplementation(() => {
      throw errno('EACCES')
    })
    await expect(uninstall(f.options)).rejects.toThrow(/is not writable/)
  })

  it('--purge on a missing plugin folder removes nothing; without it the folder is kept', async () => {
    const f = await fake()
    await install({ ...f.options, skipPlugin: true })
    const purged = await uninstall({ ...f.options, purge: true })
    expect(purged.pluginRemoved).toBe(false)
    await install(f.options)
    const lines: string[] = []
    const kept = await uninstall({ ...f.options, logger: logTo(lines) })
    expect(kept.pluginRemoved).toBe(false)
    expect(lines.join('\n')).toMatch(/Plugin folder kept at .* \(use --purge to delete it\)/)
  })
})

/** An app.asar built from an explicit file tree (already "patched" or otherwise hand-made). */
async function packAsar(f: FakeOrca, files: Record<string, string>): Promise<void> {
  const src = fs.mkdtempSync(path.join(f.root, 'tree-'))
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(src, ...rel.split('/'))
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content)
  }
  fs.rmSync(f.asarPath, { force: true })
  fs.rmSync(`${f.asarPath}.unpacked`, { recursive: true, force: true })
  await createPackageWithOptions(src, f.asarPath, {})
}

describe('status: states and messages', () => {
  it('reports a damaged archive as such, not as "not patched"', async () => {
    const f = await fake()
    fs.truncateSync(f.asarPath, 40)
    const report = await status(f.options)
    expect(report.exitCode).toBe(ExitCode.NeedsAction)
    expect(report.patched).toBe(false)
    expect(report.actions[0]).toMatch(/not a readable asar archive/)
    expect(report.actions.join('\n')).not.toMatch(/Orca is not patched/)
  })

  it('flags a patch applied to another Orca version than the installed one', async () => {
    const f = await fake()
    await packAsar(f, {
      'package.json': '{"name":"orca","version":"1.4.215"}',
      'out/renderer/index.html': injectScriptBlock(ORIGINAL_INDEX_HTML),
      'out/renderer/mlp/version.json': JSON.stringify({
        injectorVersion: '9.9.9',
        orcaVersion: '1.4.214',
        patchedBy: 'cpoepke.monaco-lsp'
      })
    })
    const report = await status(f.options)
    expect(report).toMatchObject({
      patched: true,
      versionChangedSincePatch: true,
      patchedOrcaVersion: '1.4.214',
      orcaVersion: '1.4.215',
      patchedBy: 'cpoepke.monaco-lsp'
    })
    expect(report.actions.join('\n')).toMatch(
      /patch was applied to Orca 1\.4\.214 but Orca 1\.4\.215 is installed/
    )
    const text = formatStatus(report)
    expect(text).toContain('Patched by:      cpoepke.monaco-lsp')
    expect(text).toMatch(/Patched for:\s+1\.4\.214\s+\(differs from installed version!\)/)
    expect(report.exitCode).toBe(ExitCode.NeedsAction)
  })

  it('flags a duplicated injection', async () => {
    const f = await fake()
    const once = injectScriptBlock(ORIGINAL_INDEX_HTML)
    const block = once.slice(
      once.indexOf('<!-- mlp:begin -->'),
      once.indexOf('<!-- mlp:end -->') + 16
    )
    await packAsar(f, {
      'package.json': '{"name":"orca","version":"1.4.214"}',
      'out/renderer/index.html': once.replace('</head>', `${block}</head>`)
    })
    const report = await status(f.options)
    expect(report.injectedBlocks).toBe(2)
    expect(report.actions.join('\n')).toMatch(/more than once; re-run install/)
  })

  it('tells how to recover after an update when auto-repair is off', async () => {
    const f = await fake()
    await install({ ...f.options, autoRepair: false })
    const { packFakeOrca } = await import('./fake-orca')
    await packFakeOrca(f.root, f.appDir, { version: '1.4.215' })
    const report = await status(f.options)
    expect(report.versionChangedSincePatch).toBe(true)
    expect(report.actions[0]).toMatch(
      /updated \(1\.4\.214 → 1\.4\.215\) and the update removed the patch\. Run `monaco-lsp-orca install` again\./
    )
    // with auto-repair on, the plugin is expected to fix it
    writeUserConfig(f.stateDir, { autoRepair: true })
    expect((await status(f.options)).actions[0]).toMatch(/Start Orca: the plugin re-applies it/)
  })

  it('backup problems: checksum mismatch, missing backup, missing plugin folder', async () => {
    const f = await fake()
    await install(f.options)
    fs.appendFileSync(backupPaths(f.asarPath).backup, 'x')
    let report = await status(f.options)
    expect(report.backup).toMatchObject({ present: true, checksumOk: false })
    expect(report.actions.join('\n')).toMatch(/does not match its checksum/)
    expect(formatStatus(report)).toContain('checksum MISMATCH')

    fs.rmSync(backupPaths(f.asarPath).backup)
    fs.rmSync(backupPaths(f.asarPath).meta)
    report = await status(f.options)
    expect(report.backup).toEqual({ present: false, checksumOk: null, orcaVersion: null })
    expect(formatStatus(report)).toMatch(/Backup:\s+no\n/)

    fs.rmSync(path.join(f.stateDir, 'plugin'), { recursive: true })
    report = await status(f.options)
    expect(report.plugin.installed).toBe(false)
    expect(report.actions.join('\n')).toMatch(/Plugin folder not installed at /)
    expect(formatStatus(report)).toContain('Plugin folder:   not installed')
  })

  it('a pending archive (Windows self-repair) is explained', async () => {
    const f = await fake()
    await install(f.options)
    const patched = `${f.asarPath}.patched-copy`
    fs.copyFileSync(f.asarPath, patched)
    fs.copyFileSync(backupPaths(f.asarPath).backup, f.asarPath) // Orca "updated": pristine again
    writePending(f.asarPath, patched, {
      baseSha256: await sha256File(f.asarPath),
      orcaVersion: '1.4.214',
      injectorVersion: '9.9.9',
      waitPid: 1,
      createdAt: '2030-01-01T00:00:00.000Z'
    })
    const report = await status(f.options)
    expect(report.pending).toEqual({
      orcaVersion: '1.4.214',
      injectorVersion: '9.9.9',
      createdAt: '2030-01-01T00:00:00.000Z'
    })
    expect(report.actions[0]).toMatch(/applied when you quit Orca/)
    expect(formatStatus(report)).toMatch(
      /Pending:\s+patched archive for Orca 1\.4\.214 waits for Orca to quit/
    )
  })

  it('shows an unknown Orca version and survives an unreadable bundled injector', async () => {
    const f = await fake()
    await packAsar(f, {
      'package.json': '{"name":"orca"}',
      'out/renderer/index.html': ORIGINAL_INDEX_HTML
    })
    const report = await status({ ...f.options, injectorPath: path.join(f.root, 'gone.js') })
    expect(report.orcaVersion).toBeNull()
    expect(report.bundledInjectorVersion).toBeNull()
    expect(formatStatus(report)).toContain('Orca version:    unknown')
  })

  it('macOS: valid, invalid and unknown signatures are printed', async () => {
    const f = await fake()
    const bundle = macBundle(f)
    const run = (reply: Partial<CommandResult>) => ({
      ...f.options,
      app: bundle,
      platform: 'darwin' as const,
      runCommand: macRunner(() => reply).runCommand
    })
    const valid = await status(run({ code: 0 }))
    expect(valid.signature).toEqual({ valid: true, detail: 'valid on disk' })
    expect(formatStatus(valid)).toMatch(/codesign:\s+valid \(valid on disk\)/)
    const unknown = await status(run({ code: 127, stderr: 'nope' }))
    expect(unknown.signature?.valid).toBeNull()
    expect(formatStatus(unknown)).toMatch(/codesign:\s+unknown \(codesign not available\)/)
    expect((await status(f.options)).signature).toBeNull()
  })
})
