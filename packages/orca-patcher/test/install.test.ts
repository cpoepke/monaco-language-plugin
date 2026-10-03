import fs from 'node:fs'
import path from 'node:path'
import * as asar from '@electron/asar'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ExitCode,
  PatcherError,
  readAsarFile,
  readBackupMeta,
  readEntries,
  readUserConfig,
  sha256File
} from '@mlp/orca-patch-core'
import {
  BACKUP_SUFFIX,
  INJECTOR_ASAR_PATH,
  MARKER_BEGIN,
  RENDERER_INDEX,
  VERSION_ASAR_PATH
} from '../src/constants'
import { main } from '../src/cli'
import { install } from '../src/install'
import { readState } from '../src/state'
import { formatStatus, status } from '../src/status'
import { uninstall } from '../src/uninstall'
import { createContext } from '../src/context'
import {
  type FakeOrca,
  makeFakeOrca,
  NATIVE_BYTES,
  ORIGINAL_INDEX_HTML,
  packFakeOrca
} from './fake-orca'

const fakes: FakeOrca[] = []
async function fake(opts?: { version?: string; anchor?: boolean }): Promise<FakeOrca> {
  const f = await makeFakeOrca(opts)
  fakes.push(f)
  return f
}
afterEach(() => {
  for (const f of fakes.splice(0)) fs.rmSync(f.root, { recursive: true, force: true })
})

const indexHtml = (asarPath: string): string =>
  readAsarFile(asarPath, RENDERER_INDEX)?.toString('utf8') ?? ''

function expectUnpackedIntact(f: FakeOrca): void {
  const entries = readEntries(f.asarPath)
  expect(entries.get('node_modules/x/x.node')).toMatchObject({ type: 'file', unpacked: true })
  expect(entries.get('node_modules/x/package.json')?.unpacked).toBe(false)
  expect(entries.get(RENDERER_INDEX)?.unpacked).toBe(false)
  const onDisk = path.join(`${f.asarPath}.unpacked`, 'node_modules', 'x', 'x.node')
  expect(fs.readFileSync(onDisk)).toEqual(NATIVE_BYTES)
  asar.uncacheAll()
  expect(asar.extractFile(f.asarPath, 'node_modules/x/x.node')).toEqual(NATIVE_BYTES)
  // nothing besides the original unpacked files ended up in app.asar.unpacked
  expect(fs.readdirSync(`${f.asarPath}.unpacked`, { recursive: true }).sort()).toEqual([
    'node_modules',
    path.join('node_modules', 'x'),
    path.join('node_modules', 'x', 'x.node')
  ])
}

