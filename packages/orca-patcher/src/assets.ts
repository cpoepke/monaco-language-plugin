import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { type InjectorAsset, loadInjector as loadInjectorFile } from '@mlp/orca-patch-core'
import { PLUGIN_KEY } from './constants.js'

export { parseInjectorVersion, type InjectorAsset } from '@mlp/orca-patch-core'

/** `<package>/assets` — works from both `src/` (tests) and the bundled `dist/`. */
export function defaultAssetsDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets')
}

export const defaultInjectorPath = (): string => path.join(defaultAssetsDir(), 'injector.js')
export const defaultPluginSource = (): string => path.join(defaultAssetsDir(), 'plugin', PLUGIN_KEY)

export function loadInjector(file: string = defaultInjectorPath()): InjectorAsset {
  return loadInjectorFile(file)
}

export type PluginManifest = { id?: string; publisher?: string; version?: string }

export function readPluginManifest(dir: string): PluginManifest | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'orca-plugin.json'), 'utf8')) as PluginManifest
  } catch {
    return null
  }
}
