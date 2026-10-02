import * as monaco from 'monaco-editor'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker.js?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker.js?worker'
import {
  createMonacoLspClient,
  type HostAdapter,
  type MonacoLspClient,
  type MonacoLspClientStatus,
  type OpenLocationTarget
} from '@mlp/monaco-lsp-client'
import './style.css'

// Monaco workers, per the Vite section of the monaco-editor ESM guide.
self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    return label === 'typescript' || label === 'javascript' ? new tsWorker() : new editorWorker()
  }
}

type Project = { name: string; root: string; entry: string }
type FileList = { root: string; rootPath: string; files: string[] }
type BridgeInfo = { status: 'ready'; url: string } | { status: string; url: null; message: string }

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const projectSelect = $<HTMLSelectElement>('project')
const treeEl = $<HTMLElement>('tree')
const statusEl = $<HTMLElement>('status')
const bannerEl = $<HTMLElement>('banner')
const breadcrumbEl = $<HTMLElement>('breadcrumb')

let project: FileList | null = null
let client: MonacoLspClient | null = null

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`${url}: ${response.status}`)
  }
  return (await response.json()) as T
}

async function fetchText(absPath: string): Promise<string | null> {
  const response = await fetch(`/api/file?path=${encodeURIComponent(absPath)}`)
  return response.ok ? response.text() : null
}

function showBanner(message: string | null): void {
  bannerEl.hidden = message === null
  bannerEl.textContent = message ?? ''
}

function renderStatus(status: MonacoLspClientStatus): void {
  statusEl.dataset.state = status.connection
  const parts = [`bridge: ${status.connection}`]
  if (status.hello) {
    parts.push(`servers: ${status.hello.availableLanguages.join(', ') || 'none'}`)
  }
  const current = editor.getModel()?.uri.toString()
  const doc = status.documents.find((entry) => entry.uri === current)
  if (doc) {
    parts.push(
      doc.state === 'open'
        ? `${doc.serverId ?? 'server'} attached`
        : doc.state === 'no-session'
          ? `no server: ${doc.reason ?? ''}`
          : `${doc.state}…`
    )
  }
  if (status.connection !== 'connected' && status.lastError) {
    parts.push(status.lastError)
  }
  statusEl.textContent = parts.join(' · ')
  statusEl.title = statusEl.textContent
}

// --- Monaco ------------------------------------------------------------------

// Why: Monaco's own TS worker only sees open models, so it would flag every
// cross-file import as unresolved; the language server is the source of truth.
monaco.typescript?.typescriptDefaults.setDiagnosticsOptions({
  noSemanticValidation: true,
  noSyntaxValidation: false
})

const editor = monaco.editor.create($('editor'), {
  automaticLayout: true,
  minimap: { enabled: false },
  fontSize: 14,
  scrollBeyondLastLine: false,
  theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'vs-dark' : 'vs'
})

function relativePath(absPath: string): string {
  if (project && absPath.startsWith(project.rootPath + '/')) {
    return absPath.slice(project.rootPath.length + 1)
  }
  return absPath
}

async function modelFor(absPath: string): Promise<monaco.editor.ITextModel | null> {
  const uri = monaco.Uri.file(absPath)
  const existing = monaco.editor.getModel(uri)
  if (existing) {
    return existing
  }
  const text = await fetchText(absPath)
  if (text === null) {
    return null
  }
  // Language is inferred from the extension.
  return monaco.editor.getModel(uri) ?? monaco.editor.createModel(text, undefined, uri)
}

