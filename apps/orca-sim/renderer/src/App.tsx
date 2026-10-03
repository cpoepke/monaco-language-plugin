import { Suspense } from 'react'
import { MonacoEditor } from './editor/editor-lazy-views'
import { editorStore, useEditorState, type OpenFile } from './store'

function TabBar(): React.JSX.Element {
  const openFiles = useEditorState((s) => s.openFiles)
  const activeFileId = useEditorState((s) => s.activeFileId)
  return (
    <div className="tab-bar" role="tablist">
      {openFiles.map((file) => (
        <div
          key={file.id}
          role="tab"
          className="tab"
          aria-selected={file.id === activeFileId}
          data-path={file.filePath}
          title={file.filePath}
          onMouseDown={(event) => {
            if (event.button === 0) editorStore.setActiveFile(file.id)
          }}
        >
          <span className="tab-name">{file.relativePath.split('/').pop()}</span>
          <button
            type="button"
            className="tab-close"
            aria-label={`Close ${file.relativePath}`}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={() => editorStore.closeFile(file.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )
}

function EditorSurface({ file }: { file: OpenFile }): React.JSX.Element {
  const fileContent = useEditorState((s) => s.fileContents[file.id])
  if (!fileContent) {
    return <div className="placeholder">Loading...</div>
  }
  if (fileContent.loadError !== undefined) {
    return <div className="placeholder error">{fileContent.loadError}</div>
  }
  // Orca keys the editor by `${viewStateScopeId}\0${filePath}` → a new editor instance per file.
  const remountKey = `pane-1\u0000${file.filePath}`
  return (
    <MonacoEditor
      key={remountKey}
      filePath={file.filePath}
      viewStateKey={file.filePath}
      content={fileContent.content}
      language={file.language}
    />
  )
}

export function App(): React.JSX.Element {
  const activeFile = useEditorState(
    (s) => s.openFiles.find((file) => file.id === s.activeFileId) ?? null
  )
  return (
    <div className="workbench">
      <TabBar />
      <div className="editor-pane">
        {activeFile ? (
          <Suspense fallback={<div className="placeholder">Loading editor...</div>}>
            <EditorSurface file={activeFile} />
          </Suspense>
        ) : (
          <div className="placeholder">No file open</div>
        )}
      </div>
    </div>
  )
}
