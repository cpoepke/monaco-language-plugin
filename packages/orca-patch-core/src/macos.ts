import path from 'node:path'
import { PatcherError } from './errors.js'
import type { CommandRunner, Logger } from './logger.js'

/** What the macOS helpers need: a command runner and somewhere to log. */
export type MacContext = { runCommand: CommandRunner; logger: Logger }

export const GATEKEEPER_NOTE = [
  'macOS: Orca.app was re-signed ad hoc (`codesign --force --deep --sign -`), replacing its',
  'Developer ID signature on the app and every nested helper/framework. What that means:',
  '  - If macOS refuses to open it, right-click Orca.app → Open once, or run:',
  '      xattr -dr com.apple.quarantine /Applications/Orca.app',
  "  - The app's code identity changed (an ad-hoc signature's designated requirement is its cdhash).",
  "    Keychain items bound to Orca's signature (e.g. secrets stored with Electron safeStorage) may",
  '    prompt for access again or stop matching, and macOS privacy (TCC) grants such as Files &',
  '    Folders, Accessibility or Screen Recording may be asked for again.',
  "  - Orca's built-in auto-update may refuse to install updates over an ad-hoc signed app. If an",
  '    update fails, download Orca again from its website, then re-run `monaco-lsp-orca install`.',
  '  - `uninstall` restores the original app.asar but cannot restore the Developer ID signature.',
  '    To fully revert, reinstall Orca from the official download.',
  '  - Prefer to keep the Developer ID signature? Try `monaco-lsp-orca install --no-resign`.'
].join('\n')

export const NO_RESIGN_NOTE = [
  'macOS: Orca.app was NOT re-signed (--no-resign). What that means:',
  '  - Orca keeps its original Developer ID signature, so its code identity is unchanged: keychain',
  '    items and privacy (TCC) grants should keep working, and auto-update will likely keep working.',
  "  - But the signature's resource seal no longer matches the modified app.asar, so",
  '    `codesign --verify` reports it as modified. macOS may refuse to launch it ("Orca is damaged")',
  '    in some situations, for example if the app gets quarantined again (re-downloaded or copied',
  '    from another machine).',
  '  - To recover: run `monaco-lsp-orca install` (re-signs ad hoc) or reinstall Orca from the',
  '    official download.',
  '  - Self-repair after Orca updates also skips re-signing (saved in ~/.monaco-lsp-orca/config.json).',
  '  This mode is new: please report whether launch and auto-update work on your Mac.'
].join('\n')

export const signingNote = (resign: boolean): string => (resign ? GATEKEEPER_NOTE : NO_RESIGN_NOTE)

/** Ad-hoc re-sign the bundle so the modified resources do not break the signature seal. */
export async function adHocSign(ctx: MacContext, appBundle: string): Promise<void> {
  const res = await ctx.runCommand('codesign', ['--force', '--deep', '--sign', '-', appBundle])
  if (res.code !== 0) {
    throw new PatcherError(
      `codesign failed (exit ${res.code}): ${res.stderr.trim()}\n` +
        `The app was modified but is not re-signed; it may not launch. Retry with:\n` +
        `  codesign --force --deep --sign - "${appBundle}"\n` +
        'or run `monaco-lsp-orca uninstall` to restore the original app.asar.'
    )
  }
}

export type SignatureCheck = {
  /** true: valid, false: codesign reported a problem, null: could not run codesign. */
  valid: boolean | null
  /** codesign's own words (first lines of stderr), for display. */
  detail: string
}

/** Best effort `codesign --verify --deep --strict` of the bundle. Never throws. */
export async function verifyCodeSignature(
  ctx: MacContext,
  appBundle: string
): Promise<SignatureCheck> {
  try {
    const res = await ctx.runCommand('codesign', ['--verify', '--deep', '--strict', appBundle])
    const detail = res.stderr.trim().split('\n').slice(0, 3).join(' ').slice(0, 300)
    if (res.code === 0) return { valid: true, detail: detail || 'valid on disk' }
    if (res.code === 127) return { valid: null, detail: 'codesign not available' }
    return { valid: false, detail: detail || `codesign exited with ${res.code}` }
  } catch (error) {
    return { valid: null, detail: String(error) }
  }
}

/**
 * Electron's asar integrity check (`ElectronAsarIntegrity` in Info.plist + the
 * EnableEmbeddedAsarIntegrityValidation fuse) would reject a modified app.asar. Orca does not enable
 * the fuse today; we only touch Info.plist when the user passes --fix-integrity.
 */
export async function handleAsarIntegrity(
  ctx: MacContext,
  appBundle: string,
  fix: boolean
): Promise<'absent' | 'removed' | 'present'> {
  const plist = path.join(appBundle, 'Contents', 'Info.plist')
  const probe = await ctx.runCommand('plutil', [
    '-extract',
    'ElectronAsarIntegrity',
    'json',
    '-o',
    '-',
    plist
  ])
  if (probe.code !== 0) return 'absent'
  if (!fix) {
    ctx.logger.warn(
      'Info.plist contains ElectronAsarIntegrity. If Orca refuses to start after patching, re-run ' +
        'install with --fix-integrity to remove the stale hash.'
    )
    return 'present'
  }
  const res = await ctx.runCommand('plutil', ['-remove', 'ElectronAsarIntegrity', plist])
  if (res.code !== 0) {
    throw new PatcherError(`Could not remove ElectronAsarIntegrity from ${plist}: ${res.stderr}`)
  }
  return 'removed'
}
