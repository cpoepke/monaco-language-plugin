/**
 * Builds the simulated Orca renderer and patches it with the real patcher:
 *
 * 1. `pnpm -w run build` (the shipped packages; skip with ORCA_SIM_SKIP_PACKAGES_BUILD=1).
 * 2. `vite build` (rolldown-vite 7.3.1, Orca's renderer options) → dist/app/out/renderer, plus a
 *    package.json and out/main stub so dist/app looks like the inside of Orca's app.asar.
 * 3. Direct patch with the patcher's exported functions → dist/direct: `findAnchorFiles` must find
 *    the Monaco globalAPI anchor in the rolldown-minified chunks, `injectScriptBlock` inserts the
 *    script tag, the bundled injector goes to out/renderer/mlp/injector.js.
 * 4. Full asar path: pack dist/app into dist/orca-install/resources/app.asar (and a "1.4.215"
 *    copy, dist/app.update.asar, standing in for an Orca update), run the patcher's
 *    `install` (backup, repack, verify, plugin folder), extract the patched archive to
 *    dist/patched (what the e2e tests load), run `uninstall` and check the original bytes are
 *    back, then `install` again so dist/orca-install stays patched for inspection.
 *
 * Run with plain Node 22 (type stripping): `node scripts/build.ts`.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import * as asar from '@electron/asar'
import {
  findAnchorFiles,
  injectScriptBlock,
  install,
  INJECTOR_ASAR_PATH,
  RENDERER_INDEX,
  uninstall,
  type Logger
} from 'monaco-lsp-orca'
import { build } from 'vite'
import {
  APP_DIR,
  ASAR_PATH,
  BUILD_REPORT,
  DIRECT_DIR,
  DIST_DIR,
  INSTALL_DIR,
  INSTALLED_PLUGIN_DIR,
  PATCHED_DIR,
  PATCHER_HOME,
  REPO_ROOT,
  SIM_DIR,
  SIM_ORCA_VERSION,
  UPDATE_ASAR,
  UPDATE_ORCA_VERSION
} from '../harness/paths.ts'

const started = Date.now()
const step = (message: string): void => {
  console.log(`[orca-sim] ${message} (+${((Date.now() - started) / 1000).toFixed(1)}s)`)
}
const sha256 = (file: string): string =>
  createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const fail = (message: string): never => {
  console.error(`[orca-sim] ${message}`)
  process.exit(1)
}

const patcherLog: string[] = []
const logger: Logger = {
  info: (m) => patcherLog.push(`info: ${m}`),
  warn: (m) => patcherLog.push(`warn: ${m}`),
  error: (m) => patcherLog.push(`error: ${m}`)
}

// 1. Shipped packages.
if (process.env.ORCA_SIM_SKIP_PACKAGES_BUILD !== '1') {
  step('building packages (pnpm -w run build)')
  execFileSync('pnpm', ['-w', 'run', 'build'], { cwd: REPO_ROOT, stdio: 'inherit' })
}
const bundledInjector = path.join(REPO_ROOT, 'packages', 'orca-patcher', 'assets', 'injector.js')
const bundledPlugin = path.join(
  REPO_ROOT,
  'packages',
  'orca-patcher',
  'assets',
  'plugin',
  'cpoepke.monaco-lsp'
)
if (
  !fs.existsSync(bundledInjector) ||
  !fs.existsSync(path.join(bundledPlugin, 'dist', 'main.mjs'))
) {
  fail('packages/orca-patcher/assets is incomplete; run `pnpm build` at the repository root')
}

// 2. Renderer.
step('vite build (rolldown-vite, Orca renderer options)')
fs.rmSync(DIST_DIR, { recursive: true, force: true })
await build({ configFile: path.join(SIM_DIR, 'vite.config.ts'), mode: 'production' })
fs.writeFileSync(
  path.join(APP_DIR, 'package.json'),
  `${JSON.stringify({ name: 'orca', version: SIM_ORCA_VERSION, main: './out/main/index.js' }, null, 2)}\n`
)
fs.mkdirSync(path.join(APP_DIR, 'out', 'main'), { recursive: true })
fs.writeFileSync(
  path.join(APP_DIR, 'out', 'main', 'index.js'),
  '// orca-sim: main is simulated by the Playwright harness\n'
)

// 3. Direct patch with the exported functions.
step('direct patch (findAnchorFiles + injectScriptBlock)')
fs.cpSync(APP_DIR, DIRECT_DIR, { recursive: true })
const anchorFiles = findAnchorFiles(DIRECT_DIR)
if (anchorFiles.length === 0) fail('Monaco globalAPI anchor not found in the rolldown output')
const directIndex = path.join(DIRECT_DIR, ...RENDERER_INDEX.split('/'))
fs.writeFileSync(directIndex, injectScriptBlock(fs.readFileSync(directIndex, 'utf8')))
const directInjector = path.join(DIRECT_DIR, ...INJECTOR_ASAR_PATH.split('/'))
fs.mkdirSync(path.dirname(directInjector), { recursive: true })
fs.copyFileSync(bundledInjector, directInjector)

// 4. app.asar → install → extract → uninstall → install.
step('packing app.asar')
fs.mkdirSync(path.dirname(ASAR_PATH), { recursive: true })
await asar.createPackage(APP_DIR, ASAR_PATH)
asar.uncache(ASAR_PATH)
const pristineSha = sha256(ASAR_PATH)
// What an Orca auto-update leaves behind: the same renderer, a newer version, no patch.
const appPackageJson = path.join(APP_DIR, 'package.json')
const appPackage = fs.readFileSync(appPackageJson, 'utf8')
fs.writeFileSync(appPackageJson, appPackage.replace(SIM_ORCA_VERSION, UPDATE_ORCA_VERSION))
await asar.createPackage(APP_DIR, UPDATE_ASAR)
fs.writeFileSync(appPackageJson, appPackage)
const common = { app: INSTALL_DIR, stateDir: PATCHER_HOME, logger, force: true }

step('monaco-lsp-orca install')
const installed = await install(common)
asar.uncache(ASAR_PATH)
const patchedSha = sha256(ASAR_PATH)
if (patchedSha === pristineSha) fail('install did not change app.asar')
fs.rmSync(PATCHED_DIR, { recursive: true, force: true })
asar.extractAll(ASAR_PATH, PATCHED_DIR)
const patchedSnapshot = path.join(DIST_DIR, 'app.patched.asar')
fs.copyFileSync(ASAR_PATH, patchedSnapshot)

step('monaco-lsp-orca uninstall')
const removed = await uninstall(common)
asar.uncache(ASAR_PATH)
const restoredSha = sha256(ASAR_PATH)
if (restoredSha !== pristineSha) fail('uninstall did not restore the original app.asar bytes')

step('monaco-lsp-orca install (again, idempotent)')
const reinstalled = await install(common)
asar.uncache(ASAR_PATH)

const patchedIndexHtml = fs.readFileSync(
  path.join(PATCHED_DIR, ...RENDERER_INDEX.split('/')),
  'utf8'
)
const report = {
  builtAt: new Date().toISOString(),
  anchorFiles,
  installAnchorFiles: installed.anchorFiles,
  orcaVersion: installed.orcaVersion,
  injectorVersion: installed.injectorVersion,
  backupAction: installed.backupAction,
  pluginInstalled: installed.plugin?.installed === true,
  pluginDir: INSTALLED_PLUGIN_DIR,
  uninstallAction: removed.action,
  reinstallBackupAction: reinstalled.backupAction,
  sha256: { pristine: pristineSha, patched: patchedSha, restored: restoredSha },
  directIndexMatchesAsar: fs.readFileSync(directIndex, 'utf8') === patchedIndexHtml,
  directInjectorMatchesAsar:
    sha256(directInjector) === sha256(path.join(PATCHED_DIR, ...INJECTOR_ASAR_PATH.split('/'))),
  patcherLog
}
fs.writeFileSync(BUILD_REPORT, `${JSON.stringify(report, null, 2)}\n`)
if (!report.directIndexMatchesAsar || !report.directInjectorMatchesAsar) {
  fail('direct patch and asar install produced different renderers')
}
if (
  !report.pluginInstalled ||
  !fs.existsSync(path.join(INSTALLED_PLUGIN_DIR, 'dist', 'main.mjs'))
) {
  fail('the patcher did not install the plugin folder')
}
step(`done: anchor in ${anchorFiles.join(', ')}; e2e loads ${path.relative(SIM_DIR, PATCHED_DIR)}`)
