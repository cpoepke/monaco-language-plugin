import fs from 'node:fs'
import path from 'node:path'
import * as asar from '@electron/asar'
import { afterEach, describe, expect, it } from 'vitest'
import { readAsarFile, readEntries } from '../src/asar'
import { readBackupMeta } from '../src/backup'
import {
  BACKUP_SUFFIX,
  INJECTOR_ASAR_PATH,
  MARKER_BEGIN,
  RENDERER_INDEX,
  VERSION_ASAR_PATH
} from '../src/constants'
import { ExitCode, PatcherError } from '../src/errors'
import { sha256File } from '../src/fsutil'
import { install } from '../src/install'
import { readState } from '../src/state'
import { status } from '../src/status'
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
