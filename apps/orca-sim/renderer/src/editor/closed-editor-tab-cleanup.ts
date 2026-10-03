/**
 * Orca's closed-editor-tab-controller.ts + closed-editor-tab-disposal.ts, reduced to edit tabs:
 * after a tab closes (next microtask) dispose its `file:` model, or, if an editor still shows it,
 * dispose it once it is detached; and forget the tab's saved selection/scroll.
 */
import type { editor } from 'monaco-editor'
import { editorModelRegistry } from '../lib/editor-model-registry'
import { recordEvent } from '../sim-debug'
import { editorStore, type OpenFile } from '../store'
import { toEditorModelUri } from './editor-model-uri'
import { editorSelectionCache, scrollTopCache } from './view-state'

export function attachClosedEditorTabCleanup(): () => void {
  const isStillClosed = (file: OpenFile): boolean =>
    !editorStore.getState().openFiles.some((f) => f.id === file.id)

  const disposeModel = (model: editor.ITextModel, file: OpenFile): void => {
    if (!model.isDisposed() && isStillClosed(file)) {
      recordEvent('disposeModel', file.filePath)
      model.dispose()
    }
  }

  return editorStore.onDidCloseFiles((closed) => {
    queueMicrotask(() => {
      const registry = editorModelRegistry.get()
      for (const file of closed) {
        if (!isStillClosed(file)) continue
        scrollTopCache.delete(file.filePath)
        editorSelectionCache.delete(file.filePath)
        if (!registry) continue
        const model = registry.editor.getModel(registry.Uri.parse(toEditorModelUri(file.filePath)))
        if (!model) continue
        if (model.isAttachedToEditor()) {
          const sub = model.onDidChangeAttached(() => {
            if (!model.isAttachedToEditor()) {
              sub.dispose()
              disposeModel(model, file)
            }
          })
        } else {
          disposeModel(model, file)
        }
      }
    })
  })
}
