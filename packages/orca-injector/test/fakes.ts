import type { EditorLike, ModelLike, RangeLike } from '../src/reveal'

type Listener = () => void

export class FakeModel implements ModelLike {
  disposed = false
  constructor(
    readonly uriString: string,
    public text: string,
    readonly languageId = 'typescript'
  ) {}
  readonly uri = {
    toString: () => this.uriString,
    get scheme(): string {
      return 'file'
    }
  }
  getLineCount(): number {
    return this.text.split('\n').length
  }
  getValueLength(): number {
    return this.text.length
  }
  getLanguageId(): string {
    return this.languageId
  }
  isDisposed(): boolean {
    return this.disposed
  }
}

export class FakeEditor implements EditorLike {
  model: FakeModel | null = null
  selection: RangeLike | null = null
  revealed: RangeLike | null = null
  focused = 0
  private readonly modelListeners = new Set<Listener>()
  private readonly contentListeners = new Set<Listener>()
  private readonly disposeListeners = new Set<Listener>()
  private readonly selectionListeners = new Set<(e: { source: string }) => void>()

  getModel(): FakeModel | null {
    return this.model
  }
  setModel(model: FakeModel | null): void {
    this.model = model
    for (const l of [...this.modelListeners]) l()
  }
  setText(text: string): void {
    this.model!.text = text
    for (const l of [...this.contentListeners]) l()
  }
  setSelection(range: RangeLike, source = 'api'): void {
    this.selection = range
    for (const l of [...this.selectionListeners]) l({ source })
  }
  getSelection(): RangeLike | null {
    return this.selection
  }
  onDidChangeCursorSelection(listener: (e: { source: string }) => void) {
    this.selectionListeners.add(listener)
    return { dispose: () => this.selectionListeners.delete(listener) }
  }
  revealRangeInCenter(range: RangeLike): void {
    this.revealed = range
  }
  focus(): void {
    this.focused++
  }
  onDidChangeModel(listener: Listener) {
    this.modelListeners.add(listener)
    return { dispose: () => this.modelListeners.delete(listener) }
  }
  onDidChangeModelContent(listener: Listener) {
    this.contentListeners.add(listener)
    return { dispose: () => this.contentListeners.delete(listener) }
  }
  onDidDispose(listener: Listener) {
    this.disposeListeners.add(listener)
    return { dispose: () => this.disposeListeners.delete(listener) }
  }
}

export class FakeEditorApi {
  readonly editors: FakeEditor[] = []
  private readonly createListeners = new Set<(e: FakeEditor) => void>()
  onDidCreateEditor(listener: (e: FakeEditor) => void) {
    this.createListeners.add(listener)
    return { dispose: () => this.createListeners.delete(listener) }
  }
  getEditors(): FakeEditor[] {
    return this.editors
  }
  create(): FakeEditor {
    const editor = new FakeEditor()
    this.editors.push(editor)
    for (const l of [...this.createListeners]) l(editor)
    return editor
  }
}

export const range = (line: number, col = 1): RangeLike => ({
  startLineNumber: line,
  startColumn: col,
  endLineNumber: line,
  endColumn: col + 3
})

/** Manually driven animation frames + clock. */
export class FrameClock {
  t = 0
  private waiting: (() => void)[] = []
  frames = 0
  now = (): number => this.t
  frame = (): Promise<void> =>
    new Promise((resolve) => {
      this.waiting.push(resolve)
    })
  /** Advance one frame (16 ms) and let promise continuations run. */
  async tick(n = 1, ms = 16): Promise<void> {
    for (let i = 0; i < n; i++) {
      this.t += ms
      this.frames++
      for (const resolve of this.waiting.splice(0)) resolve()
      await flush()
    }
  }
}

export async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}
