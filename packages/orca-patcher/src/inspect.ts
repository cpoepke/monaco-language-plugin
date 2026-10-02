import { readAsarFile } from './asar.js'
import { RENDERER_INDEX, VERSION_ASAR_PATH } from './constants.js'
import { countInjectedBlocks } from './html.js'

export type InjectedVersionInfo = {
  injectorVersion: string
  orcaVersion: string | null
  patcherVersion?: string
  patchedAt?: string
}

export type AsarInspection = {
  orcaVersion: string | null
  hasIndexHtml: boolean
  /** Number of injected marker blocks in out/renderer/index.html. */
  injectedBlocks: number
  versionInfo: InjectedVersionInfo | null
}

export function readOrcaVersion(asarPath: string): string | null {
  const buf = readAsarFile(asarPath, 'package.json')
  if (!buf) return null
  try {
    const pkg = JSON.parse(buf.toString('utf8')) as { version?: unknown }
    return typeof pkg.version === 'string' ? pkg.version : null
  } catch {
    return null
  }
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
