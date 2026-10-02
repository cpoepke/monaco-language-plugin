import fs from 'node:fs'
import path from 'node:path'
import { readPluginManifest } from './assets.js'
import { PLUGIN_KEY } from './constants.js'
import type { Context } from './context.js'
import { replaceDir } from './fsutil.js'

export const installedPluginDir = (ctx: Context): string =>
  path.join(ctx.stateDir, 'plugin', PLUGIN_KEY)

export type PluginInstallResult =
  | { installed: true; dir: string; version: string | null }
  | { installed: false; reason: string }

/** Copy the bundled plugin folder to `<stateDir>/plugin/cpoepke.monaco-lsp/` (replacing it). */
export function installPluginFolder(ctx: Context, source: string): PluginInstallResult {
  const manifest = readPluginManifest(source)
  if (!fs.existsSync(source) || !manifest) {
    return {
      installed: false,
      reason:
        `plugin bundle not found at ${source} (missing orca-plugin.json). ` +
        'Build packages/orca-plugin, then rebuild monaco-lsp-orca.'
    }
  }
  const dir = installedPluginDir(ctx)
  replaceDir(source, dir)
  return { installed: true, dir, version: manifest.version ?? null }
}

export function pluginInstructions(dir: string): string {
  return [
    'Load the companion plugin in Orca (one time):',
    '  1. Orca → Settings → Plugins: turn on "Plugin system" (experimental).',
    `  2. Click "Install plugin" → "Local folder" and choose:\n       ${dir}`,
    '     (alternative for development: under "Development" use "Add path" with the same folder)',
    `  3. Find "${PLUGIN_KEY}" in the list, click "Review & enable", then "Enable plugin".`,
    '  4. Restart Orca (or reload the window) and open a TypeScript/Python/Go/Rust file.',
    'Language servers are not bundled; run `monaco-lsp-orca doctor` to see what is missing.'
  ].join('\n')
}
