import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {
  acquirePatchLock,
  applyPending,
  BACKUP_SUFFIX,
  configPath,
  inspectAsar,
  LockBusyError,
  pendingPaths,
  readBackupMeta,
  readPending,
  sha256File,
  silentLogger,
  writeUserConfig
} from '@mlp/orca-patch-core'
import { afterEach, describe, expect, it } from 'vitest'
import { install } from '../../orca-patcher/src/install'
import { uninstall } from '../../orca-patcher/src/uninstall'
import { type FakeOrca, makeFakeOrca, packFakeOrca } from '../../orca-patcher/test/fake-orca'
import {
  decideRepair,
  describeOutcome,
  type RepairFacts,
  type RepairOutcome
} from '../src/self-repair/decide'
import { orcaInstallFromExecPath } from '../src/self-repair/locate-orca'
import {
  createSelfRepair,
  type HelperLaunch,
  type SelfRepairDeps
} from '../src/self-repair/self-repair'

describe('orcaInstallFromExecPath', () => {
  it('maps the macOS bundle executable to Contents/Resources/app.asar', () => {
    expect(orcaInstallFromExecPath('/Applications/Orca.app/Contents/MacOS/Orca', 'darwin')).toEqual(
      {
        asarPath: '/Applications/Orca.app/Contents/Resources/app.asar',
        resourcesDir: '/Applications/Orca.app/Contents/Resources',
        appRoot: '/Applications/Orca.app',
        appBundle: '/Applications/Orca.app',
        appImage: false
      }
    )
    // Not inside a bundle (e.g. a bare electron binary): refuse.
    expect(orcaInstallFromExecPath('/usr/local/bin/electron', 'darwin')).toBeNull()
    expect(orcaInstallFromExecPath('/Applications/Orca/Contents/MacOS/Orca', 'darwin')).toBeNull()
  })

  it('maps Windows and Linux executables to <dir>/resources/app.asar', () => {
    expect(
      orcaInstallFromExecPath('C:\\Users\\me\\AppData\\Local\\Programs\\orca\\Orca.exe', 'win32')
    ).toEqual({
      asarPath: 'C:\\Users\\me\\AppData\\Local\\Programs\\orca\\resources\\app.asar',
      resourcesDir: 'C:\\Users\\me\\AppData\\Local\\Programs\\orca\\resources',
      appRoot: 'C:\\Users\\me\\AppData\\Local\\Programs\\orca',
      appBundle: null,
      appImage: false
    })
    expect(orcaInstallFromExecPath('/opt/Orca/orca-ide', 'linux')).toMatchObject({
      asarPath: '/opt/Orca/resources/app.asar',
      appRoot: '/opt/Orca',
      appImage: false
    })
    expect(orcaInstallFromExecPath('/tmp/.mount_OrcaAb12/orca-ide', 'linux')).toMatchObject({
      asarPath: '/tmp/.mount_OrcaAb12/resources/app.asar',
      appImage: true
    })
    expect(orcaInstallFromExecPath('orca-ide', 'linux')).toBeNull()
  })
})

describe('decideRepair', () => {
  const facts = (overrides: Partial<RepairFacts> = {}): RepairFacts => ({
    forced: false,
    autoRepair: true,
    install: 'found',
    bundledInjectorVersion: '0.2.0',
    inspection: { orcaVersion: '1.4.215', injectedBlocks: 0, injectorVersion: null },
    anchorPresent: true,
    pendingWaiting: false,
    ...overrides
  })
  const patched = (injectorVersion: string | null) => ({
    inspection: { orcaVersion: '1.4.215', injectedBlocks: 1, injectorVersion },
    anchorPresent: null
  })

  it('covers every state', () => {
    expect(decideRepair(facts())).toEqual({ kind: 'patch', reason: 'unpatched' })
    expect(decideRepair(facts({ anchorPresent: false }))).toEqual({ kind: 'unsupported' })
    expect(decideRepair(facts(patched('0.2.0')))).toEqual({ kind: 'up-to-date' })
    expect(decideRepair(facts(patched('0.1.0')))).toEqual({ kind: 'patch', reason: 'upgrade' })
    expect(decideRepair(facts(patched(null)))).toEqual({ kind: 'patch', reason: 'upgrade' })
    // never downgrade an injector a newer CLI installed
    expect(decideRepair(facts(patched('0.10.0')))).toEqual({ kind: 'up-to-date' })
    expect(
      decideRepair(
        facts({ inspection: { orcaVersion: '1', injectedBlocks: 2, injectorVersion: '0.2.0' } })
      )
    ).toEqual({ kind: 'patch', reason: 'reinject' })
    expect(decideRepair(facts({ pendingWaiting: true }))).toEqual({
      kind: 'skip',
      state: 'pending'
    })
    expect(decideRepair(facts({ install: 'not-orca', inspection: null }))).toEqual({
      kind: 'skip',
      state: 'not-orca'
    })
    expect(decideRepair(facts({ install: 'not-found', inspection: null }))).toEqual({
      kind: 'skip',
      state: 'not-found'
    })
    expect(decideRepair(facts({ bundledInjectorVersion: null }))).toEqual({
      kind: 'skip',
      state: 'no-injector'
    })
  })

  it('honours autoRepair:false unless forced', () => {
    expect(decideRepair(facts({ autoRepair: false }))).toEqual({ kind: 'skip', state: 'disabled' })
    expect(decideRepair(facts({ autoRepair: false, forced: true }))).toEqual({
      kind: 'patch',
      reason: 'unpatched'
    })
  })
})

