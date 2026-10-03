/**
 * The subset of Orca's preload API (`contextBridge.exposeInMainWorld('api', api)`) the simulation
 * uses. The Playwright harness installs it as an init script before any page script runs, like
 * Electron's preload does.
 */
export type InvokeCommandArgs = { pluginKey: string; commandId: string; args?: unknown }

export type SimPreloadApi = {
  plugins: {
    // src/preload/api/plugins-bridge.ts: ipcRenderer.invoke('plugins:invokeCommand', args)
    invokeCommand(args: InvokeCommandArgs): Promise<unknown>
  }
  fs: {
    readFile(filePath: string): Promise<string>
  }
}

declare global {
  interface Window {
    api?: SimPreloadApi
  }
}

export function preloadApi(): SimPreloadApi {
  const api = window.api
  if (!api) {
    throw new Error('window.api is missing (the harness installs it as an init script)')
  }
  return api
}
