import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseInjectorVersion } from '../src/assets'
import { PATCHER_VERSION } from '../src/constants'
import { createContext, silentLogger } from '../src/context'
import { doctor, findExecutable, searchDirs } from '../src/doctor'
import { ExitCode } from '../src/errors'
import { countInjectedBlocks, injectScriptBlock, removeScriptBlocks } from '../src/html'
import { asarPathForRoot, candidateAppRoots, resolveTarget } from '../src/locate'

describe('html injection', () => {
  const html = '<!doctype html>\n<html>\n<HEAD data-x="1">\n<title>x</title>\n</HEAD>\n</html>\n'
  it('inserts as first child of <head>, idempotently, and removes cleanly', () => {
    const once = injectScriptBlock(html)
    expect(once).toContain(
      '<HEAD data-x="1">\n    <!-- mlp:begin --><script src="./mlp/injector.js"></script><!-- mlp:end -->\n<title>'
    )
    const twice = injectScriptBlock(once)
    expect(twice).toBe(once)
    expect(countInjectedBlocks(twice)).toBe(1)
    expect(removeScriptBlocks(twice)).toBe(html)
  })
  it('rejects documents without <head>', () => {
    expect(() => injectScriptBlock('<html><body></body></html>')).toThrow(/no <head>/)
  })
})

describe('locate', () => {
  it('knows the per-OS install locations', () => {
    expect(candidateAppRoots('darwin', {}, '/Users/me')).toEqual([
      '/Applications/Orca.app',
      '/Users/me/Applications/Orca.app'
    ])
    expect(asarPathForRoot('darwin', '/Applications/Orca.app')).toBe(
      '/Applications/Orca.app/Contents/Resources/app.asar'
    )
    const win = candidateAppRoots(
      'win32',
      { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', ProgramFiles: 'C:\\Program Files' },
      'C:\\Users\\me'
    )
    expect(win).toEqual([
      'C:\\Users\\me\\AppData\\Local\\Programs\\orca',
      'C:\\Program Files\\Orca'
    ])
    expect(asarPathForRoot('win32', win[0]!)).toBe(
      'C:\\Users\\me\\AppData\\Local\\Programs\\orca\\resources\\app.asar'
    )
    expect(candidateAppRoots('linux', {}, '/home/me')[0]).toBe('/opt/Orca')
  })

  it('explains AppImages and detects extracted ones', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mlp-locate-'))
    try {
      const ctx = createContext({ platform: 'linux', logger: silentLogger, homeDir: tmp })
      expect(() => resolveTarget(ctx, path.join(tmp, 'orca-linux.AppImage'))).toThrow(
        /--appimage-extract/
      )
      const sq = path.join(tmp, 'squashfs-root')
      fs.mkdirSync(path.join(sq, 'resources'), { recursive: true })
      fs.writeFileSync(path.join(sq, 'resources', 'app.asar'), 'x')
      expect(resolveTarget(ctx, sq)).toMatchObject({
        kind: 'appimage-extracted',
        asarPath: path.join(sq, 'resources', 'app.asar'),
        appRoot: sq
      })
      expect(() => resolveTarget(ctx, path.join(tmp, 'nope'))).toThrow(/No app.asar found/)

      const app = path.join(tmp, 'Orca.app')
      fs.mkdirSync(path.join(app, 'Contents', 'Resources'), { recursive: true })
      fs.writeFileSync(path.join(app, 'Contents', 'Resources', 'app.asar'), 'x')
      expect(resolveTarget({ ...ctx, platform: 'darwin' }, app)).toMatchObject({
        kind: 'macos-app',
        appBundle: app
      })
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('doctor', () => {
  it('finds servers on PATH and the bridge extra dirs, and flags other dirs', () => {
    const files = new Set([
      '/usr/bin/typescript-language-server',
      '/home/me/go/bin/gopls',
      '/home/me/.local/bin/basedpyright-langserver',
      '/usr/bin/node'
    ])
    const report = doctor({
      platform: 'linux',
      env: { PATH: '/usr/bin:/bin' },
      homeDir: '/home/me',
      logger: silentLogger,
      isFile: (p) => files.has(p)
    })
    const byLang = Object.fromEntries(report.entries.map((e) => [e.language, e.found]))
    expect(byLang['TypeScript/JavaScript']).toMatchObject({ searchedByBridge: true })
    expect(byLang['Go']).toMatchObject({ path: '/home/me/go/bin/gopls', searchedByBridge: true })
    expect(byLang['Python']).toMatchObject({ searchedByBridge: false })
    expect(byLang['Rust']).toBeNull()
    expect(report.entries.find((e) => e.language === 'Rust')?.hint).toMatch(/rustup/)
    expect(report.exitCode).toBe(ExitCode.NeedsAction)
  })

  it('honours PATHEXT on Windows', () => {
    const dirs = searchDirs('win32', { Path: 'C:\\tools' }, 'C:\\Users\\me')
    const hit = findExecutable('gopls', dirs, 'win32', { PATHEXT: '.EXE;.CMD' }, (p) =>
      p.toLowerCase().endsWith('c:\\tools\\gopls.exe')
    )
    expect(hit?.path.toLowerCase()).toBe('c:\\tools\\gopls.exe')
  })
})

describe('versions', () => {
  it('PATCHER_VERSION matches package.json', () => {
    const pkg = JSON.parse(
      fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    ) as { version: string }
    expect(PATCHER_VERSION).toBe(pkg.version)
  })
  it('parses the injector banner', () => {
    expect(parseInjectorVersion('/*! @mlp/orca-injector v0.1.0 */\n"use strict"')).toBe('0.1.0')
    expect(parseInjectorVersion('nothing')).toBeNull()
  })
})