describe('describeOutcome (notification texts)', () => {
  const report = (outcome: RepairOutcome, forced = false) => describeOutcome(outcome, forced)

  it('tells the user to restart after a repair, and what happens on Windows', () => {
    expect(
      report({
        kind: 'patched',
        reason: 'unpatched',
        orcaVersion: '1.4.215',
        injectorVersion: '0.1.0',
        resigned: null
      })
    ).toEqual({
      state: 'patched',
      action: 'patched',
      message:
        'Code navigation was re-enabled after the Orca update (v1.4.215). Restart Orca to activate it.',
      notify: true,
      dedupeKey: null
    })
    expect(
      report({
        kind: 'patched',
        reason: 'upgrade',
        orcaVersion: '1.4.215',
        injectorVersion: '0.2.0',
        resigned: true
      })
    ).toMatchObject({
      action: 'upgraded',
      message: expect.stringMatching(/injector v0\.2\.0.*Restart Orca/)
    })
    expect(
      report({ kind: 'pending', orcaVersion: '1.4.215', injectorVersion: '0.1.0' }).message
    ).toMatch(/will be re-enabled after you quit Orca/)
  })

  it('names unsupported versions and gives the exact elevated command', () => {
    expect(report({ kind: 'unsupported', orcaVersion: '1.5.0' })).toMatchObject({
      state: 'unsupported',
      message: "This Orca version (1.5.0) isn't supported by Code Navigation yet.",
      notify: true,
      dedupeKey: 'unsupported:1.5.0'
    })
    const elevation = {
      kind: 'needs-elevation' as const,
      orcaVersion: '1.4.215',
      appRoot: '/opt/Orca',
      dir: '/opt/Orca/resources',
      appImage: false
    }
    expect(report({ ...elevation, platform: 'linux' }).message).toContain(
      'sudo monaco-lsp-orca install --app "/opt/Orca"'
    )
    const win = report({ ...elevation, platform: 'win32', appRoot: 'C:\\Program Files\\Orca' })
    expect(win.message).toContain('from an administrator terminal')
    expect(win.message).toContain('monaco-lsp-orca install --app "C:\\Program Files\\Orca"')
    expect(win.message).not.toContain('sudo')
    expect(report({ ...elevation, platform: 'linux', appImage: true }).message).toMatch(
      /read-only AppImage.*--appimage-extract.*AppRun/
    )
  })

  it('stays quiet about no-ops unless forced', () => {
    const upToDate: RepairOutcome = { kind: 'up-to-date', orcaVersion: '1', injectorVersion: '2' }
    expect(report(upToDate).notify).toBe(false)
    expect(report(upToDate, true)).toMatchObject({ state: 'patched', action: 'none', notify: true })
    expect(report({ kind: 'skipped', state: 'not-found' }).notify).toBe(false)
    expect(report({ kind: 'busy', owner: 'monaco-lsp-orca, pid 1' }, true).message).toMatch(
      /monaco-lsp-orca, pid 1/
    )
  })
})

// --- effects against a fake Orca install -------------------------------------------------------

type Harness = {
  f: FakeOrca
  notes: string[]
  logs: string[]
  launches: HelperLaunch[]
  deps: SelfRepairDeps
  pluginRoot: string
  stateDir: string
}

const fakes: FakeOrca[] = []
afterEach(() => {
  for (const f of fakes.splice(0)) fs.rmSync(f.root, { recursive: true, force: true })
})