describe('install', () => {
  it('injects exactly once (idempotent), keeps unpacked files and backs up the original', async () => {
    const f = await fake()
    const originalSha = await sha256File(f.asarPath)
    const originalEntries = readEntries(f.asarPath)

    const first = await install(f.options)
    expect(first.backupAction).toBe('created')
    expect(first.anchorFiles).toEqual(['out/renderer/assets/MonacoEditor-def.js'])
    expect(first.orcaVersion).toBe('1.4.214')
    const second = await install(f.options)
    expect(second.backupAction).toBe('kept')

    const html = indexHtml(f.asarPath)
    expect(html.split(MARKER_BEGIN)).toHaveLength(2)
    expect(html).toContain(
      '<head>\n    <!-- mlp:begin --><script src="./mlp/injector.js"></script><!-- mlp:end -->\n    <meta charset="UTF-8" />'
    )
    // injector runs before the module script
    expect(html.indexOf('./mlp/injector.js')).toBeLessThan(html.indexOf('type="module"'))

    expect(readAsarFile(f.asarPath, INJECTOR_ASAR_PATH)).toEqual(fs.readFileSync(f.injectorPath))
    const version = JSON.parse(readAsarFile(f.asarPath, VERSION_ASAR_PATH)!.toString('utf8'))
    expect(version).toMatchObject({ injectorVersion: '9.9.9', orcaVersion: '1.4.214' })

    // every original entry survived unchanged (except index.html)
    const after = readEntries(f.asarPath)
    for (const [p, e] of originalEntries) {
      expect(after.get(p)?.type).toBe(e.type)
      if (p !== RENDERER_INDEX && e.type === 'file') expect(after.get(p)?.size).toBe(e.size)
    }
    expect(readAsarFile(f.asarPath, 'out/main/index.js')?.toString()).toBe('console.log("main")\n')
    expectUnpackedIntact(f)

    // backup is the pristine archive, with its checksum in the sidecar
    const backup = `${f.asarPath}${BACKUP_SUFFIX}`
    expect(await sha256File(backup)).toBe(originalSha)
    expect(readBackupMeta(f.asarPath)).toMatchObject({
      sha256: originalSha,
      orcaVersion: '1.4.214'
    })
    expect(fs.existsSync(`${f.asarPath}.mlp-tmp`)).toBe(false)

    // plugin folder + state
    const pluginManifest = path.join(f.stateDir, 'plugin', 'cpoepke.monaco-lsp', 'orca-plugin.json')
    expect(JSON.parse(fs.readFileSync(pluginManifest, 'utf8')).version).toBe('0.2.0')
    expect(readState(createContext(f.options)).installs[f.asarPath]).toMatchObject({
      orcaVersion: '1.4.214',
      injectorVersion: '9.9.9'
    })
  })

  it('dry run changes nothing', async () => {
    const f = await fake()
    const sha = await sha256File(f.asarPath)
    const result = await install({ ...f.options, dryRun: true })
    expect(result.dryRun).toBe(true)
    expect(await sha256File(f.asarPath)).toBe(sha)
    expect(fs.existsSync(`${f.asarPath}${BACKUP_SUFFIX}`)).toBe(false)
    expect(fs.existsSync(f.stateDir)).toBe(false)
    expect(fs.readdirSync(path.dirname(f.asarPath)).sort()).toEqual([
      'app.asar',
      'app.asar.unpacked'
    ])
  })

  it('fails loudly without the Monaco anchor and modifies nothing', async () => {
    const f = await fake({ anchor: false })
    const sha = await sha256File(f.asarPath)
    await expect(install(f.options)).rejects.toThrow(/MonacoEnvironment\?\.globalAPI/)
    await expect(install(f.options)).rejects.toBeInstanceOf(PatcherError)
    expect(await sha256File(f.asarPath)).toBe(sha)
    expect(fs.readdirSync(path.dirname(f.asarPath)).sort()).toEqual([
      'app.asar',
      'app.asar.unpacked'
    ])
    expect(fs.existsSync(f.stateDir)).toBe(false)
  })

  it('refuses while Orca is running unless --force', async () => {
    const f = await fake()
    const running = {
      ...f.options,
      runCommand: async () => ({
        code: 0,
        stdout: `  4242 ${f.appDir}/orca-ide --no-sandbox\n  77 /usr/bin/orca --screen-reader\n`,
        stderr: ''
      })
    }
    await expect(install(running)).rejects.toThrow(/running/)
    await expect(install({ ...running, force: true })).resolves.toMatchObject({
      backupAction: 'created'
    })
  })
})

describe('install under sudo', () => {
  it("writes state and plugin into the invoking user's home and hands them back", async () => {
    const f = await fake()
    const userHome = path.join(f.root, 'alice-home')
    fs.mkdirSync(userHome)
    const chowned: [string, number, number][] = []
    const system = {
      getuid: () => 0,
      readFile: (file: string) =>
        file === '/etc/passwd'
          ? `root:x:0:0:root:/root:/bin/sh\nalice:x:501:20:Alice:${userHome}:/bin/zsh\n`
          : null,
      shellHomeOf: () => {
        throw new Error('not needed when /etc/passwd has the user')
      },
      chown: (file: string, uid: number, gid: number) => {
        chowned.push([file, uid, gid])
      }
    }
    const env = { SUDO_USER: 'alice', SUDO_UID: '501', SUDO_GID: '20' }
    const { homeDir: _home, stateDir: _state, ...rest } = f.options
    const options = { ...rest, env, system }

    const ctx = createContext(options)
    expect(ctx.invokingUser).toEqual({ name: 'alice', uid: 501, gid: 20, home: userHome })
    const stateDir = path.join(userHome, '.monaco-lsp-orca')
    expect(ctx.stateDir).toBe(stateDir)

    const result = await install(options)
    expect(result.plugin).toMatchObject({ installed: true })
    expect(fs.existsSync(path.join(stateDir, 'state.json'))).toBe(true)
    const pluginDir = path.join(stateDir, 'plugin', 'cpoepke.monaco-lsp')
    const owned = new Set(chowned.filter(([, u, g]) => u === 501 && g === 20).map(([p]) => p))
    for (const p of [
      stateDir,
      path.join(stateDir, 'state.json'),
      path.join(stateDir, 'plugin'),
      pluginDir,
      path.join(pluginDir, 'orca-plugin.json'),
      path.join(pluginDir, 'dist', 'main.js')
    ]) {
      expect(owned, p).toContain(p)
    }
    // nothing outside the user's home (e.g. Orca's app.asar) is chowned
    expect(chowned.every(([p]) => p.startsWith(userHome + path.sep))).toBe(true)
  })

  it('falls back to ~user, and ignores sudo when not root or on Windows', () => {
    const system = {
      getuid: () => 0,
      readFile: () => 'root:x:0:0:root:/root:/bin/sh\n',
      shellHomeOf: (user: string) => `/Users/${user}`,
      chown: () => {}
    }
    const env = { SUDO_USER: 'bob', SUDO_UID: '502', SUDO_GID: '20' }
    expect(createContext({ platform: 'darwin', env, system }).homeDir).toBe('/Users/bob')
    expect(createContext({ platform: 'darwin', env, system }).invokingUser?.uid).toBe(502)
    const asUser = createContext({
      platform: 'linux',
      env,
      system: { ...system, getuid: () => 501 }
    })
    expect(asUser.invokingUser).toBeNull()
    expect(createContext({ platform: 'win32', env, system }).invokingUser).toBeNull()
    // a hostile SUDO_USER never reaches the shell
    const shellHomeOf = vi.fn(() => '/x')
    const hostile = createContext({
      platform: 'linux',
      env: { ...env, SUDO_USER: 'x;rm -rf ~' },
      system: { ...system, shellHomeOf }
    })
    expect(hostile.invokingUser).toBeNull()
    expect(shellHomeOf).not.toHaveBeenCalled()
  })
})

