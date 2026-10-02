// Mirrors Orca: the editor (and Monaco) is loaded lazily, like `lazy(() => import('./MonacoEditor'))`.
import('./monaco-setup.js').then(({ mountEditor }) => mountEditor(document.getElementById('root')))
