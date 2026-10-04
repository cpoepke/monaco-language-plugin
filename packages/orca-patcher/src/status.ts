import {
  backupPaths,
  configPath,
  exists,
  ExitCode,
  type ExitCodeValue,
  inspectAsar,
  readBackupMeta,
  readEntries,
  readPending,
  readUserConfig,
  sha256File,
  type SignatureCheck,
  verifyCodeSignature
} from '@mlp/orca-patch-core'
import { loadInjector, readPluginManifest } from './assets.js'
import { type CommonOptions, createContext } from './context.js'
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
  /** Settings from ~/.monaco-lsp-orca/config.json (defaults when the file is missing). */
  config: { path: string; exists: boolean; autoRepair: boolean; resign: boolean }
  /** Who applied the current patch (`monaco-lsp-orca` or the plugin's self-repair). */
  patchedBy: string | null
  /** A patched archive waiting for Orca to quit (Windows self-repair). */
  pending: { orcaVersion: string | null; injectorVersion: string; createdAt: string } | null
  /** macOS only: `codesign --verify --deep --strict` of the app bundle (best effort). */
  signature: SignatureCheck | null
  /** Human-readable follow-ups; empty when everything is in place. */
  actions: string[]
  exitCode: ExitCodeValue
}

export async function status(options: StatusOptions = {}): Promise<StatusReport> {
  const ctx = createContext(options)
  const target = resolveTarget(ctx, options.app)
  const info = inspectAsar(target.asarPath)
  // Why: inspectAsar answers "unknown version, not patched" for a truncated or damaged archive;
  // say so instead of suggesting `install`, which would fail on it.
  let damaged: string | null = null
  try {
    readEntries(target.asarPath)
  } catch (error) {
    damaged = error instanceof Error ? error.message : String(error)
  }
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
  const config = readUserConfig(ctx.stateDir)
  const pending = readPending(target.asarPath)
  const signature =
    target.appBundle && ctx.platform === 'darwin'
      ? await verifyCodeSignature(ctx, target.appBundle)
      : null

  const actions: string[] = []
  if (damaged) {
    actions.push(damaged)
  } else if (!patched && pending) {
    actions.push(
      'The Orca plugin re-patched Orca; the change is applied when you quit Orca. Restart Orca to activate it.'
    )
  } else if (!patched) {
    actions.push(
      versionChangedSincePatch && config.autoRepair
        ? `Orca was updated (${patchedOrcaVersion} → ${info.orcaVersion}) and the update removed the patch. Start Orca: the plugin re-applies it (or run \`monaco-lsp-orca install\` now).`
        : versionChangedSincePatch
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
    config: {
      path: configPath(ctx.stateDir),
      exists: config.exists,
      autoRepair: config.autoRepair,
      resign: config.resign
    },
    patchedBy: info.versionInfo?.patchedBy ?? null,
    pending: pending
      ? {
          orcaVersion: pending.orcaVersion,
          injectorVersion: pending.injectorVersion,
          createdAt: pending.createdAt
        }
      : null,
    signature,
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
    `Plugin folder:   ${report.plugin.installed ? `${report.plugin.dir} (v${report.plugin.version ?? '?'})` : 'not installed'}`,
    `Auto-repair:     ${report.config.autoRepair ? 'on (the Orca plugin re-applies the patch after updates)' : 'off'}`
  ]
  if (report.patchedBy) lines.splice(3, 0, `Patched by:      ${report.patchedBy}`)
  if (report.pending) {
    lines.push(
      `Pending:         patched archive for Orca ${report.pending.orcaVersion ?? '?'} waits for Orca to quit`
    )
  }
  if (report.signature) {
    const verdict =
      report.signature.valid === true
        ? 'valid'
        : report.signature.valid === false
          ? 'INVALID'
          : 'unknown'
    lines.push(
      `Signing mode:    ${report.config.resign ? 'ad-hoc re-sign after patching' : 'keep the original signature (--no-resign)'}`,
      `codesign:        ${verdict} (${report.signature.detail})`
    )
  }
  if (report.actions.length > 0) {
    lines.push('', 'Needs action:', ...report.actions.map((a) => `  - ${a}`))
  } else {
    lines.push('', 'All good.')
  }
  return lines.join('\n')
}
