// Orca's scroll-cache.ts + monaco-view-state-persistence.ts + monaco-content-sync.ts
// (syncContentOnMount), reduced to what changes the cursor or the model after mount.
import type { editor, ISelection } from 'monaco-editor'

const CACHE_MAX_ENTRIES = 20

export function setWithLRU<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key)
  map.set(key, value)
  if (map.size > CACHE_MAX_ENTRIES) {
    const first = map.keys().next()
    if (!first.done) map.delete(first.value)
  }
}

export const scrollTopCache = new Map<string, number>()
export const editorSelectionCache = new Map<string, ISelection[]>()

/** restoreMonacoViewState: saved selection + scroll after one rAF, else just focus. */
export function restoreMonacoViewState(
  editorInstance: editor.IStandaloneCodeEditor,
  viewStateKey: string
): void {
  const savedSelections = editorSelectionCache.get(viewStateKey)
  const savedScrollTop = scrollTopCache.get(viewStateKey)
  if (savedScrollTop !== undefined || savedSelections) {
    requestAnimationFrame(() => {
      if (savedSelections) {
        editorInstance.setSelections(savedSelections)
      }
      if (savedScrollTop !== undefined) {
        editorInstance.setScrollTop(savedScrollTop)
      }
      editorInstance.focus()
    })
  } else {
    editorInstance.focus()
  }
}

/** snapshotMonacoViewState: runs in a layout-effect cleanup when the editor unmounts. */
export function snapshotMonacoViewState(
  editorInstance: editor.IStandaloneCodeEditor | null,
  viewStateKey: string
): void {
  if (!editorInstance) return
  setWithLRU(scrollTopCache, viewStateKey, editorInstance.getScrollTop())
  const selections = editorInstance.getSelections()
  if (selections) setWithLRU(editorSelectionCache, viewStateKey, selections)
}

/** Reconcile a retained model with the tab content on mount (no undo stop). */
export function syncContentOnMount(
  editorInstance: editor.IStandaloneCodeEditor,
  content: string
): boolean {
  const model = editorInstance.getModel()
  if (!model) return false
  const eol = model.getEOL()
  const normalized =
    eol === '\n' && !content.includes('\r') ? content : content.replace(/\r\n|\r|\n/g, eol)
  if (model.getValue() === normalized) return false
  model.pushEditOperations([], [{ range: model.getFullModelRange(), text: normalized }], () => null)
  return true
}
