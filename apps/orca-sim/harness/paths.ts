import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const SIM_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const REPO_ROOT = path.resolve(SIM_DIR, '..', '..')
export const FIXTURES_DIR = path.join(REPO_ROOT, 'fixtures')
export const DIST_DIR = path.join(SIM_DIR, 'dist')

/** Unpatched build, laid out like the inside of Orca's app.asar (package.json, out/…). */
export const APP_DIR = path.join(DIST_DIR, 'app')
/** A fake Linux install (`resources/app.asar`) the patcher's install/uninstall runs against. */
export const INSTALL_DIR = path.join(DIST_DIR, 'orca-install')
export const ASAR_PATH = path.join(INSTALL_DIR, 'resources', 'app.asar')
/** The patcher's home (state + the plugin folder it installs). */
export const PATCHER_HOME = path.join(DIST_DIR, 'patcher-home')
/** Renderer patched in place with the patcher's exported HTML/anchor functions. */
export const DIRECT_DIR = path.join(DIST_DIR, 'direct')
/** The patched app.asar, extracted: what the e2e tests load (like Orca's loadFile). */
export const PATCHED_DIR = path.join(DIST_DIR, 'patched')
export const PATCHED_INDEX = path.join(PATCHED_DIR, 'out', 'renderer', 'index.html')
/** Plugin folder installed by the patcher (what a user points Orca's "Install plugin" at). */
export const INSTALLED_PLUGIN_DIR = path.join(PATCHER_HOME, 'plugin', 'cpoepke.monaco-lsp')
/** Summary written by the build script, asserted by e2e/patch.spec.ts. */
export const BUILD_REPORT = path.join(DIST_DIR, 'build-report.json')

export const PLUGIN_KEY = 'cpoepke.monaco-lsp'
/** The Orca version the fake app.asar claims (Orca main at the time of the spikes). */
export const SIM_ORCA_VERSION = '1.4.214'
/** An unpatched app.asar of the same renderer claiming a newer version: what an Orca auto-update
 *  leaves behind (e2e/auto-repair.spec.ts). */
export const UPDATE_ASAR = path.join(DIST_DIR, 'app.update.asar')
export const UPDATE_ORCA_VERSION = '1.4.215'

export const LSP_BRIDGE_BIN = path.join(REPO_ROOT, 'packages', 'lsp-bridge', 'node_modules', '.bin')
