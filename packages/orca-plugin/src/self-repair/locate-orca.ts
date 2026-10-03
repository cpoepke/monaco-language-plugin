import path from 'node:path'

/**
 * The Orca install running this worker, derived from `process.execPath`.
 *
 * Why execPath: Orca forks plugin workers from its main process with `fork()` and
 * ELECTRON_RUN_AS_NODE (src/main/plugins/plugin-host-process.ts passes no `execPath`), so the
 * worker's executable is Orca's own binary:
 *  - macOS:   <X>.app/Contents/MacOS/<bin>  → <X>.app/Contents/Resources/app.asar
 *  - Windows: <dir>\Orca.exe                → <dir>\resources\app.asar
 *  - Linux:   <dir>/orca-ide                → <dir>/resources/app.asar
 *             (an AppImage runs from a read-only mount such as /tmp/.mount_OrcaXXXX)
 */
export type OrcaInstall = {
  asarPath: string
  resourcesDir: string
  /** What `monaco-lsp-orca install --app` takes: the .app bundle or the install dir. */
  appRoot: string
  /** macOS only: the bundle to re-sign. */
  appBundle: string | null
  /** Running from a mounted (read-only) AppImage. */
  appImage: boolean
}

/** Env var standing in for `process.execPath` (tests and the Orca simulation; Orca strips it). */
export const EXEC_PATH_OVERRIDE_ENV = 'MLP_ORCA_EXEC_PATH'

/** `C:\…`, `C:/…` or a UNC `\\server\share…` path. */
const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\)/

export function orcaInstallFromExecPath(
  execPath: string,
  platform: NodeJS.Platform
): OrcaInstall | null {
  // Why the path's shape and not `platform`: execPath is a real path on this host, while
  // `platform` decides only the layout (macOS bundle, AppImage mount), which tests vary freely.
  const p = WINDOWS_ABSOLUTE.test(execPath) ? path.win32 : path.posix
  if (!execPath || !p.isAbsolute(execPath)) return null
  const binDir = p.dirname(execPath)
  if (platform === 'darwin') {
    const contents = p.dirname(binDir)
    const bundle = p.dirname(contents)
    if (
      p.basename(binDir) !== 'MacOS' ||
      p.basename(contents) !== 'Contents' ||
      !bundle.endsWith('.app')
    ) {
      return null
    }
    const resourcesDir = p.join(contents, 'Resources')
    return {
      asarPath: p.join(resourcesDir, 'app.asar'),
      resourcesDir,
      appRoot: bundle,
      appBundle: bundle,
      appImage: false
    }
  }
  const resourcesDir = p.join(binDir, 'resources')
  return {
    asarPath: p.join(resourcesDir, 'app.asar'),
    resourcesDir,
    appRoot: binDir,
    appBundle: null,
    appImage: platform === 'linux' && /(^|[\\/])\.mount_[^\\/]+([\\/]|$)/.test(binDir)
  }
}
