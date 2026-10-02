/** A minimal, DOM-free stand-in for the Monaco API surface the client touches. */
import type * as Monaco from 'monaco-editor'
import { URI } from 'monaco-editor/esm/vs/base/common/uri.js'

type Listener<T> = (value: T) => void

class Emitter<T> {
  private listeners = new Set<Listener<T>>()
  event = (listener: Listener<T>) => {
    this.listeners.add(listener)
    return { dispose: () => this.listeners.delete(listener) }
  }
  fire(value: T): void {
    for (const listener of [...this.listeners]) {
      listener(value)
    }
  }
}

export class FakeModel {
  private disposed = false
  private readonly contentEmitter = new Emitter<void>()
  private readonly disposeEmitter = new Emitter<void>()
  attachedEditors = 0

  constructor(
    readonly uri: URI,
    private value: string,
    private languageId: string,
    private readonly owner: FakeMonaco
  ) {}

  getValue(): string {
    return this.value
  }
  setValue(value: string): void {
    this.value = value
    this.contentEmitter.fire()
  }
  getLanguageId(): string {
    return this.languageId
  }
  setLanguage(languageId: string): void {
    this.languageId = languageId
    this.owner.languageChanged.fire({ model: this })
  }
  isDisposed(): boolean {
    return this.disposed
  }
  isAttachedToEditor(): boolean {
    return this.attachedEditors > 0
  }
  onDidChangeContent = this.contentEmitter.event
  onWillDispose = this.disposeEmitter.event
  getOffsetAt(position: { lineNumber: number; column: number }): number {
    const lines = this.value.split('\n')
    let offset = 0
    for (let i = 0; i < position.lineNumber - 1; i++) {
      offset += (lines[i]?.length ?? 0) + 1
    }
    return offset + position.column - 1
  }
  getPositionAt(offset: number): { lineNumber: number; column: number } {
    const before = this.value.slice(0, offset).split('\n')
    return { lineNumber: before.length, column: (before.at(-1)?.length ?? 0) + 1 }
  }
  dispose(): void {
    if (this.disposed) {
      return
    }
    this.owner.willDispose.fire(this)
    this.disposeEmitter.fire()
    this.disposed = true
    this.owner.models.delete(this.uri.toString())
  }
}

export class FakeEditor {
  private model: FakeModel | null = null
  private readonly changeEmitter = new Emitter<unknown>()
  private readonly disposeEmitter = new Emitter<void>()
  private readonly focusEmitter = new Emitter<void>()

  getModel(): FakeModel | null {
    return this.model
  }
  setModel(model: FakeModel | null): void {
    if (this.model) {
      this.model.attachedEditors--
    }
    const old = this.model
    this.model = model
    if (model) {
      model.attachedEditors++
    }
    this.changeEmitter.fire({ oldModelUrl: old?.uri ?? null, newModelUrl: model?.uri ?? null })
  }
  focus(): void {
    this.focusEmitter.fire()
  }
  dispose(): void {
    this.setModel(null)
    this.disposeEmitter.fire()
  }
  onDidChangeModel = this.changeEmitter.event
  onDidDispose = this.disposeEmitter.event
  onDidFocusEditorText = this.focusEmitter.event
}

type ProviderRecord = {
  languageId: string
  provider: Record<string, (...args: never[]) => unknown>
}

export class FakeMonaco {
  readonly models = new Map<string, FakeModel>()
  readonly editors: FakeEditor[] = []
  readonly willDispose = new Emitter<FakeModel>()
  readonly languageChanged = new Emitter<{ model: FakeModel }>()
  readonly modelCreated = new Emitter<FakeModel>()
  readonly editorCreated = new Emitter<FakeEditor>()
  readonly providers = new Map<string, ProviderRecord[]>()
  readonly markers = new Map<string, unknown[]>()
  editorOpeners: { openCodeEditor: (...args: unknown[]) => unknown }[] = []
  linkOpeners: { open: (resource: URI) => unknown }[] = []
  modeConfiguration: Record<string, boolean> = {
    definitions: true,
    references: true,
    hovers: true,
    documentSymbols: true,
    completionItems: true
  }

  readonly Uri = URI
  readonly MarkerSeverity = { Hint: 1, Info: 2, Warning: 4, Error: 8 }

  readonly languageListeners = new Map<string, (() => void)[]>()

