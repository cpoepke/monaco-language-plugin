/** Reveal watcher and guard: editors that throw, vanish or change model mid-reveal. */
import { describe, expect, it, vi } from 'vitest'
import {
  CONTENT_WAIT_MS,
  PENDING_TTL_MS,
  REVEAL_GUARD_MS,
  applyReveal,
  canonicalFileKey,
  guardReveal,
  revealWhenReady,
  RevealWatcher,
  type EditorLike
} from '../src/reveal'
import { FakeEditor, FakeEditorApi, FakeModel, FrameClock, flush, range } from './fakes'

const target = 'file:///repo/b.ts'
const pending = (at = 0) => ({ uri: target, key: canonicalFileKey(target)!, range: range(2), at })

describe('canonicalFileKey', () => {
  it('handles hosts, missing paths, backslashes and malformed escapes', () => {
    expect(canonicalFileKey('file://HOST/Share/a.ts')).toBe('//host/Share/a.ts')
    expect(canonicalFileKey('file:///')).toBe('/')
    expect(canonicalFileKey('file://')).toBe('/')
    expect(canonicalFileKey('file:///c:\\Users\\Me\\a.ts')).toBe('/c:/Users/Me/a.ts')
    expect(canonicalFileKey('file:///C:')).toBe('/c:/')
    expect(canonicalFileKey('file:///a%ZZb')).toBeNull()
    expect(canonicalFileKey('FILE:///Repo/A.ts')).toBe('/Repo/A.ts')
    expect(canonicalFileKey('file:///a/b.ts?x=1#frag')).toBe('/a/b.ts')
  })
})

