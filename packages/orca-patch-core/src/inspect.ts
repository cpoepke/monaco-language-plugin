import { readAsarFile } from './asar.js'
import { RENDERER_INDEX, VERSION_ASAR_PATH } from './constants.js'
import { countInjectedBlocks } from './html.js'

export type InjectedVersionInfo = {
  injectorVersion: string
  orcaVersion: string | null
  patcherVersion?: string
  /** Who applied the patch: `monaco-lsp-orca` (CLI) or `cpoepke.monaco-lsp` (plugin self-repair). */
  patchedBy?: string
  patchedAt?: string
}

export type AsarInspection = {
  orcaVersion: string | null
  hasIndexHtml: boolean
  /** Number of injected marker blocks in out/renderer/index.html. */
  injectedBlocks: number
  versionInfo: InjectedVersionInfo | null
}

/** `name` and `version` from the archive's package.json (null fields when unreadable). */
export function readAppPackage(asarPath: string): { name: string | null; version: string | null } {
  const buf = readAsarFile(asarPath, 'package.json')
  if (!buf) return { name: null, version: null }
  try {
    const pkg = JSON.parse(buf.toString('utf8')) as { name?: unknown; version?: unknown }
    return {
      name: typeof pkg.name === 'string' ? pkg.name : null,
      version: typeof pkg.version === 'string' ? pkg.version : null
    }
  } catch {
    return { name: null, version: null }
  }
}

export function readOrcaVersion(asarPath: string): string | null {
  return readAppPackage(asarPath).version
}

export function inspectAsar(asarPath: string): AsarInspection {
  const html = readAsarFile(asarPath, RENDERER_INDEX)
  let versionInfo: InjectedVersionInfo | null = null
  const versionBuf = readAsarFile(asarPath, VERSION_ASAR_PATH)
  if (versionBuf) {
    try {
      versionInfo = JSON.parse(versionBuf.toString('utf8')) as InjectedVersionInfo
    } catch {
      versionInfo = null
    }
  }
  return {
    orcaVersion: readOrcaVersion(asarPath),
    hasIndexHtml: html != null,
    injectedBlocks: html ? countInjectedBlocks(html.toString('utf8')) : 0,
    versionInfo
  }
}
