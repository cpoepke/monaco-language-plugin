import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PLUGIN_KEY } from './constants.js'
import { PatcherError } from './errors.js'

/** `<package>/assets` — works from both `src/` (tests) and the bundled `dist/`. */
export function defaultAssetsDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets')
}

export const defaultInjectorPath = (): string => path.join(defaultAssetsDir(), 'injector.js')
export const defaultPluginSource = (): string => path.join(defaultAssetsDir(), 'plugin', PLUGIN_KEY)

/** The injector bundle starts with `/*! @mlp/orca-injector v<version> *\/`. */
export function parseInjectorVersion(source: string): string | null {
  return /@mlp\/orca-injector v([0-9A-Za-z.+-]+)/.exec(source.slice(0, 500))?.[1] ?? null
}

export type InjectorAsset = { path: string; source: Buffer; version: string }

export function loadInjector(file: string = defaultInjectorPath()): InjectorAsset {
  let source: Buffer
  try {
    source = fs.readFileSync(file)
  } catch {
    throw new PatcherError(
      `Injector bundle not found at ${file}. Build it first: pnpm --filter @mlp/orca-injector build ` +
        '&& pnpm --filter monaco-lsp-orca build'
    )
  }
  return { path: file, source, version: parseInjectorVersion(source.toString('utf8')) ?? 'unknown' }
}

export type PluginManifest = { id?: string; publisher?: string; version?: string }

export function readPluginManifest(dir: string): PluginManifest | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'orca-plugin.json'), 'utf8')) as PluginManifest
  } catch {
    return null
  }
}
