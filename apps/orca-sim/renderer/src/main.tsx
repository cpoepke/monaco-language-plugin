import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { attachClosedEditorTabCleanup } from './editor/closed-editor-tab-cleanup'
import { installSimDebug } from './sim-debug'
import './style.css'

installSimDebug()
attachClosedEditorTabCleanup()

const rootElement = document.getElementById('root')
if (!rootElement) {
  throw new Error('Renderer root element not found.')
}
createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>
)
document.body.dataset.simReady = 'true'
