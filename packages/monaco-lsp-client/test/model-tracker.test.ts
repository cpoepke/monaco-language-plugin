import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ModelTracker,
  type ModelTrackerOptions,
  type TrackedEditor,
  type TrackedModel,
  type TrackerMonaco
} from '../src/model-tracker'

class Emitter<T> {
  private readonly listeners = new Set<(value: T) => void>()
  readonly event = (listener: (value: T) => void) => {
    this.listeners.add(listener)
    return { dispose: () => void this.listeners.delete(listener) }
  }
  fire(value: T): void {
    for (const listener of [...this.listeners]) listener(value)
  }
  get size(): number {
    return this.listeners.size
  }
}

class Model implements TrackedModel {
  disposed = false
  constructor(readonly uri: { toString(): string }) {}
  isDisposed(): boolean {
    return this.disposed
  }
}
const model = (path: string) => new Model({ toString: () => `file://${path}` })

class Editor implements TrackedEditor<Model> {
  current: Model | null = null
  readonly changed = new Emitter<unknown>()
  readonly disposeEvent = new Emitter<void>()
  readonly focus = new Emitter<void>()
  readonly onDidChangeModel = this.changed.event
  readonly onDidDispose = this.disposeEvent.event
  readonly onDidFocusEditorText = this.focus.event
  getModel(): Model | null {
    return this.current
  }
  show(next: Model | null): void {
    this.current = next
    this.changed.fire({})
  }
  dispose(): void {
    this.disposeEvent.fire()
  }
}

class EditorWithoutFocus implements TrackedEditor<Model> {
  current: Model | null = null
  getModel(): Model | null {
    return this.current
  }
  onDidChangeModel() {
    return { dispose() {} }
  }
  onDidDispose() {
    return { dispose() {} }
  }
}