/** Opens a file in the editor and reveals `range` (1-based Monaco range). */
async function openFile(absPath: string, range?: monaco.IRange): Promise<boolean> {
  const model = await modelFor(absPath)
  if (!model) {
    return false
  }
  if (editor.getModel() !== model) {
    editor.setModel(model)
  }
  if (range) {
    editor.setSelection(range)
    editor.revealRangeInCenter(range, monaco.editor.ScrollType.Immediate)
  }
  editor.focus()
  const rel = relativePath(absPath)
  breadcrumbEl.textContent = project ? `${project.root}/${rel}` : rel
  for (const button of treeEl.querySelectorAll<HTMLButtonElement>('button[data-path]')) {
    button.setAttribute('aria-current', String(button.dataset.path === absPath))
  }
  const url = new URL(location.href)
  if (project) {
    url.searchParams.set('root', project.root)
  }
  url.searchParams.set('file', rel)
  history.replaceState(null, '', url)
  if (client) {
    renderStatus(client.status())
  }
  return true
}

const host: HostAdapter = {
  async openLocation(target: OpenLocationTarget) {
    const uri = monaco.Uri.parse(target.uri)
    if (uri.scheme !== 'file') {
      return false
    }
    // Why: not uri.fsPath — Monaco derives its separator from the browser's user agent,
    // not from the machine serving the files.
    const path = uri.path.replace(/^\/([A-Za-z]:)/, '$1')
    return openFile(path, target.range)
  }
}

// --- file tree ---------------------------------------------------------------

function renderTree(list: FileList): void {
  treeEl.replaceChildren()
  let lastDir = ''
  for (const file of list.files) {
    const slash = file.lastIndexOf('/')
    const dir = slash === -1 ? '' : file.slice(0, slash)
    if (dir && dir !== lastDir) {
      const dirEl = document.createElement('div')
      dirEl.className = 'dir'
      dirEl.textContent = `${dir}/`
      treeEl.append(dirEl)
    }
    lastDir = dir
    const button = document.createElement('button')
    const absPath = `${list.rootPath}/${file}`
    button.type = 'button'
    button.dataset.path = absPath
    button.textContent = file.slice(slash + 1)
    button.style.paddingLeft = `${12 + (dir ? 14 * dir.split('/').length : 0)}px`
    button.addEventListener('click', () => void openFile(absPath))
    treeEl.append(button)
  }
}

async function loadProject(root: string, file: string | null, projects: Project[]): Promise<void> {
  project = await getJson<FileList>(`/api/files?root=${encodeURIComponent(root)}`)
  projectSelect.value = project.root
  renderTree(project)
  const entry = projects.find((candidate) => candidate.root === project!.root)?.entry
  const target = file ?? entry ?? project.files[0]
  if (target) {
    await openFile(`${project.rootPath}/${target}`)
  }
}

// --- boot ----------------------------------------------------------------------

async function main(): Promise<void> {
  const params = new URLSearchParams(location.search)
  const [{ projects }, bridge] = await Promise.all([
    getJson<{ projects: Project[] }>('/api/projects'),
    getJson<BridgeInfo>('/api/bridge').catch((error: unknown): BridgeInfo => ({
      status: 'failed',
      url: null,
      message: String(error)
    }))
  ])

  for (const candidate of projects) {
    const option = document.createElement('option')
    option.value = candidate.root
    option.textContent = candidate.name
    projectSelect.append(option)
  }
  projectSelect.addEventListener('change', () => {
    void loadProject(projectSelect.value, null, projects)
  })

  if (bridge.status === 'ready' && bridge.url) {
    // Created before the first TS model so Monaco's built-in TS navigation can be switched off.
    client = createMonacoLspClient(monaco, { url: bridge.url, host })
    client.onDidChangeStatus(renderStatus)
    renderStatus(client.status())
  } else {
    statusEl.dataset.state = 'missing'
    statusEl.textContent = `bridge: ${bridge.status}`
    showBanner('message' in bridge ? bridge.message : 'bridge unavailable')
  }

  ;(window as unknown as { __demo: unknown }).__demo = { monaco, editor, client, openFile, bridge }
  await loadProject(
    params.get('root') ?? projects[0]?.root ?? 'fixtures/ts',
    params.get('file'),
    projects
  )
  document.body.dataset.ready = 'true'
}

main().catch((error: unknown) => {
  showBanner(`Demo failed to start: ${error instanceof Error ? error.message : String(error)}`)
})
