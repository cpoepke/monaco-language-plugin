// Replica of Orca's src/renderer/src/lib/monaco-setup.ts (Orca main, 2026-10). Same import order:
// monaco-editor is evaluated first, then MonacoEnvironment is assigned, then loader.config.
// Language registrations for Vue/Svelte/etc., the diff-editor guard and context-menu paste are left out; they do not
// touch MonacoEnvironment, the global API or navigation.
import { loader } from '@monaco-editor/react'
import { editorModelRegistry } from './editor-model-registry'
import * as monaco from 'monaco-editor'
import { typescript as monacoTS } from 'monaco-editor'
import 'monaco-editor/min/vs/editor/editor.main.css'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'
import { installMonacoDelayerCancellationGuard } from './monaco-delayer-cancellation-guard'
import { installMonacoPeekReferencesPreviewOptions } from './monaco-peek-preview-options'

globalThis.MonacoEnvironment = {
  getWorker(_workerId, label) {
    switch (label) {
      case 'json':
        return new jsonWorker()
      case 'css':
      case 'scss':
      case 'less':
        return new cssWorker()
      case 'html':
      case 'handlebars':
      case 'razor':
        return new htmlWorker()
      case 'typescript':
      case 'javascript':
        return new tsWorker()
      default:
        return new editorWorker()
    }
  }
}

const diagnosticsOptions = {
  noSemanticValidation: true,
  noSuggestionDiagnostics: true,
  noSyntaxValidation: true
}
monacoTS.typescriptDefaults.setDiagnosticsOptions(diagnosticsOptions)
monacoTS.javascriptDefaults.setDiagnosticsOptions(diagnosticsOptions)

monacoTS.typescriptDefaults.setCompilerOptions({
  ...monacoTS.typescriptDefaults.getCompilerOptions(),
  jsx: monacoTS.JsxEmit.Preserve
})
monacoTS.javascriptDefaults.setCompilerOptions({
  ...monacoTS.javascriptDefaults.getCompilerOptions(),
  jsx: monacoTS.JsxEmit.Preserve
})

// Orca's runMonacoSetupSteps: each step is isolated so one failure cannot break the editor.
for (const [name, run] of [
  ['delayer cancellation guard', installMonacoDelayerCancellationGuard],
  ['peek references preview options', installMonacoPeekReferencesPreviewOptions]
] as const) {
  try {
    run()
  } catch (error) {
    console.error(`[orca-sim] Monaco setup step failed: ${name}`, error)
  }
}

// Configure Monaco to use the locally bundled editor instead of CDN
loader.config({ monaco })

editorModelRegistry.register(monaco)

export { monaco }
