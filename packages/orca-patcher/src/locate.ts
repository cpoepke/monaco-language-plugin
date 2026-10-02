import fs from 'node:fs'
import path from 'node:path'
import type { Context } from './context.js'
import { PatcherError } from './errors.js'

export type OrcaTargetKind = 'macos-app' | 'windows' | 'linux' | 'appimage-extracted' | 'custom'

export type OrcaTarget = {
  kind: OrcaTargetKind
  /** Absolute path of app.asar. */
  asarPath: string
  /** Directory that holds app.asar (and app.asar.unpacked). */
  resourcesDir: string
  /** Directory that contains the running executable: the .app bundle on macOS, else the install dir. */
  appRoot: string
  /** macOS only: the .app bundle (re-signed after patching). */
  appBundle?: string
}

const pathFor = (platform: NodeJS.Platform): path.PlatformPath =>
  platform === 'win32' ? path.win32 : path.posix

/**
 * Default install roots, per electron-builder config (`productName: 'Orca'`, package name `orca`,
 * Linux executable `orca-ide`). First existing one wins.
 *  - macOS: dmg/zip → /Applications/Orca.app (or ~/Applications).
 *  - Windows: NSIS one-click per-user installs into %LOCALAPPDATA%\Programs\<sanitized name = orca>;
 *    per-machine installs use %ProgramFiles%\Orca.
 *  - Linux: deb/rpm (fpm) install into /opt/<productName> = /opt/Orca. AppImage is read-only and must
 *    be extracted first (see APPIMAGE_HELP).
 */
export function candidateAppRoots(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  homeDir: string
): string[] {
  const p = pathFor(platform)
  switch (platform) {
    case 'darwin':
      return ['/Applications/Orca.app', p.join(homeDir, 'Applications', 'Orca.app')]
    case 'win32': {
      const localAppData = env.LOCALAPPDATA ?? p.join(homeDir, 'AppData', 'Local')
      const programFiles = env.ProgramFiles ?? 'C:\\Program Files'
      return [
        p.join(localAppData, 'Programs', 'orca'),
        p.join(localAppData, 'Programs', 'Orca'),
        p.join(programFiles, 'Orca')
      ].filter((v, i, all) => all.findIndex((o) => o.toLowerCase() === v.toLowerCase()) === i)
    }
    default:
      return ['/opt/Orca', '/opt/orca', '/opt/orca-ide', '/usr/lib/orca-ide', '/usr/lib/orca']
  }
}

/** app.asar location for an install root. */
export function asarPathForRoot(platform: NodeJS.Platform, root: string): string {
  const p = pathFor(platform)
  return root.endsWith('.app')
    ? p.join(root, 'Contents', 'Resources', 'app.asar')
    : p.join(root, 'resources', 'app.asar')
}

export const APPIMAGE_HELP = [
  'Orca AppImages are read-only squashfs images and cannot be patched in place. Extract it first:',
  '  ./orca-linux.AppImage --appimage-extract      # creates ./squashfs-root',
  '  mv squashfs-root ~/.local/opt/orca             # optional: move it somewhere permanent',
  '  monaco-lsp-orca install --app ~/.local/opt/orca',
  'Then start Orca with ~/.local/opt/orca/AppRun (update your launcher/.desktop entry accordingly).',
  'Note: AppImage auto-updates download a fresh, unpatched image; re-extract and re-run install after updating.'
].join('\n')

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

function targetFromAsar(platform: NodeJS.Platform, asarPath: string): OrcaTarget {
  const p = pathFor(platform)
  const resourcesDir = p.dirname(asarPath)
  const parent = p.dirname(resourcesDir)
  if (p.basename(resourcesDir) === 'Resources' && p.basename(parent) === 'Contents') {
    const appBundle = p.dirname(parent)
    return { kind: 'macos-app', asarPath, resourcesDir, appRoot: appBundle, appBundle }
  }
  const appRoot = parent
  if (p.basename(appRoot) === 'squashfs-root' || fs.existsSync(p.join(appRoot, 'AppRun'))) {
    return { kind: 'appimage-extracted', asarPath, resourcesDir, appRoot }
  }
  const kind: OrcaTargetKind =
    platform === 'win32' ? 'windows' : platform === 'linux' ? 'linux' : 'custom'
  return { kind, asarPath, resourcesDir, appRoot }
}

/** Resolve the Orca installation to operate on (explicit `--app` or the per-OS defaults). */
export function resolveTarget(ctx: Context, app?: string): OrcaTarget {
  const p = pathFor(ctx.platform)
  if (app) {
    const abs = p.resolve(app)
    if (/\.appimage$/i.test(abs)) {
      throw new PatcherError(`${abs} is an AppImage.\n${APPIMAGE_HELP}`)
    }
    const candidates = abs.endsWith('.asar')
      ? [abs]
      : [
          p.join(abs, 'Contents', 'Resources', 'app.asar'),
          p.join(abs, 'resources', 'app.asar'),
          p.join(abs, 'app.asar')
        ]
    const found = candidates.find(isFile)
    if (!found) {
      throw new PatcherError(
        `No app.asar found for --app ${abs}. Expected one of:\n  ${candidates.join('\n  ')}`
      )
    }
    return targetFromAsar(ctx.platform, found)
  }
  const roots = candidateAppRoots(ctx.platform, ctx.env, ctx.homeDir)
  for (const root of roots) {
    const asarPath = asarPathForRoot(ctx.platform, root)
    if (isFile(asarPath)) return targetFromAsar(ctx.platform, asarPath)
  }
  const searched = roots.map((r) => `  ${asarPathForRoot(ctx.platform, r)}`).join('\n')
  const hint =
    ctx.platform === 'linux'
      ? `\n\nIf you run Orca as an AppImage:\n${APPIMAGE_HELP}`
      : '\n\nPass --app <path to Orca> if it is installed elsewhere.'
  throw new PatcherError(`Could not find an Orca installation. Searched:\n${searched}${hint}`)
}