function setup(
  options: Partial<ModelTrackerOptions<Model>> = {},
  extras: { editors?: TrackedEditor<Model>[]; models?: Model[]; noGetEditors?: boolean } = {}
) {
  const created = new Emitter<TrackedEditor<Model>>()
  const modelCreated = new Emitter<Model>()
  const willDispose = new Emitter<Model>()
  const languageChanged = new Emitter<{ readonly model: Model }>()
  const monaco: TrackerMonaco<Model, TrackedEditor<Model>> = {
    editor: {
      getEditors: extras.noGetEditors ? undefined : () => extras.editors ?? [],
      onDidCreateEditor: created.event,
      getModels: () => extras.models ?? [],
      onDidCreateModel: modelCreated.event,
      onWillDisposeModel: willDispose.event,
      onDidChangeModelLanguage: languageChanged.event
    }
  }
  const attached: string[] = []
  const detached: string[] = []
  const tracker = new ModelTracker(monaco, {
    mode: 'visible',
    detachDelayMs: 100,
    shouldAttach: () => true,
    attach: (m) => attached.push(m.uri.toString()),
    detach: (key) => detached.push(key),
    ...options
  })
  return { tracker, created, modelCreated, willDispose, languageChanged, attached, detached }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('visible mode', () => {
  it('attaches the model an editor shows and detaches it after the grace period', () => {
    const t = setup()
    t.tracker.start()
    const a = model('/a.ts')
    const editor = new Editor()
    editor.current = a
    t.created.fire(editor)
    expect(t.attached).toEqual(['file:///a.ts'])
    expect(t.tracker.isRetained('file:///a.ts')).toBe(true)
    editor.show(null)
    vi.advanceTimersByTime(99)
    expect(t.detached).toEqual([])
    vi.advanceTimersByTime(1)
    expect(t.detached).toEqual(['file:///a.ts'])
    expect(t.tracker.isRetained('file:///a.ts')).toBe(false)
  })

  it('tracks editors that exist before start(), and works without getEditors', () => {
    const existing = new Editor()
    existing.current = model('/a.ts')
    const t = setup({}, { editors: [existing] })
    t.tracker.start()
    expect(t.attached).toEqual(['file:///a.ts'])
    const bare = setup({}, { noGetEditors: true })
    expect(() => bare.tracker.start()).not.toThrow()
  })

  it('does not attach models that no editor shows', () => {
    const t = setup({}, { models: [model('/a.ts')] })
    t.tracker.start()
    t.modelCreated.fire(model('/b.ts'))
    expect(t.attached).toEqual([])
  })

  it('keeps a model while another editor still shows it, and cancels a pending detach on re-show', () => {
    const t = setup()
    t.tracker.start()
    const a = model('/a.ts')
    const first = new Editor()
    const second = new Editor()
    first.current = a
    second.current = a
    t.created.fire(first)
    t.created.fire(second)
    first.show(null)
    vi.advanceTimersByTime(500)
    expect(t.detached).toEqual([])
    second.show(null)
    vi.advanceTimersByTime(50)
    first.show(a) // back within the grace period
    vi.advanceTimersByTime(500)
    expect(t.detached).toEqual([])
    expect(t.tracker.isRetained('file:///a.ts')).toBe(true)
  })

  it('moves retention when an editor switches models', () => {
    const t = setup()
    t.tracker.start()
    const a = model('/a.ts')
    const b = model('/b.ts')
    const editor = new Editor()
    editor.current = a
    t.created.fire(editor)
    editor.show(b)
    expect(t.attached).toEqual(['file:///a.ts', 'file:///b.ts'])
    vi.advanceTimersByTime(100)
    expect(t.detached).toEqual(['file:///a.ts'])
    expect(t.tracker.isRetained('file:///b.ts')).toBe(true)
  })

  it('does not track the same editor twice', () => {
    const t = setup()
    t.tracker.start()
    const editor = new Editor()
    editor.current = model('/a.ts')
    t.created.fire(editor)
    t.created.fire(editor)
    expect(t.attached).toHaveLength(1)
    expect(editor.changed.size).toBe(1)
  })

  it('releases everything of a disposed editor and forgets its focus', () => {
    const t = setup()
    t.tracker.start()
    const editor = new Editor()
    editor.current = model('/a.ts')
    t.created.fire(editor)
    editor.focus.fire()
    expect(t.tracker.focusedEditor).toBe(editor)
    editor.dispose()
    expect(t.tracker.focusedEditor).toBeNull()
    expect(editor.changed.size).toBe(0)
    vi.advanceTimersByTime(100)
    expect(t.detached).toEqual(['file:///a.ts'])
  })

  it('keeps the focus of another editor when one is disposed', () => {
    const t = setup()
    t.tracker.start()
    const one = new Editor()
    const two = new Editor()
    t.created.fire(one)
    t.created.fire(two)
    two.focus.fire()
    one.dispose()
    expect(t.tracker.focusedEditor).toBe(two)
  })

  it('works with editors that cannot report focus', () => {
    const t = setup()
    t.tracker.start()
    const editor = new EditorWithoutFocus()
    editor.current = model('/a.ts')
    t.created.fire(editor)
    expect(t.attached).toEqual(['file:///a.ts'])
    expect(t.tracker.focusedEditor).toBeNull()
  })
})

describe('retain', () => {
  it('counts holders and detaches only after the last one lets go', () => {
    const t = setup()
    const a = model('/a.ts')
    const one = t.tracker.retain(a)
    const two = t.tracker.retain(a)
    expect(t.attached).toEqual(['file:///a.ts', 'file:///a.ts'])
    one.dispose()
    one.dispose() // idempotent: must not release the second holder
    vi.advanceTimersByTime(1000)
    expect(t.detached).toEqual([])
    two.dispose()
    vi.advanceTimersByTime(100)
    expect(t.detached).toEqual(['file:///a.ts'])
  })

  it('cancels the detach timer when re-retained during the grace period', () => {
    const t = setup()
    const a = model('/a.ts')
    t.tracker.retain(a).dispose()
    vi.advanceTimersByTime(60)
    t.tracker.retain(a)
    vi.advanceTimersByTime(1000)
    expect(t.detached).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ignores disposed models and anything after dispose()', () => {
    const t = setup()
    const dead = model('/dead.ts')
    dead.disposed = true
    t.tracker.retain(dead).dispose()
    expect(t.attached).toEqual([])
    t.tracker.dispose()
    t.tracker.retain(model('/a.ts')).dispose()
    expect(t.attached).toEqual([])
  })

  it('detaches instead of attaching when shouldAttach says no', () => {
    const t = setup({ shouldAttach: () => false })
    t.tracker.retain(model('/a.ts'))
    expect(t.attached).toEqual([])
    expect(t.detached).toEqual(['file:///a.ts'])
  })

  it('replaces the record when a different model instance appears under the same uri', () => {
    const t = setup()
    const old = model('/a.ts')
    const next = model('/a.ts')
    const oldHold = t.tracker.retain(old)
    const nextHold = t.tracker.retain(next)
    oldHold.dispose() // stale record: must not drop the new holder's count
    vi.advanceTimersByTime(1000)
    expect(t.detached).toEqual([])
    expect(t.tracker.isRetained('file:///a.ts')).toBe(true)
    nextHold.dispose()
    vi.advanceTimersByTime(100)
    expect(t.detached).toEqual(['file:///a.ts'])
  })

  it('does not detach a model that was re-retained just as its timer fires', () => {
    const t = setup()
    const a = model('/a.ts')
    t.tracker.retain(a).dispose()
    // the model object is replaced while the old timer is pending
    t.tracker.retain(model('/a.ts'))
    vi.advanceTimersByTime(1000)
    expect(t.detached).toEqual([])
  })
})

describe('all mode', () => {
  it('retains existing and newly created models', () => {
    const existing = model('/a.ts')
    const t = setup({ mode: 'all' }, { models: [existing] })
    t.tracker.start()
    expect(t.attached).toEqual(['file:///a.ts'])
    t.modelCreated.fire(model('/b.ts'))
    expect(t.attached).toEqual(['file:///a.ts', 'file:///b.ts'])
  })
})

describe('model lifecycle', () => {
  it('detaches at once when a model is disposed and drops its pending timer', () => {
    const t = setup()
    t.tracker.start()
    const a = model('/a.ts')
    t.tracker.retain(a).dispose() // timer pending
    t.willDispose.fire(a)
    expect(t.detached).toEqual(['file:///a.ts'])
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(1000)
    expect(t.detached).toEqual(['file:///a.ts'])
  })

  it('detaches a disposed model that was retained without a timer', () => {
    const t = setup()
    t.tracker.start()
    const a = model('/a.ts')
    t.tracker.retain(a)
    t.willDispose.fire(a)
    expect(t.detached).toEqual(['file:///a.ts'])
    expect(t.tracker.isRetained('file:///a.ts')).toBe(false)
  })

  it('leaves another model instance of the same uri retained when an old one is disposed', () => {
    const t = setup()
    t.tracker.start()
    const old = model('/a.ts')
    const next = model('/a.ts')
    t.tracker.retain(next)
    t.willDispose.fire(old)
    expect(t.tracker.isRetained('file:///a.ts')).toBe(true)
  })

  it('starts over on a language change, only re-attaching retained models', () => {
    const t = setup()
    t.tracker.start()
    const a = model('/a.ts')
    const b = model('/b.ts')
    t.tracker.retain(a)
    t.languageChanged.fire({ model: a })
    expect(t.detached).toEqual(['file:///a.ts'])
    expect(t.attached).toEqual(['file:///a.ts', 'file:///a.ts'])
    t.languageChanged.fire({ model: b })
    expect(t.detached).toEqual(['file:///a.ts', 'file:///b.ts'])
    expect(t.attached).toHaveLength(2)
  })
})

describe('dispose', () => {
  it('stops listening, drops timers and forgets everything', () => {
    const t = setup()
    t.tracker.start()
    const editor = new Editor()
    editor.current = model('/a.ts')
    t.created.fire(editor)
    editor.focus.fire()
    const b = model('/b.ts')
    t.tracker.retain(b).dispose() // pending timer
    t.tracker.dispose()
    expect(vi.getTimerCount()).toBe(0)
    expect(t.tracker.focusedEditor).toBeNull()
    expect(editor.changed.size).toBe(0)
    expect(t.created.size).toBe(0)
    // late events are ignored
    t.created.fire(new Editor())
    vi.advanceTimersByTime(1000)
    expect(t.detached).toEqual([])
  })
})