async function harness(
  opts: Parameters<typeof makeFakeOrca>[0] = {},
  overrides: Partial<SelfRepairDeps> = {}
): Promise<Harness> {
  const f = await makeFakeOrca(opts)
  fakes.push(f)
  // Why: auto-repair only acts on installs the CLI set up, and the CLI writes this file.
  writeUserConfig(f.stateDir, { autoRepair: true })
  const pluginRoot = path.join(f.root, 'userData', 'plugins', 'cpoepke.monaco-lsp', 'abc')
  fs.mkdirSync(path.join(pluginRoot, 'assets'), { recursive: true })
  fs.copyFileSync(f.injectorPath, path.join(pluginRoot, 'assets', 'injector.js'))
  const launches: HelperLaunch[] = []
  const deps: SelfRepairDeps = {
    execPath: path.join(f.appDir, 'orca-ide'),
    platform: 'linux',
    env: {},
    homedir: path.join(f.root, 'home'),
    pluginRoot,
    parentPid: 1,
    pluginVersion: '0.1.0',
    runCommand: async () => ({ code: 0, stdout: '', stderr: '' }),
    spawnHelper: (launch) => {
      launches.push(launch)
      return 4242
    },
    ...overrides
  }
  return { f, notes: [], logs: [], launches, deps, pluginRoot, stateDir: f.stateDir }
}

function start(h: Harness, overrides: Partial<SelfRepairDeps> = {}) {
  const repair = createSelfRepair({ ...h.deps, ...overrides })
  const line = (level: string) => (message: string, meta?: Record<string, unknown>) =>
    void h.logs.push(`${level}: ${message} ${meta ? JSON.stringify(meta) : ''}`)
  repair.attach({
    notify: (body) => void h.notes.push(body),
    log: { debug: () => {}, info: line('info'), warn: line('warn'), error: line('error') }
  })
  return repair
}

const versionJson = (asarPath: string) => inspectAsar(asarPath).versionInfo

