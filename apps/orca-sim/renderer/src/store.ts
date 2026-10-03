/**
 * Minimal editor store, shaped after Orca's `store/slices/editor` `openFile` / `closeFile` /
 * `setActiveFile`: one tab per file path, opening an open file focuses its tab, contents load
 * asynchronously (the pane shows "Loading..." until then).
 */
import { useSyncExternalStore } from 'react'
import { preloadApi } from './preload-api'

export type OpenFile = {
  /** Orca uses the absolute file path as the id of an edit-mode tab. */
  id: string
  filePath: string
  relativePath: string
  worktreeId: string | null
  language: string
  mode: 'edit'
}

export type FileContent = { content: string; loadError?: undefined } | { loadError: string }

export type EditorState = {
  openFiles: OpenFile[]
  activeFileId: string | null
  fileContents: Record<string, FileContent>
}

export type OpenFileRequest = {
  filePath: string
  relativePath?: string
  worktreeId?: string | null
  language?: string
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  go: 'go',
  rs: 'rust',
  json: 'json',
  md: 'markdown'
}

export function detectLanguage(filePath: string): string {
  const ext = /\.([^./\\]+)$/.exec(filePath)?.[1]?.toLowerCase() ?? ''
  return LANGUAGE_BY_EXTENSION[ext] ?? 'plaintext'
}

const basename = (filePath: string): string => filePath.split(/[\\/]/).pop() ?? filePath

type Listener = () => void
type CloseListener = (closed: OpenFile[]) => void

let state: EditorState = { openFiles: [], activeFileId: null, fileContents: {} }
const listeners = new Set<Listener>()
const closeListeners = new Set<CloseListener>()

function setState(next: Partial<EditorState>): void {
  state = { ...state, ...next }
  for (const listener of [...listeners]) listener()
}

export const editorStore = {
  getState: (): EditorState => state,
  subscribe(listener: Listener): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  onDidCloseFiles(listener: CloseListener): () => void {
    closeListeners.add(listener)
    return () => closeListeners.delete(listener)
  },

  openFile(request: OpenFileRequest): OpenFile {
    const existing = state.openFiles.find((file) => file.id === request.filePath)
    if (existing) {
      setState({ activeFileId: existing.id })
      return existing
    }
    const file: OpenFile = {
      id: request.filePath,
      filePath: request.filePath,
      relativePath: request.relativePath ?? basename(request.filePath),
      worktreeId: request.worktreeId ?? null,
      language: request.language ?? detectLanguage(request.filePath),
      mode: 'edit'
    }
    // Orca inserts the new tab after the active one.
    const activeIndex = state.openFiles.findIndex((f) => f.id === state.activeFileId)
    const openFiles = [...state.openFiles]
    openFiles.splice(activeIndex + 1, 0, file)
    setState({ openFiles, activeFileId: file.id })
    void loadContent(file)
    return file
  },

  setActiveFile(id: string): void {
    if (state.openFiles.some((file) => file.id === id)) setState({ activeFileId: id })
  },

  closeFile(id: string): void {
    const index = state.openFiles.findIndex((file) => file.id === id)
    if (index < 0) return
    const closed = state.openFiles[index]!
    const openFiles = state.openFiles.filter((file) => file.id !== id)
    let activeFileId = state.activeFileId
    if (activeFileId === id) {
      activeFileId = (openFiles[index] ?? openFiles[index - 1] ?? null)?.id ?? null
    }
    const fileContents = { ...state.fileContents }
    delete fileContents[id]
    setState({ openFiles, activeFileId, fileContents })
    for (const listener of [...closeListeners]) listener([closed])
  }
}

async function loadContent(file: OpenFile): Promise<void> {
  try {
    const content = await preloadApi().fs.readFile(file.filePath)
    if (!state.openFiles.some((f) => f.id === file.id)) return
    setState({ fileContents: { ...state.fileContents, [file.id]: { content } } })
  } catch (error) {
    if (!state.openFiles.some((f) => f.id === file.id)) return
    setState({
      fileContents: {
        ...state.fileContents,
        [file.id]: { loadError: error instanceof Error ? error.message : String(error) }
      }
    })
  }
}

export function useEditorState<T>(selector: (s: EditorState) => T): T {
  return useSyncExternalStore(editorStore.subscribe, () => selector(editorStore.getState()))
}
