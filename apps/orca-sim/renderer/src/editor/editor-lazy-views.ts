import { lazy } from 'react'

// Orca: components/editor/editor-lazy-views.ts — the editor (and with it monaco-editor and
// monaco-setup) lives in a lazily loaded chunk.
export const MonacoEditor = lazy(() => import('./MonacoEditor'))