  typescript: Record<string, unknown> | undefined = {
    typescriptDefaults: this.defaults(),
    javascriptDefaults: this.defaults(),
    getTypeScriptWorker: () => Promise.reject(new Error('no worker in tests')),
    getJavaScriptWorker: () => Promise.reject(new Error('no worker in tests'))
  }

  readonly editor = {
    getModels: () => [...this.models.values()],
    getModel: (uri: URI) => this.models.get(uri.toString()) ?? null,
    createModel: (value: string, language: string | undefined, uri: URI) =>
      this.createModel(value, language ?? 'plaintext', uri),
    getEditors: () => [...this.editors],
    onDidCreateEditor: this.editorCreated.event,
    onDidCreateModel: this.modelCreated.event,
    onWillDisposeModel: this.willDispose.event,
    onDidChangeModelLanguage: this.languageChanged.event,
    setModelMarkers: (model: FakeModel, owner: string, markers: unknown[]) => {
      this.markers.set(`${owner} ${model.uri.toString()}`, markers)
    },
    registerEditorOpener: (opener: { openCodeEditor: (...args: unknown[]) => unknown }) => {
      this.editorOpeners.push(opener)
      return {
        dispose: () => (this.editorOpeners = this.editorOpeners.filter((o) => o !== opener))
      }
    },
    registerLinkOpener: (opener: { open: (resource: URI) => unknown }) => {
      this.linkOpeners.push(opener)
      return { dispose: () => (this.linkOpeners = this.linkOpeners.filter((o) => o !== opener)) }
    }
  }

  readonly languages = {
    onLanguage: (languageId: string, listener: () => void) => {
      const list = this.languageListeners.get(languageId) ?? []
      list.push(listener)
      this.languageListeners.set(languageId, list)
      return { dispose: () => list.splice(list.indexOf(listener), 1) }
    },
    registerDefinitionProvider: this.register('definition'),
    registerDeclarationProvider: this.register('declaration'),
    registerTypeDefinitionProvider: this.register('typeDefinition'),
    registerImplementationProvider: this.register('implementation'),
    registerReferenceProvider: this.register('references'),
    registerHoverProvider: this.register('hover'),
    registerDocumentSymbolProvider: this.register('documentSymbols'),
    registerLinkProvider: this.register('links')
  }

  /** Fires onLanguage listeners once, like Monaco does on first use of a language. */
  activateLanguage(languageId: string): void {
    for (const listener of this.languageListeners.get(languageId)?.splice(0) ?? []) {
      listener()
    }
  }

  createModel(value: string, languageId: string, uri: URI): FakeModel {
    const model = new FakeModel(uri, value, languageId, this)
    this.models.set(uri.toString(), model)
    this.modelCreated.fire(model)
    return model
  }

  createEditor(model: FakeModel | null = null): FakeEditor {
    const editor = new FakeEditor()
    this.editors.push(editor)
    this.editorCreated.fire(editor)
    if (model) {
      editor.setModel(model)
    }
    return editor
  }

  provider(kind: string, languageId: string): Record<string, (...args: unknown[]) => unknown> {
    const record = this.providers.get(kind)?.find((entry) => entry.languageId === languageId)
    if (!record) {
      throw new Error(`no ${kind} provider for ${languageId}`)
    }
    return record.provider as Record<string, (...args: unknown[]) => unknown>
  }

  asMonaco(): typeof Monaco {
    return this as unknown as typeof Monaco
  }

  private register(kind: string) {
    return (languageId: string, provider: ProviderRecord['provider']) => {
      const list = this.providers.get(kind) ?? []
      const record = { languageId, provider }
      list.push(record)
      this.providers.set(kind, list)
      return {
        dispose: () => {
          const current = this.providers.get(kind) ?? []
          this.providers.set(
            kind,
            current.filter((entry) => entry !== record)
          )
        }
      }
    }
  }

  private defaults() {
    const self = this
    let configuration: Record<string, boolean> = { ...this.modeConfiguration }
    return {
      get modeConfiguration() {
        return configuration
      },
      setModeConfiguration(next: Record<string, boolean>) {
        configuration = next
        self.modeConfiguration = next
      }
    }
  }
}

export async function waitFor<T>(
  check: () => T | undefined | null | false,
  timeoutMs = 3000
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = check()
    if (value) {
      return value
    }
    if (Date.now() > deadline) {
      throw new Error('waitFor timed out')
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
