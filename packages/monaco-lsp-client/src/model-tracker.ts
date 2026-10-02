type Disposable = { dispose(): void }

/** The slice of ITextModel the tracker needs. */
export type TrackedModel = {
  uri: { toString(): string }
  isDisposed(): boolean
}

/** The slice of ICodeEditor the tracker needs. */
export type TrackedEditor<M extends TrackedModel> = {
  getModel(): M | null
  onDidChangeModel(listener: (event: unknown) => void): Disposable
  onDidDispose(listener: () => void): Disposable
  onDidFocusEditorText?(listener: () => void): Disposable
}

export type TrackerMonaco<M extends TrackedModel, E extends TrackedEditor<M>> = {
  editor: {
    getEditors?(): readonly E[]
    onDidCreateEditor(listener: (editor: E) => void): Disposable
    getModels(): M[]
    onDidCreateModel(listener: (model: M) => void): Disposable
    onWillDisposeModel(listener: (model: M) => void): Disposable
    onDidChangeModelLanguage(listener: (event: { readonly model: M }) => void): Disposable
  }
}

export type AttachMode = 'visible' | 'all'

export type ModelTrackerOptions<M extends TrackedModel> = {
  /** 'visible' (default): attach models while an editor shows them; 'all': every model. */
  mode: AttachMode
  /** How long a model stays attached after the last editor stopped showing it. */
  detachDelayMs: number
  shouldAttach(model: M): boolean
  attach(model: M): void
  detach(key: string): void
}

type Record_<M> = { model: M; count: number; timer: ReturnType<typeof setTimeout> | null }

/**
 * Decides which Monaco models are mirrored to the bridge. Hosts create many
 * background models (diff sides, excerpts, previews); by default only models
 * an editor actually shows are attached, and they stay attached for a grace
 * period after the last editor switches away so tab flipping stays cheap.
 */
export class ModelTracker<M extends TrackedModel, E extends TrackedEditor<M>> {
  private readonly retained = new Map<string, Record_<M>>()
  private readonly disposables: Disposable[] = []
  private readonly editorDisposables = new Map<E, Disposable[]>()
  private lastFocused: E | null = null
  private disposed = false

  constructor(
    private readonly monaco: TrackerMonaco<M, E>,
    private readonly options: ModelTrackerOptions<M>
  ) {}

  start(): void {
    const { editor } = this.monaco
    this.disposables.push(
      editor.onDidCreateEditor((created) => this.trackEditor(created)),
      editor.onWillDisposeModel((model) => this.handleModelDisposed(model)),
      editor.onDidChangeModelLanguage((event) => this.handleLanguageChange(event.model))
    )
    for (const existing of editor.getEditors?.() ?? []) {
      this.trackEditor(existing)
    }
    if (this.options.mode === 'all') {
      this.disposables.push(editor.onDidCreateModel((model) => this.retain(model)))
      for (const model of editor.getModels()) {
        this.retain(model)
      }
    }
  }

  /** The editor that most recently had text focus (null when none or disposed). */
  get focusedEditor(): E | null {
    return this.lastFocused
  }

  /** Keeps `model` attached until the returned disposable is disposed. */
  retain(model: M): Disposable {
    if (this.disposed || model.isDisposed()) {
      return { dispose: () => {} }
    }
    const key = model.uri.toString()
    let record = this.retained.get(key)
    if (!record || record.model !== model) {
      record = { model, count: 0, timer: null }
      this.retained.set(key, record)
    }
    record.count++
    if (record.timer !== null) {
      clearTimeout(record.timer)
      record.timer = null
    }
    this.evaluate(model)
    let released = false
    const owned = record
    return {
      dispose: () => {
        if (!released) {
          released = true
          this.release(key, owned)
        }
      }
    }
  }

  isRetained(key: string): boolean {
    return (this.retained.get(key)?.count ?? 0) > 0
  }

  dispose(): void {
    this.disposed = true
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose()
    }
    for (const list of this.editorDisposables.values()) {
      list.forEach((disposable) => disposable.dispose())
    }
    this.editorDisposables.clear()
    for (const record of this.retained.values()) {
      if (record.timer !== null) {
        clearTimeout(record.timer)
      }
    }
    this.retained.clear()
    this.lastFocused = null
  }

  private release(key: string, record: Record_<M>): void {
    if (this.retained.get(key) !== record || record.count === 0) {
      return
    }
    record.count--
    if (record.count > 0) {
      return
    }
    record.timer = setTimeout(() => {
      record.timer = null
      if (this.retained.get(key) === record && record.count === 0) {
        this.retained.delete(key)
        this.options.detach(key)
      }
    }, this.options.detachDelayMs)
  }

  private evaluate(model: M): void {
    const key = model.uri.toString()
    if (!model.isDisposed() && this.options.shouldAttach(model)) {
      this.options.attach(model)
    } else {
      this.options.detach(key)
    }
  }

  private trackEditor(editor: E): void {
    if (this.disposed || this.editorDisposables.has(editor)) {
      return
    }
    let shown: Disposable | null = null
    const show = (): void => {
      shown?.dispose()
      const model = editor.getModel()
      shown = model ? this.retain(model) : null
    }
    show()
    const list: Disposable[] = [
      editor.onDidChangeModel(() => show()),
      editor.onDidDispose(() => {
        shown?.dispose()
        shown = null
        if (this.lastFocused === editor) {
          this.lastFocused = null
        }
        this.editorDisposables.get(editor)?.forEach((disposable) => disposable.dispose())
        this.editorDisposables.delete(editor)
      })
    ]
    if (editor.onDidFocusEditorText) {
      list.push(editor.onDidFocusEditorText(() => (this.lastFocused = editor)))
    }
    this.editorDisposables.set(editor, list)
  }

  private handleModelDisposed(model: M): void {
    const key = model.uri.toString()
    const record = this.retained.get(key)
    if (record?.model === model) {
      if (record.timer !== null) {
        clearTimeout(record.timer)
      }
      this.retained.delete(key)
    }
    this.options.detach(key)
  }

  private handleLanguageChange(model: M): void {
    const key = model.uri.toString()
    // Why: the server (and the bridge session) is chosen by language; start over.
    this.options.detach(key)
    if (this.isRetained(key)) {
      this.evaluate(model)
    }
  }
}
