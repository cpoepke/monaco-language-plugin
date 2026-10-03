/**
 * Reduced copy of Orca's components/editor/MonacoEditor.tsx + use-monaco-editor-mount.ts.
 * Kept: the `<Editor>` props (path=URI.file(path), defaultValue, keepCurrentModel,
 * saveViewState=false, options), content sync on mount, view-state snapshot on unmount and
 * restore (saved selection + scroll one rAF after mount, else focus) — i.e. everything that touches
 * the model or the cursor after mount. Dropped: markdown annotations, decorations, gutter menu,
 * copy helpers, auto height.
 */
import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import '../lib/monaco-setup'
import { clearMountedEditor, recordEvent, setMountedEditor } from '../sim-debug'
import { toEditorModelUri } from './editor-model-uri'
import { restoreMonacoViewState, snapshotMonacoViewState, syncContentOnMount } from './view-state'

type MonacoEditorProps = {
  filePath: string
  viewStateKey: string
  content: string
  language: string
}

export default function MonacoEditor({
  filePath,
  viewStateKey,
  content,
  language
}: MonacoEditorProps): React.JSX.Element {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const contentRef = useRef(content)
  contentRef.current = content
  const modelUri = useMemo(() => toEditorModelUri(filePath), [filePath])

  // Why useLayoutEffect (as in Orca): cleanup runs before @monaco-editor/react disposes the editor.
  useLayoutEffect(() => {
    return () => {
      snapshotMonacoViewState(editorRef.current, viewStateKey)
    }
  }, [viewStateKey])

  const handleMount = useCallback<OnMount>(
    (editorInstance) => {
      editorRef.current = editorInstance
      setMountedEditor({ editor: editorInstance, filePath })
      recordEvent('mount', filePath)
      syncContentOnMount(editorInstance, contentRef.current)
      editorInstance.onDidDispose(() => {
        editorRef.current = null
        clearMountedEditor(editorInstance)
        recordEvent('editorDisposed', filePath)
      })
      // No pendingEditorReveal (files.open cannot carry one), so Orca restores the view state.
      restoreMonacoViewState(editorInstance, viewStateKey)
    },
    [filePath, viewStateKey]
  )

  return (
    <div className="editor-host">
      <Editor
        height="100%"
        language={language}
        defaultValue={content}
        theme="vs-dark"
        onMount={handleMount}
        options={{
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          fontSize: 13,
          lineNumbers: 'on',
          renderLineHighlight: 'line',
          automaticLayout: true,
          tabSize: 2,
          readOnly: false,
          smoothScrolling: true,
          cursorSmoothCaretAnimation: 'off',
          padding: { top: 0 }
        }}
        path={modelUri}
        saveViewState={false}
        keepCurrentModel
      />
    </div>
  )
}
