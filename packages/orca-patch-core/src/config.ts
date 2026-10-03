import path from 'node:path'
import { CONFIG_FILENAME, HOME_DIRNAME, HOME_ENV } from './constants.js'
import { readJson, writeJsonAtomic } from './fsutil.js'

/**
 * `~/.monaco-lsp-orca/config.json`, shared by the CLI (writes it on install/uninstall) and the
 * plugin's self-repair (reads it).
 */
export type UserConfig = {
  /** Re-apply the patch automatically after Orca updates (plugin self-repair). */
  autoRepair: boolean
  /** macOS: ad-hoc re-sign Orca.app after patching. */
  resign: boolean
}

export const DEFAULT_CONFIG: UserConfig = { autoRepair: true, resign: true }

/** The patcher home: `$MONACO_LSP_ORCA_HOME` or `<home>/.monaco-lsp-orca`. */
export function patcherHome(
  env: Readonly<Record<string, string | undefined>>,
  homeDir: string
): string {
  return env[HOME_ENV] || path.join(homeDir, HOME_DIRNAME)
}

export const configPath = (stateDir: string): string => path.join(stateDir, CONFIG_FILENAME)

/** Missing or unreadable file → defaults; unknown/invalid fields fall back field by field. */
export function readUserConfig(stateDir: string): UserConfig & { exists: boolean } {
  const raw = readJson<Record<string, unknown>>(configPath(stateDir))
  const record = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null
  const bool = (key: keyof UserConfig): boolean =>
    typeof record?.[key] === 'boolean' ? (record[key] as boolean) : DEFAULT_CONFIG[key]
  return { autoRepair: bool('autoRepair'), resign: bool('resign'), exists: record !== null }
}

/** Merge `changes` into the file (other keys are kept) and return the effective config. */
export function writeUserConfig(stateDir: string, changes: Partial<UserConfig>): UserConfig {
  const file = configPath(stateDir)
  const existing = readJson<Record<string, unknown>>(file)
  const base = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {}
  const { exists: _exists, ...current } = readUserConfig(stateDir)
  const next = { ...base, ...current, ...changes }
  writeJsonAtomic(file, next)
  return { autoRepair: next.autoRepair, resign: next.resign }
}
