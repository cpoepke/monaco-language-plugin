import { loadInjector, readPluginManifest } from './assets.js'
import { backupPaths, readBackupMeta } from './backup.js'
import { type CommonOptions, createContext } from './context.js'
import { ExitCode, type ExitCodeValue } from './errors.js'
import { exists, sha256File } from './fsutil.js'
import { inspectAsar } from './inspect.js'
import { type OrcaTarget, resolveTarget } from './locate.js'
import { installedPluginDir } from './plugin.js'
import { readState } from './state.js'

export type StatusOptions = CommonOptions & {
  /** Injector bundle to compare against (default: the one bundled with this package). */
  injectorPath?: string
}

export type StatusReport = {
  target: OrcaTarget
  orcaVersion: string | null
  patched: boolean
  injectedBlocks: number
  injectorVersion: string | null
  /** Orca version recorded when the patch was applied (in the archive or the patcher state). */
  patchedOrcaVersion: string | null
  /** The patch was applied to a different Orca version than the one installed now. */
  versionChangedSincePatch: boolean
  bundledInjectorVersion: string | null
  backup: { present: boolean; checksumOk: boolean | null; orcaVersion: string | null }
  plugin: { installed: boolean; dir: string; version: string | null }
  /** Human-readable follow-ups; empty when everything is in place. */
  actions: string[]
  exitCode: ExitCodeValue
}

export async function status(options: StatusOptions = {}): Promise<StatusReport> {
  const ctx = createContext(options)
  const target = resolveTarget(ctx, options.app)
  const info = inspectAsar(target.asarPath)
  const patched = info.injectedBlocks > 0
  const record = readState(ctx).installs[target.asarPath] ?? null
  const patchedOrcaVersion = info.versionInfo?.orcaVersion ?? record?.orcaVersion ?? null
  const versionChangedSincePatch =
    patchedOrcaVersion != null &&
    info.orcaVersion != null &&
    patchedOrcaVersion !== info.orcaVersion

  let bundledInjectorVersion: string | null = null
  try {
    bundledInjectorVersion = loadInjector(options.injectorPath).version
  } catch {
    bundledInjectorVersion = null
  }

  const { backup } = backupPaths(target.asarPath)
  const meta = readBackupMeta(target.asarPath)
  const backupPresent = exists(backup)
  const checksumOk = backupPresent && meta ? (await sha256File(backup)) === meta.sha256 : null

  const pluginDir = installedPluginDir(ctx)
  const manifest = readPluginManifest(pluginDir)

  const actions: string[] = []
  if (!patched) {
    actions.push(
      versionChangedSincePatch
        ? `Orca was updated (${patchedOrcaVersion} → ${info.orcaVersion}) and the update removed the patch. Run \`monaco-lsp-orca install\` again.`
        : 'Orca is not patched. Run `monaco-lsp-orca install`.'
    )
  } else {
    if (info.injectedBlocks > 1)
      actions.push('index.html contains the injection more than once; re-run install.')
    if (versionChangedSincePatch) {
      actions.push(
        `The patch was applied to Orca ${patchedOrcaVersion} but Orca ${info.orcaVersion} is installed. Re-run install.`
      )
    }
    const installed = info.versionInfo?.injectorVersion ?? null
    if (bundledInjectorVersion && installed && installed !== bundledInjectorVersion) {
      actions.push(
        `Injector ${installed} is installed, ${bundledInjectorVersion} is available. Re-run install to update.`
      )
    }
  }
  if (checksumOk === false) actions.push(`Backup ${backup} does not match its checksum.`)
  if (!manifest) {
    actions.push(`Plugin folder not installed at ${pluginDir}. Run \`monaco-lsp-orca install\`.`)
  }

  return {
    target,
    orcaVersion: info.orcaVersion,
    patched,
    injectedBlocks: info.injectedBlocks,
    injectorVersion: info.versionInfo?.injectorVersion ?? null,
    patchedOrcaVersion,
    versionChangedSincePatch,
    bundledInjectorVersion,
    backup: { present: backupPresent, checksumOk, orcaVersion: meta?.orcaVersion ?? null },
    plugin: { installed: manifest != null, dir: pluginDir, version: manifest?.version ?? null },
    actions,
    exitCode: actions.length === 0 ? ExitCode.Ok : ExitCode.NeedsAction
  }
}

export function formatStatus(report: StatusReport): string {
  const yes = (v: boolean): string => (v ? 'yes' : 'no')
  const lines = [
    `Orca:            ${report.target.asarPath}`,
    `Orca version:    ${report.orcaVersion ?? 'unknown'}`,
    `Patched:         ${yes(report.patched)}${report.patched ? ` (injector ${report.injectorVersion ?? '?'})` : ''}`,
    `Patched for:     ${report.patchedOrcaVersion ?? '-'}${report.versionChangedSincePatch ? '  (differs from installed version!)' : ''}`,
    `Backup:          ${report.backup.present ? `yes (Orca ${report.backup.orcaVersion ?? '?'}, checksum ${report.backup.checksumOk === false ? 'MISMATCH' : 'ok'})` : 'no'}`,
    `Plugin folder:   ${report.plugin.installed ? `${report.plugin.dir} (v${report.plugin.version ?? '?'})` : 'not installed'}`
  ]
  if (report.actions.length > 0) {
    lines.push('', 'Needs action:', ...report.actions.map((a) => `  - ${a}`))
  } else {
    lines.push('', 'All good.')
  }
  return lines.join('\n')
}