describe('uninstall', () => {
  it('restores a byte-identical app.asar from the backup and keeps the plugin folder', async () => {
    const f = await fake()
    const sha = await sha256File(f.asarPath)
    await install(f.options)
    expect(await sha256File(f.asarPath)).not.toBe(sha)
    const result = await uninstall(f.options)
    expect(result.action).toBe('restored')
    expect(await sha256File(f.asarPath)).toBe(sha)
    expect(fs.existsSync(`${f.asarPath}${BACKUP_SUFFIX}`)).toBe(false)
    expect(fs.existsSync(path.join(f.stateDir, 'plugin', 'cpoepke.monaco-lsp'))).toBe(true)
    expect(readState(createContext(f.options)).installs[f.asarPath]).toBeUndefined()
    expectUnpackedIntact(f)

    const again = await uninstall({ ...f.options, purge: true })
    expect(again).toMatchObject({ action: 'not-patched', pluginRemoved: true })
    expect(fs.existsSync(path.join(f.stateDir, 'plugin', 'cpoepke.monaco-lsp'))).toBe(false)
  })

  it('strips the injection in place when no backup exists', async () => {
    const f = await fake()
    await install(f.options)
    fs.rmSync(`${f.asarPath}${BACKUP_SUFFIX}`)
    const result = await uninstall(f.options)
    expect(result.action).toBe('stripped')
    expect(indexHtml(f.asarPath)).toBe(ORIGINAL_INDEX_HTML)
    expect(readAsarFile(f.asarPath, INJECTOR_ASAR_PATH)).toBeNull()
    expect(readEntries(f.asarPath).has('out/renderer/mlp')).toBe(false)
    expectUnpackedIntact(f)
  })

  it('does not restore a backup whose checksum does not match', async () => {
    const f = await fake()
    await install(f.options)
    fs.appendFileSync(`${f.asarPath}${BACKUP_SUFFIX}`, 'corrupt')
    const result = await uninstall(f.options)
    expect(result.action).toBe('stripped')
    expect(indexHtml(f.asarPath)).toBe(ORIGINAL_INDEX_HTML)
  })
})

describe('status', () => {
  it('reports unpatched → patched → wiped by an update', async () => {
    const f = await fake()
    const before = await status(f.options)
    expect(before).toMatchObject({
      patched: false,
      orcaVersion: '1.4.214',
      exitCode: ExitCode.NeedsAction
    })
    expect(before.plugin.installed).toBe(false)

    await install(f.options)
    const patched = await status(f.options)
    expect(patched).toMatchObject({
      patched: true,
      injectedBlocks: 1,
      injectorVersion: '9.9.9',
      patchedOrcaVersion: '1.4.214',
      versionChangedSincePatch: false,
      backup: { present: true, checksumOk: true, orcaVersion: '1.4.214' },
      plugin: { installed: true, version: '0.2.0' },
      exitCode: ExitCode.Ok
    })
    expect(patched.actions).toEqual([])

    // Orca auto-update replaces app.asar with a fresh, unpatched 1.4.215.
    await packFakeOrca(f.root, f.appDir, { version: '1.4.215' })
    const wiped = await status(f.options)
    expect(wiped).toMatchObject({
      patched: false,
      orcaVersion: '1.4.215',
      patchedOrcaVersion: '1.4.214',
      versionChangedSincePatch: true,
      exitCode: ExitCode.NeedsAction
    })
    expect(wiped.actions[0]).toMatch(/updated \(1\.4\.214 → 1\.4\.215\)/)

    // Re-install refreshes the stale backup; uninstall then restores 1.4.215, not the old version.
    const sha215 = await sha256File(f.asarPath)
    const reinstall = await install(f.options)
    expect(reinstall.backupAction).toBe('refreshed')
    expect((await status(f.options)).exitCode).toBe(ExitCode.Ok)
    await uninstall(f.options)
    expect(await sha256File(f.asarPath)).toBe(sha215)
  })

  it('flags an outdated injector', async () => {
    const f = await fake()
    await install(f.options)
    fs.writeFileSync(f.injectorPath, '/*! @mlp/orca-injector v10.0.0 */\n')
    const report = await status(f.options)
    expect(report.exitCode).toBe(ExitCode.NeedsAction)
    expect(report.actions.join('\n')).toMatch(/9\.9\.9 is installed, 10\.0\.0 is available/)
  })
})

