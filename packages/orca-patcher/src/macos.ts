import path from 'node:path'
import type { Context } from './context.js'
import { PatcherError } from './errors.js'

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
  '    To fully revert, reinstall Orca from the official download.'
].join('\n')

/** Ad-hoc re-sign the bundle so the modified resources do not break the signature seal. */
export async function adHocSign(ctx: Context, appBundle: string): Promise<void> {
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

/**
 * Electron's asar integrity check (`ElectronAsarIntegrity` in Info.plist + the
 * EnableEmbeddedAsarIntegrityValidation fuse) would reject a modified app.asar. Orca does not enable
 * the fuse today; we only touch Info.plist when the user passes --fix-integrity.
 */
export async function handleAsarIntegrity(
  ctx: Context,
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
