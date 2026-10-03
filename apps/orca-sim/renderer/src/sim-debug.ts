/**
 * `window.__sim`: the harness' handle into the simulated renderer. `openFile` stands in for Orca's
 * `ui:openFileFromMobile` IPC → `store.openFile(..., {selection:'focus'})` path that a runtime
 * `files.open` with `navigation:'host'` triggers.
 */
import type { editor } from 'monaco-editor'
import { editorStore, type OpenFileRequest } from './store'

export type SimEvent = { type: string; path: string | null; at: number }

type MountedEditor = { editor: editor.IStandaloneCodeEditor; filePath: string }

let mounted: MountedEditor | null = null
const events: SimEvent[] = []

export function recordEvent(type: string, path: string | null): void {
  events.push({ type, path, at: performance.now() })
  if (events.length > 500) events.splice(0, events.length - 500)
}

export function setMountedEditor(value: MountedEditor): void {
  mounted = value
}

export function clearMountedEditor(instance: editor.IStandaloneCodeEditor): void {
  if (mounted?.editor === instance) mounted = null
}

export type SimDebug = {
  openFile(filePath: string, options?: Omit<OpenFileRequest, 'filePath'>): void
  closeFile(filePath: string): void
  activateFile(filePath: string): void
  state(): { openFiles: string[]; active: string | null; loaded: string[] }
  /** The editor of the active tab (null while loading or with no tab). */
  editor(): editor.IStandaloneCodeEditor | null
  editorFilePath(): string | null
  events(): SimEvent[]
}

export function installSimDebug(): void {
  const sim: SimDebug = {
    openFile(filePath, options) {
      recordEvent('openFile', filePath)
      editorStore.openFile({ filePath, ...options })
    },
    closeFile(filePath) {
      recordEvent('closeFile', filePath)
      editorStore.closeFile(filePath)
    },
    activateFile(filePath) {
      recordEvent('activateFile', filePath)
      editorStore.setActiveFile(filePath)
    },
    state() {
      const s = editorStore.getState()
      return {
        openFiles: s.openFiles.map((f) => f.filePath),
        active: s.activeFileId,
        loaded: Object.keys(s.fileContents)
      }
    },
    editor: () => mounted?.editor ?? null,
    editorFilePath: () => mounted?.filePath ?? null,
    events: () => [...events]
  }
  Object.defineProperty(window, '__sim', { value: sim, configurable: true })
}
