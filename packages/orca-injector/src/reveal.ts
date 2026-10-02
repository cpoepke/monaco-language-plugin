/**
 * Reveal a navigation target once Orca has opened it.
 *
 * Orca's runtime `files.open` cannot carry a position (docs/spikes.md Q2), and Orca creates a new
 * editor instance per opened file and moves the cursor itself right after mount (Q4). So we remember
 * the target, watch editors for the matching model, wait two animation frames and until the content
 * has loaded, and then select + reveal + focus.
 */

export type RangeLike = {
  startLineNumber: number
  startColumn: number
  endLineNumber: number
  endColumn: number
}

export type DisposableLike = { dispose(): void }

export type ModelLike = {
  uri: { toString(): string }
  getLineCount(): number
  getValueLength(): number
  isDisposed?(): boolean
}

export type EditorLike = {
  getModel(): ModelLike | null
  setSelection(range: RangeLike): void
  revealRangeInCenter(range: RangeLike, scrollType?: number): void
  focus(): void
  onDidChangeModel(listener: () => void): DisposableLike
  onDidChangeModelContent(listener: () => void): DisposableLike
  onDidDispose(listener: () => void): DisposableLike
}

export type EditorApiLike = {
  onDidCreateEditor(listener: (editor: EditorLike) => void): DisposableLike
  getEditors?(): readonly EditorLike[]
}

export type PendingReveal = { uri: string; key: string; range: RangeLike; at: number }

/** Pending reveals older than this are dropped (the open probably failed or the user moved on). */
export const PENDING_TTL_MS = 10_000
/** Reveal anyway after this long even if the model still looks empty. */
export const CONTENT_WAIT_MS = 1_500
/** monaco.editor.ScrollType.Immediate */
const SCROLL_IMMEDIATE = 1

/**
 * Canonical comparison key for a file URI: decoded path, Windows drive letter lower-cased and
 * separators normalized. Null for non-file URIs.
 */
export function canonicalFileKey(uri: string): string | null {
  const match = /^file:\/\/([^/]*)(\/[^?#]*)?/i.exec(uri)
  if (!match) return null
  const host = (match[1] ?? '').toLowerCase()
  let path: string
  try {
    path = decodeURIComponent(match[2] ?? '/')
  } catch {
    return null
  }
  path = path.replace(/\\/g, '/')
  const drive = /^\/?([A-Za-z]):(\/.*)?$/.exec(path)
  if (drive) path = `/${drive[1]!.toLowerCase()}:${drive[2] ?? '/'}`
  return host && host !== 'localhost' ? `//${host}${path}` : path
}

export function isSameFile(a: string, b: string): boolean {
  const ka = canonicalFileKey(a)
  return ka !== null && ka === canonicalFileKey(b)
}

/** Model content is there: enough lines for the target and not the empty pre-load placeholder. */
export function isModelReady(model: ModelLike, range: RangeLike): boolean {
  return model.getValueLength() > 0 && model.getLineCount() >= range.startLineNumber
}

export function applyReveal(editor: EditorLike, range: RangeLike): void {
  editor.setSelection(range)
  editor.revealRangeInCenter(range, SCROLL_IMMEDIATE)
  editor.focus()
}

export type RevealDeps = {
  now(): number
  /** Resolves on the next animation frame (with a timer fallback for hidden windows). */
  frame(): Promise<void>
  log?(message: string): void
}

const modelKey = (editor: EditorLike): string | null => {
  const model = editor.getModel()
  if (!model || model.isDisposed?.()) return null
  return canonicalFileKey(model.uri.toString())
}

/**
 * Wait 2 frames, then until the model has content (max CONTENT_WAIT_MS), then reveal.
 * Resolves false when the editor stopped showing the target in the meantime.
 */
export async function revealWhenReady(
  editor: EditorLike,
  pending: PendingReveal,
  deps: RevealDeps
): Promise<boolean> {
  await deps.frame()
  await deps.frame()
  const start = deps.now()
  for (;;) {
    if (modelKey(editor) !== pending.key) return false
    const model = editor.getModel()!
    if (isModelReady(model, pending.range) || deps.now() - start >= CONTENT_WAIT_MS) {
      applyReveal(editor, pending.range)
      return true
    }
    await deps.frame()
  }
}

/** Tracks one pending reveal and applies it to whichever editor shows the target first. */
export class RevealWatcher {
  private pendingValue: PendingReveal | null = null
  private readonly watched = new WeakSet<object>()
  private readonly subscription: DisposableLike | null = null

  constructor(
    private readonly editorApi: EditorApiLike,
    private readonly deps: RevealDeps
  ) {
    this.subscription = editorApi.onDidCreateEditor((editor) => this.watch(editor))
    for (const editor of editorApi.getEditors?.() ?? []) this.watch(editor)
  }

  get pending(): PendingReveal | null {
    if (this.pendingValue && this.deps.now() - this.pendingValue.at > PENDING_TTL_MS) {
      this.pendingValue = null
    }
    return this.pendingValue
  }

  /** Remember a target (replacing any older one). Returns the record for `clear(record)`. */
  expect(target: { uri: string; range: RangeLike }): PendingReveal | null {
    const key = canonicalFileKey(target.uri)
    if (!key) return null
    this.pendingValue = { uri: target.uri, key, range: target.range, at: this.deps.now() }
    return this.pendingValue
  }

  /** Drop the pending reveal (only if it is still `record`, when given). */
  clear(record?: PendingReveal | null): void {
    if (!record || this.pendingValue === record) this.pendingValue = null
  }

  /** Check every known editor now (e.g. the target was already open). */
  checkAll(): void {
    for (const editor of this.editorApi.getEditors?.() ?? []) this.check(editor)
  }

  dispose(): void {
    this.subscription?.dispose()
    this.pendingValue = null
  }

  private watch(editor: EditorLike): void {
    if (this.watched.has(editor)) return
    this.watched.add(editor)
    const subs: DisposableLike[] = []
    try {
      subs.push(editor.onDidChangeModel(() => this.check(editor)))
      subs.push(editor.onDidChangeModelContent(() => this.check(editor)))
      subs.push(
        editor.onDidDispose(() => {
          for (const s of subs.splice(0)) s.dispose()
        })
      )
    } catch (error) {
      this.deps.log?.(`cannot watch editor: ${String(error)}`)
    }
    // The model is usually attached right after onDidCreateEditor; also check on the next tick.
    queueMicrotask(() => this.check(editor))
  }

  private check(editor: EditorLike): void {
    const pending = this.pending
    if (!pending || modelKey(editor) !== pending.key) return
    // Claim it so content-change events do not start a second reveal.
    this.pendingValue = null
    void revealWhenReady(editor, pending, this.deps).then(
      (done) => {
        if (!done && this.pendingValue === null && this.deps.now() - pending.at <= PENDING_TTL_MS) {
          this.pendingValue = pending
        }
      },
      (error: unknown) => this.deps.log?.(`reveal failed: ${String(error)}`)
    )
  }
}