describe('self-repair on a fake Orca install', () => {
  it('re-patches after an Orca update, refreshes the backup, then is a no-op', async () => {
    const h = await harness()
    await install(h.f.options) // the CLI patched 1.4.214 once
    await packFakeOrca(h.f.root, h.f.appDir, { version: '1.4.215' }) // the update wiped it
    expect(inspectAsar(h.f.asarPath).injectedBlocks).toBe(0)
    const pristine215 = await sha256File(h.f.asarPath)

    const repair = start(h)
    expect(repair.status()).toMatchObject({ state: 'unpatched', orcaVersion: '1.4.215' })
    repair.autoCheck('activate')
    await repair.idle()
    expect(h.notes).toEqual([
      'Code navigation was re-enabled after the Orca update (v1.4.215). Restart Orca to activate it.'
    ])
    expect(inspectAsar(h.f.asarPath).injectedBlocks).toBe(1)
    expect(versionJson(h.f.asarPath)).toMatchObject({
      injectorVersion: '9.9.9',
      orcaVersion: '1.4.215',
      patchedBy: 'cpoepke.monaco-lsp'
    })
    // the backup now holds the new pristine version, so uninstall restores 1.4.215
    expect(readBackupMeta(h.f.asarPath)).toMatchObject({
      orcaVersion: '1.4.215',
      sha256: pristine215
    })
    expect(fs.existsSync(`${h.f.asarPath}.mlp-lock`)).toBe(false)
    expect(repair.status()).toMatchObject({
      state: 'patched',
      orcaVersion: '1.4.215',
      injectorVersion: '9.9.9',
      asarPath: h.f.asarPath,
      lastRepair: { action: 'patched', trigger: 'activate', orcaVersion: '1.4.215' }
    })

    // once per worker lifetime; a later event does nothing
    repair.autoCheck('agent.status.changed')
    await repair.idle()
    expect(h.notes).toHaveLength(1)
    // a new worker (next Orca start) sees the current patch and stays quiet
    const next = start(h)
    next.autoCheck('activate')
    await next.idle()
    expect(h.notes).toHaveLength(1)
    // the manual command reports the no-op
    const forced = await next.check({ forced: true, trigger: 'command' })
    expect(forced).toMatchObject({ state: 'patched', action: 'none' })
    expect(h.notes.at(-1)).toMatch(/nothing to repair/)

    await uninstall(h.f.options)
    expect(await sha256File(h.f.asarPath)).toBe(pristine215)
  })

  it('upgrades an older injector in place, keeping the pristine backup', async () => {
    const h = await harness()
    fs.writeFileSync(h.f.injectorPath, '/*! @mlp/orca-injector v9.9.8 */\n;0\n')
    await install(h.f.options)
    const backupSha = readBackupMeta(h.f.asarPath)!.sha256
    const report = await start(h).check({ forced: false, trigger: 'activate' })
    expect(report).toMatchObject({ state: 'patched', action: 'upgraded' })
    expect(versionJson(h.f.asarPath)?.injectorVersion).toBe('9.9.9')
    expect(readBackupMeta(h.f.asarPath)!.sha256).toBe(backupSha)
    expect(h.notes[0]).toMatch(/updated to injector v9\.9\.9/)
  })

  it('refuses apps that are not Orca and installs it cannot find', async () => {
    const h = await harness({ name: 'electron' })
    const sha = await sha256File(h.f.asarPath)
    expect(await start(h).check({ forced: true, trigger: 'command' })).toMatchObject({
      state: 'not-orca'
    })
    expect(await sha256File(h.f.asarPath)).toBe(sha)
    const missing = start(h, { execPath: path.join(h.f.root, 'elsewhere', 'electron') })
    expect(await missing.check({ forced: false, trigger: 'activate' })).toMatchObject({
      state: 'not-found',
      notify: false
    })
    expect(h.notes).toHaveLength(1) // only the forced check notified
  })

  it('reports an unsupported Orca once per version and changes nothing', async () => {
    const h = await harness({ anchor: false, version: '1.6.0' })
    const sha = await sha256File(h.f.asarPath)
    const first = start(h)
    first.autoCheck('activate')
    await first.idle()
    const again = start(h)
    again.autoCheck('activate')
    await again.idle()
    expect(h.notes).toEqual(["This Orca version (1.6.0) isn't supported by Code Navigation yet."])
    expect(await sha256File(h.f.asarPath)).toBe(sha)
    expect(fs.readdirSync(path.dirname(h.f.asarPath)).sort()).toEqual([
      'app.asar',
      'app.asar.unpacked'
    ])
  })

  it('never patches on its own when the CLI was never run (no config file)', async () => {
    const h = await harness()
    fs.rmSync(configPath(h.stateDir))
    const repair = start(h)
    await repair.check({ forced: false, trigger: 'activate' })
    expect(inspectAsar(h.f.asarPath).injectedBlocks).toBe(0)
    expect(h.notes).toEqual([])
    // The explicit repair command is the user asking, so it still works.
    await repair.check({ forced: true, trigger: 'command' })
    expect(inspectAsar(h.f.asarPath).injectedBlocks).toBe(1)
  })

  it('does nothing automatically when autoRepair is off, but the command still repairs', async () => {
    const h = await harness()
    writeUserConfig(h.stateDir, { autoRepair: false })
    const repair = start(h)
    repair.autoCheck('activate')
    await repair.idle()
    expect(inspectAsar(h.f.asarPath).injectedBlocks).toBe(0)
    expect(h.notes).toEqual([])
    expect(await repair.check({ forced: true, trigger: 'command' })).toMatchObject({
      state: 'patched',
      action: 'patched'
    })
  })

  it('EACCES/EROFS: tells the user the exact command to run', async () => {
    const h = await harness()
    const readOnly = (code: string) => () => {
      throw Object.assign(new Error(`${code}: permission denied`), { code })
    }
    const report = await start(h, { replaceAsar: readOnly('EACCES') }).check({
      forced: false,
      trigger: 'activate'
    })
    expect(report).toMatchObject({ state: 'unpatched', action: 'needs-elevation' })
    expect(h.notes[0]).toContain(`sudo monaco-lsp-orca install --app "${h.f.appDir}"`)
    expect(inspectAsar(h.f.asarPath).injectedBlocks).toBe(0)
    expect(fs.existsSync(`${h.f.asarPath}.mlp-tmp`)).toBe(false)

    // a mounted AppImage: the extraction hint instead
    const mount = path.join(h.f.root, '.mount_OrcaX1')
    fs.cpSync(path.join(h.f.appDir, 'resources'), path.join(mount, 'resources'), {
      recursive: true
    })
    const appImage = start(h, {
      execPath: path.join(mount, 'orca-ide'),
      replaceAsar: readOnly('EROFS')
    })
    expect((await appImage.check({ forced: true, trigger: 'command' })).message).toMatch(
      /read-only AppImage.*--appimage-extract/
    )
  })

  it('EBUSY (Windows): parks the patched archive and a helper swaps it in after Orca exits', async () => {
    const orca = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    try {
      const h = await harness({}, { parentPid: orca.pid! })
      const busy = () => {
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
      }
      const report = await start(h, { replaceAsar: busy }).check({
        forced: false,
        trigger: 'activate'
      })
      expect(report).toMatchObject({ state: 'pending', action: 'scheduled' })
      expect(h.notes[0]).toMatch(/will be re-enabled after you quit Orca/)
      expect(inspectAsar(h.f.asarPath).injectedBlocks).toBe(0)
      expect(readPending(h.f.asarPath)).toMatchObject({
        waitPid: orca.pid,
        injectorVersion: '9.9.9'
      })
      expect(h.launches).toEqual([
        {
          script: path.join(h.pluginRoot, 'dist', 'apply-pending.mjs'),
          asarPath: h.f.asarPath,
          waitPid: orca.pid,
          logFile: path.join(h.stateDir, 'logs', 'apply-pending.log')
        }
      ])
      // The backup was refreshed before the swap was attempted.
      expect(fs.existsSync(`${h.f.asarPath}${BACKUP_SUFFIX}`)).toBe(true)

      // The helper (run in-process here; bundle-smoke runs the real dist/apply-pending.mjs).
      const helper = applyPending({
        asarPath: h.f.asarPath,
        waitPid: orca.pid!,
        logger: silentLogger,
        pollMs: 50
      })
      // A worker started meanwhile sees the pending swap and does not patch again.
      const meanwhile = start(h, { replaceAsar: busy })
      expect(await meanwhile.check({ forced: false, trigger: 'activate' })).toMatchObject({
        state: 'pending',
        notify: false
      })
      expect(meanwhile.status().state).toBe('pending')
      orca.kill('SIGKILL')
      expect(await helper).toBe('applied')
      expect(versionJson(h.f.asarPath)).toMatchObject({ injectorVersion: '9.9.9' })
      expect(fs.existsSync(pendingPaths(h.f.asarPath).archive)).toBe(false)
    } finally {
      orca.kill('SIGKILL')
    }
  })

  it('never patches while the CLI holds the lock, and the CLI waits for the plugin', async () => {
    const h = await harness()
    const cli = acquirePatchLock(h.f.asarPath, { tool: 'monaco-lsp-orca' })
    const repair = start(h)
    repair.autoCheck('activate')
    await repair.idle()
    expect(inspectAsar(h.f.asarPath).injectedBlocks).toBe(0)
    expect(h.notes).toEqual([]) // busy is not worth a notification on an automatic check
    cli.release()
    // busy re-arms the automatic check
    repair.autoCheck('agent.status.changed')
    await repair.idle()
    expect(inspectAsar(h.f.asarPath).injectedBlocks).toBe(1)

    const plugin = acquirePatchLock(h.f.asarPath, { tool: 'cpoepke.monaco-lsp' })
    try {
      await expect(install({ ...h.f.options, lockWaitMs: 200 })).rejects.toBeInstanceOf(
        LockBusyError
      )
      await expect(install({ ...h.f.options, lockWaitMs: 200 })).rejects.toThrow(
        /cpoepke\.monaco-lsp, pid/
      )
    } finally {
      plugin.release()
    }
    await expect(install({ ...h.f.options, lockWaitMs: 200 })).resolves.toMatchObject({
      backupAction: 'kept'
    })
  })

  it('macOS: re-signs ad hoc by default and skips it with resign:false', async () => {
    const h = await harness()
    // Lay the fake install out as Orca.app.
    const bundle = path.join(h.f.root, 'Orca.app')
    const resources = path.join(bundle, 'Contents', 'Resources')
    fs.mkdirSync(path.join(bundle, 'Contents', 'MacOS'), { recursive: true })
    fs.cpSync(path.join(h.f.appDir, 'resources'), resources, { recursive: true })
    const calls: string[][] = []
    const mac: Partial<SelfRepairDeps> = {
      platform: 'darwin',
      execPath: path.join(bundle, 'Contents', 'MacOS', 'Orca'),
      runCommand: async (command, args) => {
        calls.push([command, ...args])
        return { code: 0, stdout: '', stderr: '' }
      }
    }
    await start(h, mac).check({ forced: false, trigger: 'activate' })
    expect(calls).toEqual([['codesign', '--force', '--deep', '--sign', '-', bundle]])

    await packFakeOrca(h.f.root, path.join(bundle, 'Contents'), { version: '1.4.216' })
    // packFakeOrca writes <dir>/resources/app.asar; move it to the macOS spelling
    fs.renameSync(
      path.join(bundle, 'Contents', 'resources', 'app.asar'),
      path.join(resources, 'app.asar')
    )
    writeUserConfig(h.stateDir, { resign: false })
    expect(fs.existsSync(configPath(h.stateDir))).toBe(true)
    calls.length = 0
    const report = await start(h, mac).check({ forced: false, trigger: 'activate' })
    expect(report).toMatchObject({ state: 'patched', action: 'patched' })
    expect(calls).toEqual([])
  })
})
