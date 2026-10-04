import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PatcherError } from '@mlp/orca-patch-core'
import {
  defaultAssetsDir,
  defaultInjectorPath,
  defaultPluginSource,
  readPluginManifest
} from '../src/assets'
import { createContext, silentLogger } from '../src/context'
import { APPIMAGE_HELP, candidateAppRoots, resolveTarget } from '../src/locate'
import { installedPluginDir, installPluginFolder, pluginInstructions } from '../src/plugin'

const dirs: string[] = []
const tmp = (): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mlp-locate2-')))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})
const write = (file: string, content = 'x'): string => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
  return file
}

describe('resolveTarget', () => {
  // Why skipped on Windows: the darwin default roots are joined with POSIX separators, so a Windows
  // temp dir would yield mixed-separator paths that cannot be compared with native ones.
  it.skipIf(process.platform === 'win32')(
    'finds a default macOS install under the home directory',
    () => {
      const home = tmp()
      const asar = write(
        path.join(home, 'Applications', 'Orca.app', 'Contents', 'Resources', 'app.asar')
      )
      const ctx = createContext({
        platform: 'darwin',
        env: {},
        homeDir: home,
        logger: silentLogger
      })
      expect(resolveTarget(ctx)).toMatchObject({
        kind: 'macos-app',
        asarPath: asar,
        appBundle: path.join(home, 'Applications', 'Orca.app')
      })
    }
  )

  it.each([
    ['darwin', /Pass --app <path to Orca> if it is installed elsewhere\./],
    ['win32', /Pass --app <path to Orca> if it is installed elsewhere\./],
    ['linux', /If you run Orca as an AppImage:/]
  ] as const)('lists where it looked when nothing is installed (%s)', (platform, hint) => {
    const home = tmp()
    const ctx = createContext({
      platform,
      env: {
        LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
        ProgramFiles: path.join(home, 'PF')
      },
      homeDir: home,
      logger: silentLogger
    })
    let thrown: unknown
    try {
      resolveTarget(ctx)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(PatcherError)
    expect((thrown as Error).message).toMatch(
      /^Could not find an Orca installation\. Searched:\n {2}\S/
    )
    expect((thrown as Error).message).toMatch(hint)
  })

  it('accepts app.asar, an install dir, a bare dir containing app.asar and rejects AppImages', () => {
    const dir = tmp()
    const ctx = createContext({ platform: 'linux', env: {}, homeDir: dir, logger: silentLogger })
    const direct = write(path.join(dir, 'bare', 'app.asar'))
    expect(resolveTarget(ctx, path.join(dir, 'bare'))).toMatchObject({ asarPath: direct })
    expect(resolveTarget(ctx, direct)).toMatchObject({ asarPath: direct, kind: 'linux' })
    const darwin = createContext({
      platform: 'darwin',
      env: {},
      homeDir: dir,
      logger: silentLogger
    })
    expect(resolveTarget(darwin, direct).kind).toBe('custom')
    let thrown: unknown
    try {
      resolveTarget(ctx, path.join(dir, 'Orca-1.0.APPIMAGE'))
    } catch (error) {
      thrown = error
    }
    expect((thrown as Error).message).toContain(APPIMAGE_HELP)
  })

  it('detects an AppRun next to the resources dir as an extracted AppImage', () => {
    const dir = tmp()
    write(path.join(dir, 'AppRun'), '#!/bin/sh\n')
    const asar = write(path.join(dir, 'resources', 'app.asar'))
    const ctx = createContext({ platform: 'linux', env: {}, homeDir: dir, logger: silentLogger })
    expect(resolveTarget(ctx, dir)).toMatchObject({ kind: 'appimage-extracted', asarPath: asar })
  })

  it('knows the default Windows roots without duplicates', () => {
    const roots = candidateAppRoots(
      'win32',
      { LOCALAPPDATA: 'C:\\L', ProgramFiles: 'C:\\P' },
      'C:\\H'
    )
    expect(roots).toEqual(['C:\\L\\Programs\\orca', 'C:\\P\\Orca'])
    expect(candidateAppRoots('win32', {}, 'C:\\H')[0]).toBe('C:\\H\\AppData\\Local\\Programs\\orca')
  })
})

describe('assets and plugin folder', () => {
  it('locates the bundled assets next to the package', () => {
    expect(path.basename(defaultAssetsDir())).toBe('assets')
    expect(defaultInjectorPath()).toBe(path.join(defaultAssetsDir(), 'injector.js'))
    expect(defaultPluginSource()).toBe(
      path.join(defaultAssetsDir(), 'plugin', 'cpoepke.monaco-lsp')
    )
  })

  it('readPluginManifest is null for missing or damaged manifests', () => {
    const dir = tmp()
    expect(readPluginManifest(dir)).toBeNull()
    write(path.join(dir, 'orca-plugin.json'), '{ nope')
    expect(readPluginManifest(dir)).toBeNull()
    write(path.join(dir, 'orca-plugin.json'), '{"id":"x","version":"1.0.0"}')
    expect(readPluginManifest(dir)).toEqual({ id: 'x', version: '1.0.0' })
  })

  it('installPluginFolder reports a missing bundle and replaces an existing folder', () => {
    const root = tmp()
    const ctx = createContext({
      platform: 'linux',
      env: {},
      homeDir: root,
      stateDir: path.join(root, 'state'),
      logger: silentLogger
    })
    const missing = installPluginFolder(ctx, path.join(root, 'nope'))
    expect(missing).toMatchObject({ installed: false })
    expect(missing.installed === false && missing.reason).toMatch(/plugin bundle not found/)

    const src = path.join(root, 'src')
    write(path.join(src, 'orca-plugin.json'), '{"version":"2.0.0"}')
    write(path.join(src, 'dist', 'main.js'))
    const dest = installedPluginDir(ctx)
    write(path.join(dest, 'stale.txt'))
    expect(installPluginFolder(ctx, src)).toEqual({ installed: true, dir: dest, version: '2.0.0' })
    expect(fs.existsSync(path.join(dest, 'stale.txt'))).toBe(false)
    expect(fs.existsSync(path.join(dest, 'dist', 'main.js'))).toBe(true)

    write(path.join(src, 'orca-plugin.json'), '{}')
    expect(installPluginFolder(ctx, src)).toMatchObject({ installed: true, version: null })
    expect(pluginInstructions(dest)).toContain(dest)
  })
})
