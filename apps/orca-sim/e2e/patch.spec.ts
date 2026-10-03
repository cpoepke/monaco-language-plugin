/**
 * The patch step of scripts/build.ts, checked: the real patcher found the Monaco anchor in the
 * rolldown-minified renderer, injected the script tag into an asar-packed copy, restored the
 * original bytes on uninstall, and the extracted patched renderer is what the other specs load.
 */
import fs from 'node:fs'
import path from 'node:path'
import * as asar from '@electron/asar'
import { expect, test } from '@playwright/test'
import { ASAR_PATH, BUILD_REPORT, INSTALLED_PLUGIN_DIR, PATCHED_DIR } from '../harness/paths.ts'

type BuildReport = {
  anchorFiles: string[]
  installAnchorFiles: string[]
  orcaVersion: string | null
  injectorVersion: string
  backupAction: string
  pluginInstalled: boolean
  uninstallAction: string
  sha256: { pristine: string; patched: string; restored: string }
  directIndexMatchesAsar: boolean
  directInjectorMatchesAsar: boolean
}

const report = JSON.parse(fs.readFileSync(BUILD_REPORT, 'utf8')) as BuildReport

test('the patcher finds the Monaco anchor in the rolldown-minified chunks', () => {
  expect(report.anchorFiles.length).toBeGreaterThan(0)
  expect(
    report.anchorFiles.every((f) => /^out\/renderer\/assets\/MonacoEditor-.*\.js$/.test(f))
  ).toBe(true)
  expect(report.installAnchorFiles).toEqual(report.anchorFiles)
})

test('install patches app.asar, uninstall restores the original bytes, install is repeatable', () => {
  expect(report.orcaVersion).toBe('1.4.214')
  expect(report.backupAction).toBe('created')
  expect(report.uninstallAction).toBe('restored')
  expect(report.sha256.restored).toBe(report.sha256.pristine)
  expect(report.sha256.patched).not.toBe(report.sha256.pristine)
  expect(report.directIndexMatchesAsar).toBe(true)
  expect(report.directInjectorMatchesAsar).toBe(true)
  expect(report.pluginInstalled).toBe(true)
  expect(fs.existsSync(path.join(INSTALLED_PLUGIN_DIR, 'orca-plugin.json'))).toBe(true)
  // dist/orca-install is left patched by the final install.
  asar.uncache(ASAR_PATH)
  const installedIndex = asar.extractFile(ASAR_PATH, 'out/renderer/index.html').toString('utf8')
  expect(installedIndex.match(/mlp:begin/g)).toHaveLength(1)
})

test('the patched index.html loads the injector first, before the module bundle', () => {
  const html = fs.readFileSync(path.join(PATCHED_DIR, 'out', 'renderer', 'index.html'), 'utf8')
  const injector = html.indexOf('<script src="./mlp/injector.js"></script>')
  const bundle = html.indexOf('<script type="module"')
  expect(injector).toBeGreaterThan(-1)
  expect(injector).toBeLessThan(bundle)
  expect(html.match(/mlp:begin/g)).toHaveLength(1)
  const shipped = fs.readFileSync(path.join(PATCHED_DIR, 'out', 'renderer', 'mlp', 'injector.js'))
  expect(shipped.subarray(0, 40).toString()).toContain('@mlp/orca-injector v')
})