const collect = (logs: string[]) => ({
  info: (m: string) => void logs.push(m),
  warn: (m: string) => void logs.push(m),
  error: (m: string) => void logs.push(m)
})

describe('settings: --no-resign / --no-auto-repair (config.json)', () => {
  it('the CLI flags are persisted for the self-repair; uninstall turns auto-repair off', async () => {
    const f = await fake()
    const logs: string[] = []
    const defaults = { ...f.options, app: undefined, logger: collect(logs) }
    expect(
      await main(['install', '--app', f.appDir, '--no-resign', '--no-auto-repair'], defaults)
    ).toBe(ExitCode.Ok)
    expect(readUserConfig(f.stateDir)).toEqual({ autoRepair: false, resign: false, exists: true })
    expect(logs.join('\n')).toMatch(/Auto-repair is off/)
    // plain install restores the defaults (re-sign, auto-repair)
    await main(['install', '--app', f.appDir], defaults)
    expect(readUserConfig(f.stateDir)).toEqual({ autoRepair: true, resign: true, exists: true })
    expect(logs.join('\n')).toMatch(/re-applies it\s+automatically after an update/)
    expect((await status(f.options)).config).toMatchObject({ autoRepair: true, resign: true })

    await uninstall(f.options)
    expect(readUserConfig(f.stateDir).autoRepair).toBe(false)
  })

  it('macOS: --no-resign skips codesign and explains both modes; status verifies the signature', async () => {
    const f = await fake()
    const bundle = path.join(f.root, 'Orca.app')
    fs.mkdirSync(path.join(bundle, 'Contents'), { recursive: true })
    fs.cpSync(path.join(f.appDir, 'resources'), path.join(bundle, 'Contents', 'Resources'), {
      recursive: true
    })
    const calls: string[][] = []
    const logs: string[] = []
    const mac = {
      ...f.options,
      app: bundle,
      platform: 'darwin' as const,
      logger: collect(logs),
      runCommand: async (command: string, args: string[]) => {
        calls.push([command, ...args])
        if (args[0] === '--verify') {
          return {
            code: 1,
            stdout: '',
            stderr: `${bundle}: a sealed resource is missing or invalid`
          }
        }
        // plutil: no ElectronAsarIntegrity key; ps/codesign: fine
        return { code: command === 'plutil' ? 1 : 0, stdout: '', stderr: '' }
      }
    }
    const noResign = await install({ ...mac, resign: false })
    expect(noResign.resigned).toBe(false)
    expect(calls.some(([c, a]) => c === 'codesign' && a === '--force')).toBe(false)
    expect(logs.join('\n')).toMatch(
      /NOT re-signed[\s\S]*Developer ID[\s\S]*damaged[\s\S]*monaco-lsp-orca install/
    )
    expect(readUserConfig(f.stateDir).resign).toBe(false)

    const report = await status(mac)
    expect(report.signature).toEqual({
      valid: false,
      detail: `${bundle}: a sealed resource is missing or invalid`
    })
    expect(formatStatus(report)).toMatch(/Signing mode:\s+keep the original signature/)
    expect(formatStatus(report)).toMatch(/codesign:\s+INVALID/)

    logs.length = 0
    const resigned = await install(mac)
    expect(resigned.resigned).toBe(true)
    expect(calls).toContainEqual(['codesign', '--force', '--deep', '--sign', '-', bundle])
    expect(logs.join('\n')).toMatch(/re-signed ad hoc[\s\S]*--no-resign/)
  })
})