describe('guardReveal', () => {
  const deps = (clock = new FrameClock()) => ({
    now: clock.now,
    frame: clock.frame,
    log: vi.fn()
  })

  it('does nothing for editors that cannot report cursor changes', () => {
    const editor = new FakeEditor()
    editor.onDidChangeCursorSelection = undefined as never
    guardReveal(editor, pending(), deps())
  })

  it('stops when the model changes, when the editor is disposed, and ignores later moves', async () => {
    const editor = new FakeEditor()
    editor.setModel(new FakeModel(target, 'a\nb\nc'))
    guardReveal(editor, pending(), deps())
    editor.setModel(new FakeModel('file:///repo/other.ts', 'x'))
    editor.setSelection(range(1, 1))
    await flush()
    expect(editor.revealed).toBeNull()
  })

  it('stops quietly when the model changed between the selection event and its re-apply', async () => {
    const editor = new FakeEditor()
    editor.setModel(new FakeModel(target, 'a\nb\nc'))
    const d = deps()
    guardReveal(editor, pending(), d)
    editor.setSelection(range(1, 1))
    editor.model = new FakeModel('file:///repo/other.ts', 'x') // silently swapped, no event
    await flush()
    expect(editor.revealed).toBeNull()
    expect(d.log).not.toHaveBeenCalled()
  })

  it('stops when the target model was disposed meanwhile', async () => {
    const editor = new FakeEditor()
    const model = new FakeModel(target, 'a\nb\nc')
    editor.setModel(model)
    guardReveal(editor, pending(), deps())
    editor.setSelection(range(1, 1))
    model.disposed = true
    await flush()
    expect(editor.revealed).toBeNull()
  })

  it('ignores moves that land on the revealed range', async () => {
    const editor = new FakeEditor()
    editor.setModel(new FakeModel(target, 'a\nb\nc'))
    guardReveal(editor, pending(), deps())
    editor.setSelection(range(2))
    await flush()
    expect(editor.revealed).toBeNull()
  })

  it('works with editors that have no getSelection', async () => {
    const editor = new FakeEditor()
    editor.getSelection = undefined as never
    editor.setModel(new FakeModel(target, 'a\nb\nc'))
    guardReveal(editor, pending(), deps())
    editor.setSelection(range(1, 1))
    await flush()
    expect(editor.revealed).toEqual(range(2))
  })

  it('gives up when it cannot subscribe', () => {
    const editor = new FakeEditor()
    editor.onDidChangeModel = () => {
      throw new Error('disposed editor')
    }
    const d = deps()
    guardReveal(editor, pending(), d)
    expect(d.log).toHaveBeenCalledWith(expect.stringContaining('cannot guard the reveal'))
    // the half-installed cursor subscription was released
    editor.setModel(new FakeModel(target, 'a'))
    editor.setSelection(range(1, 1))
    expect(editor.revealed).toBeNull()
  })

  it('uses real timers when none are injected', async () => {
    vi.useFakeTimers()
    try {
      const editor = new FakeEditor()
      editor.setModel(new FakeModel(target, 'a\nb\nc'))
      guardReveal(editor, pending(), { now: () => 0, frame: async () => {} })
      vi.advanceTimersByTime(REVEAL_GUARD_MS)
      editor.setSelection(range(1, 1))
      await vi.advanceTimersByTimeAsync(0)
      expect(editor.revealed).toBeNull() // the window was over: not re-applied
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops on a non-programmatic event without a source', async () => {
    const editor = new FakeEditor()
    editor.setModel(new FakeModel(target, 'a\nb\nc'))
    guardReveal(editor, pending(), deps())
    ;(
      editor as unknown as { selectionListeners: Set<(e?: unknown) => void> }
    ).selectionListeners.forEach((l) => l(undefined))
    editor.setSelection(range(1, 1))
    await flush()
    expect(editor.revealed).toBeNull()
  })
})

describe('revealWhenReady', () => {
  it('reveals a model that is already complete after two frames', async () => {
    const clock = new FrameClock()
    const editor = new FakeEditor()
    editor.setModel(new FakeModel(target, 'a\nb\nc'))
    const done = revealWhenReady(editor, pending(), clock)
    await clock.tick(1)
    expect(editor.revealed).toBeNull()
    await clock.tick(1)
    await expect(done).resolves.toBe(true)
    expect(editor.focused).toBe(1)
  })

  it('gives up when the editor loses its model or the model is disposed', async () => {
    const clock = new FrameClock()
    const editor = new FakeEditor()
    editor.setModel(new FakeModel(target, ''))
    const done = revealWhenReady(editor, pending(), clock)
    editor.setModel(null)
    await clock.tick(3)
    await expect(done).resolves.toBe(false)

    const disposedEditor = new FakeEditor()
    const model = new FakeModel(target, '')
    disposedEditor.setModel(model)
    const second = revealWhenReady(disposedEditor, pending(), clock)
    model.disposed = true
    await clock.tick(3)
    await expect(second).resolves.toBe(false)
  })

  it('does not wait longer than the content cap', async () => {
    const clock = new FrameClock()
    const editor = new FakeEditor()
    editor.setModel(new FakeModel(target, ''))
    const done = revealWhenReady(editor, pending(), clock)
    await clock.tick(2)
    await clock.tick(1, CONTENT_WAIT_MS)
    await expect(done).resolves.toBe(true)
  })
})

describe('applyReveal', () => {
  it('selects, reveals in the centre and focuses', () => {
    const editor = new FakeEditor()
    applyReveal(editor, range(4))
    expect(editor.selection).toEqual(range(4))
    expect(editor.revealed).toEqual(range(4))
    expect(editor.focused).toBe(1)
  })
})

describe('RevealWatcher', () => {
  it('ignores targets that are not file URIs', () => {
    const watcher = new RevealWatcher(new FakeEditorApi(), new FrameClock())
    expect(watcher.expect({ uri: 'inmemory://model/1', range: range(1) })).toBeNull()
    expect(watcher.pending).toBeNull()
  })

  it('does not watch an editor twice and survives editors that cannot be subscribed to', () => {
    const api = new FakeEditorApi()
    const log = vi.fn()
    const clock = new FrameClock()
    const watcher = new RevealWatcher(api, { ...clock, now: clock.now, frame: clock.frame, log })
    const broken = new FakeEditor()
    broken.onDidChangeModelContent = () => {
      throw new Error('disposed')
    }
    api.editors.push(broken)
    ;(api as unknown as { createListeners: Set<(e: FakeEditor) => void> }).createListeners.forEach(
      (l) => l(broken)
    )
    expect(log).toHaveBeenCalledWith(expect.stringContaining('cannot watch editor'))
    const editor = api.create()
    ;(api as unknown as { createListeners: Set<(e: FakeEditor) => void> }).createListeners.forEach(
      (l) => l(editor)
    )
    expect(watcher.pending).toBeNull()
  })

  it('forgets a disposed editor’s subscriptions', async () => {
    const api = new FakeEditorApi()
    const watcher = new RevealWatcher(api, new FrameClock())
    const editor = api.create()
    await flush() // the check queued when the editor was first seen
    const disposeListeners = (editor as unknown as { disposeListeners: Set<() => void> })
      .disposeListeners
    expect(disposeListeners.size).toBe(1)
    ;[...disposeListeners].forEach((l) => l())
    watcher.expect({ uri: target, range: range(1) })
    editor.setModel(new FakeModel(target, 'a'))
    await flush()
    expect(watcher.pending).not.toBeNull() // the disposed editor no longer reacts
  })

  it('watches editors that exist at construction and stops after dispose', async () => {
    const clock = new FrameClock()
    const api = new FakeEditorApi()
    const existing = api.create()
    const watcher = new RevealWatcher(api, clock)
    watcher.expect({ uri: target, range: range(2) })
    existing.setModel(new FakeModel(target, 'a\nb'))
    await clock.tick(3)
    expect(existing.revealed).toEqual(range(2))

    watcher.expect({ uri: target, range: range(1) })
    watcher.dispose()
    expect(watcher.pending).toBeNull()
    const late = api.create() // no longer observed
    late.setModel(new FakeModel(target, 'a'))
    await clock.tick(3)
    expect(late.revealed).toBeNull()
  })

  it('works with an editor API that cannot list its editors', async () => {
    const clock = new FrameClock()
    const created: ((e: FakeEditor) => void)[] = []
    const watcher = new RevealWatcher(
      { onDidCreateEditor: (l) => (created.push(l), { dispose() {} }) },
      clock
    )
    watcher.checkAll()
    watcher.expect({ uri: target, range: range(1) })
    const editor = new FakeEditor()
    editor.setModel(new FakeModel(target, 'a'))
    created[0]!(editor)
    await flush()
    await clock.tick(3)
    expect(editor.revealed).toEqual(range(1))
  })

  it('keeps the pending reveal when the editor stopped showing the file, until it expires', async () => {
    const clock = new FrameClock()
    const api = new FakeEditorApi()
    const watcher = new RevealWatcher(api, clock)
    const editor = api.create()
    watcher.expect({ uri: target, range: range(1) })
    editor.setModel(new FakeModel(target, '')) // claimed ...
    editor.setModel(new FakeModel('file:///repo/other.ts', 'x')) // ... then the editor moved on
    await clock.tick(3)
    expect(editor.revealed).toBeNull()
    expect(watcher.pending?.uri).toBe(target) // restored for the next editor
    clock.t += PENDING_TTL_MS + 1
    expect(watcher.pending).toBeNull()
  })

  it('does not restore a pending reveal that expired or was replaced meanwhile', async () => {
    const clock = new FrameClock()
    const api = new FakeEditorApi()
    const watcher = new RevealWatcher(api, clock)
    const editor = api.create()
    watcher.expect({ uri: target, range: range(1) })
    editor.setModel(new FakeModel(target, ''))
    editor.setModel(new FakeModel('file:///repo/other.ts', 'x'))
    watcher.expect({ uri: 'file:///repo/c.ts', range: range(1) }) // replaced
    await clock.tick(3)
    expect(watcher.pending?.uri).toBe('file:///repo/c.ts')
  })

  it('reports a failing reveal instead of throwing', async () => {
    const clock = new FrameClock()
    const log = vi.fn()
    const api = new FakeEditorApi()
    const watcher = new RevealWatcher(api, { now: clock.now, frame: clock.frame, log })
    const editor = api.create()
    editor.setModel(new FakeModel(target, 'a\nb\nc'))
    editor.focus = () => {
      throw new Error('editor disposed')
    }
    watcher.expect({ uri: target, range: range(2) })
    watcher.checkAll()
    await clock.tick(3)
    expect(log).toHaveBeenCalledWith('reveal failed: Error: editor disposed')
  })
})

describe('EditorLike contract used by fakes', () => {
  it('FakeEditor satisfies EditorLike', () => {
    const editor: EditorLike = new FakeEditor()
    expect(editor.getModel()).toBeNull()
  })
})
