import { bridgeBinDirs, defaultExtraBinDirs, resolveExecutable } from './executable-resolver'
import { LSP_SERVER_CATALOG } from './server-catalog'
import { defaultServerProbe, type ServerProbe } from './server-probe'

export type { ProbeResult, ServerProbe } from './server-probe'

/** ok: found and its version command works; missing: not found; broken: found but the probe failed. */
export type ServerStatus = 'ok' | 'missing' | 'broken'

export type ServerDiagnosis = {
  /** Catalog language ids this server handles (e.g. ['typescript', 'javascript']). */
  languages: string[]
  serverId: string
  command: string
  status: ServerStatus
  /** Absolute path of the binary (ok and broken). */
  path?: string
  /** First line of the probe's output (ok; only when the server has a probe). */
  version?: string
  /** Why the probe failed, including the first stderr/stdout line (broken). */
  reason?: string
}

export type DiagnoseOptions = {
  /** Replaces process.env.PATH. */
  pathEnv?: string
  /** Searched after PATH. Defaults to what the bridge itself adds (~/go/bin, ~/.cargo/bin, bridge bins). */
  extraDirs?: readonly string[]
  /** Path flavour and PATHEXT rules to apply; defaults to the host. */
  platform?: NodeJS.Platform
  pathExt?: string
  /** Replaces the stat + X_OK check (tests). */
  isExecutable?: (candidate: string, platform: NodeJS.Platform) => boolean
  /** Replaces the cached version-command probe; `false` skips probing. */
  probe?: ServerProbe | false
}

/**
 * Looks up every catalog server the way the bridge does (same catalog, resolver and probe) and
 * reports each candidate instead of only the first working one. Used by `monaco-lsp-orca doctor`.
 */
export function diagnoseServers(options: DiagnoseOptions = {}): ServerDiagnosis[] {
  const probe = options.probe === undefined ? defaultServerProbe : options.probe
  const extraDirs = options.extraDirs ?? [...defaultExtraBinDirs(), ...bridgeBinDirs()]
  const out: ServerDiagnosis[] = []
  for (const entry of LSP_SERVER_CATALOG) {
    for (const descriptor of entry.candidates) {
      const base = {
        languages: [...entry.languages],
        serverId: descriptor.serverId,
        command: descriptor.command
      }
      const executablePath = resolveExecutable(descriptor.command, {
        extraDirs,
        ...(options.pathEnv !== undefined ? { pathEnv: options.pathEnv } : {}),
        ...(options.platform !== undefined ? { platform: options.platform } : {}),
        ...(options.pathExt !== undefined ? { pathExt: options.pathExt } : {}),
        ...(options.isExecutable ? { isExecutable: options.isExecutable } : {})
      })
      if (!executablePath) {
        out.push({ ...base, status: 'missing' })
        continue
      }
      if (!probe || !descriptor.probeArgs) {
        out.push({ ...base, status: 'ok', path: executablePath })
        continue
      }
      const verdict = probe(executablePath, descriptor.probeArgs)
      out.push(
        verdict.ok
          ? {
              ...base,
              status: 'ok',
              path: executablePath,
              ...(verdict.version ? { version: verdict.version } : {})
            }
          : { ...base, status: 'broken', path: executablePath, reason: verdict.reason }
      )
    }
  }
  return out
}
