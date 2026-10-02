import path from 'node:path'

/**
 * Where Orca's `userData` directory (which holds `orca-runtime.json`) may be.
 *
 * Why so many candidates: Orca forks plugin workers with a scrubbed env
 * (`buildPluginWorkerEnv`), so APPDATA, XDG_CONFIG_HOME and
 * ORCA_USER_DATA_PATH are gone and Electron's `app.getPath('userData')` is not
 * reachable. An *installed* plugin lives at
 * `<userData>/plugins/<pluginKey>/<contentHash>/`, so three levels up from the
 * plugin root is userData; that is the most reliable source and comes first.
 * Development plugins live anywhere, so the OS defaults follow.
 */
export type UserDataCandidateInput = {
  /** Directory containing orca-plugin.json (the parent of dist/). */
  pluginRoot: string | null
  env: Readonly<Record<string, string | undefined>>
  platform: NodeJS.Platform
  homedir: string
}

/** Env var that pins userData (tests and manual setups). Note: Orca does not
 *  pass it through to plugin workers, so inside Orca it is only honoured when
 *  the worker env allowlist ever grows; it is mainly for running outside Orca. */
export const USER_DATA_OVERRIDE_ENV = 'MLP_ORCA_USER_DATA'

export function userDataCandidates(input: UserDataCandidateInput): string[] {
  const override = input.env[USER_DATA_OVERRIDE_ENV]
  if (override) {
    return [override]
  }
  const api = input.platform === 'win32' ? path.win32 : path.posix
  const candidates: string[] = []
  if (input.pluginRoot) {
    candidates.push(api.resolve(input.pluginRoot, '..', '..', '..'))
  }
  for (const appData of appDataDirs(input, api)) {
    // Why: dev builds of Orca use `<appData>/orca-dev`; try the release first.
    candidates.push(api.join(appData, 'orca'), api.join(appData, 'orca-dev'))
  }
  return [...new Set(candidates)]
}

function appDataDirs(input: UserDataCandidateInput, api: path.PlatformPath): string[] {
  const { env, homedir, platform } = input
  if (platform === 'darwin') {
    return [api.join(homedir, 'Library', 'Application Support')]
  }
  if (platform === 'win32') {
    const home = env.USERPROFILE || homedir
    const dirs = [api.join(home, 'AppData', 'Roaming')]
    // APPDATA is normally stripped by Orca, but honour it when present.
    if (env.APPDATA) {
      dirs.unshift(env.APPDATA)
    }
    return dirs
  }
  const dirs = [api.join(homedir, '.config')]
  if (env.XDG_CONFIG_HOME) {
    dirs.unshift(env.XDG_CONFIG_HOME)
  }
  return dirs
}
