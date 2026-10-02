// Replica of Orca's src/renderer/src/lib/monaco-setup.ts import pattern (see docs/spikes.md Q1):
// import monaco first, then assign MonacoEnvironment with getWorker.
import * as monaco from 'monaco-editor'
import { typescript as monacoTS } from 'monaco-editor'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'

globalThis.MonacoEnvironment = {
  getWorker(_workerId, label) {
    window.__workerLabels = (window.__workerLabels || []).concat(label)
    return label === 'typescript' || label === 'javascript' ? new tsWorker() : new editorWorker()
  }
}
const diagnosticsOptions = {
  noSemanticValidation: true,
  noSuggestionDiagnostics: true,
  noSyntaxValidation: true
}
monacoTS.typescriptDefaults.setDiagnosticsOptions(diagnosticsOptions)
window.__bundleMonaco = monaco

export function mountEditor(el) {
  const uri = monaco.Uri.parse('file:///repo/src/a.ts')
  const model =
    monaco.editor.getModel(uri) ||
    monaco.editor.createModel('export const a: number = 1\n', 'typescript', uri)
  monaco.editor.create(el, { model })
  window.__editorMounted = true
}
