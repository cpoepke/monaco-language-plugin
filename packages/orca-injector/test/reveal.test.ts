import { describe, expect, it, vi } from 'vitest'
import {
  canonicalFileKey,
  CONTENT_WAIT_MS,
  isModelReady,
  isSameFile,
  MAX_REVEAL_REAPPLY,
  PENDING_TTL_MS,
  REVEAL_GUARD_MS,
  revealWhenReady,
  RevealWatcher
} from '../src/reveal'
import { FakeEditor, FakeEditorApi, FakeModel, flush, FrameClock, range } from './fakes'

describe('canonicalFileKey', () => {
  it('decodes and normalizes file URIs', () => {
    expect(canonicalFileKey('file:///repo/src/my%20file.ts')).toBe('/repo/src/my file.ts')
    expect(canonicalFileKey('file:///c%3A/Users/Me/a.ts')).toBe('/c:/Users/Me/a.ts')
    expect(canonicalFileKey('file:///C:/Users/Me/a.ts')).toBe('/c:/Users/Me/a.ts')
    expect(canonicalFileKey('file://server/share/a.ts')).toBe('//server/share/a.ts')
    expect(canonicalFileKey('file://localhost/repo/a.ts')).toBe('/repo/a.ts')
    expect(canonicalFileKey('inmemory://model/1')).toBeNull()
    expect(canonicalFileKey('diff:original:x')).toBeNull()
  })

  it('compares drive letters case-insensitively but paths case-sensitively', () => {
    expect(isSameFile('file:///C%3A/x/A.ts', 'file:///c:/x/A.ts')).toBe(true)
    expect(isSameFile('file:///c:/x/A.ts', 'file:///c:/x/a.ts')).toBe(false)
    expect(isSameFile('inmemory://1', 'inmemory://1')).toBe(false)
  })
})

describe('revealWhenReady', () => {
  const target = 'file:///repo/b.ts'
  const pending = { uri: target, key: canonicalFileKey(target)!, range: range(3, 5), at: 0 }

  it('waits two frames and for content, then selects, reveals and focuses', async () => {
    const clock = new FrameClock()
    const editor = new FakeEditor()
    editor.setModel(new FakeModel(target, '')) // Orca mounts an empty model first
    const done = revealWhenReady(editor, pending, clock)
    await clock.tick(2)
    expect(editor.revealed).toBeNull()
    await clock.tick(3)
    expect(editor.revealed).toBeNull()
    editor.model!.text = 'a\nb\nconst x = 1\n'
    await clock.tick(1)
    await expect(done).resolves.toBe(true)
    expect(editor.selection).toEqual(range(3, 5))
    expect(editor.revealed).toEqual(range(3, 5))
    expect(editor.focused).toBe(1)
  })

  it('reveals after the content wait cap even if the model stays empty', async () => {
    const clock = new FrameClock()
    const editor = new FakeEditor()
    editor.setModel(new FakeModel(target, ''))
    const done = revealWhenReady(editor, pending, clock)
    await clock.tick(2)
    await clock.tick(Math.ceil(CONTENT_WAIT_MS / 16) + 1)
    await expect(done).resolves.toBe(true)
    expect(editor.revealed).toEqual(range(3, 5))
  })

  it('gives up when the editor switches to another model', async () => {
    const clock = new FrameClock()
    const editor = new FakeEditor()
    editor.setModel(new FakeModel(target, ''))
    const done = revealWhenReady(editor, pending, clock)
    editor.setModel(new FakeModel('file:///repo/other.ts', 'x'))
    await clock.tick(3)
    await expect(done).resolves.toBe(false)
    expect(editor.revealed).toBeNull()
  })

  it('re-applies the reveal when the host restores its saved selection right after', async () => {
    // Orca: restoreMonacoViewState → requestAnimationFrame(() => { setSelections(saved);
    // setScrollTop(saved) }) from onMount, which React may run after our two frames.
    const clock = new FrameClock()
    const editor = new FakeEditor()
    editor.setModel(new FakeModel(target, 'a\nb\nc\n'))
    const done = revealWhenReady(editor, pending, clock)
    await clock.tick(2)
    await expect(done).resolves.toBe(true)
    expect(editor.selection).toEqual(range(3, 5))
    editor.setSelection(range(1, 1)) // the host's programmatic restore
    editor.revealed = range(1, 1) // ...and its scroll restore in the same callback
    expect(editor.selection).toEqual(range(1, 1))
    await flush()
    expect(editor.selection).toEqual(range(3, 5))
    expect(editor.revealed).toEqual(range(3, 5))
  })

  it('stops guarding on a user cursor move, after the window, and after MAX re-applies', async () => {
    const clock = new FrameClock()
    const fresh = async (): Promise<FakeEditor> => {
      const editor = new FakeEditor()
      editor.setModel(new FakeModel(target, 'a\nb\nc\n'))
      const done = revealWhenReady(editor, pending, clock)
      await clock.tick(2)
      await done
      return editor
    }
    const user = await fresh()
    user.setSelection(range(2, 1), 'mouse')
    user.setSelection(range(1, 1))
    await flush()
    expect(user.selection).toEqual(range(1, 1))

    vi.useFakeTimers()
    try {
      const late = await fresh()
      vi.advanceTimersByTime(REVEAL_GUARD_MS + 1)
      late.setSelection(range(1, 1))
      await flush()
      expect(late.selection).toEqual(range(1, 1))
    } finally {
      vi.useRealTimers()
    }

    const stubborn = await fresh()
    for (let i = 0; i < MAX_REVEAL_REAPPLY + 2; i++) {
      stubborn.setSelection(range(1, 1))
      await flush()
    }
    expect(stubborn.selection).toEqual(range(1, 1))
  })

  it('isModelReady needs content and enough lines', () => {
    expect(isModelReady(new FakeModel(target, ''), range(1))).toBe(false)
    expect(isModelReady(new FakeModel(target, 'a\nb'), range(3))).toBe(false)
    expect(isModelReady(new FakeModel(target, 'a\nb\nc'), range(3))).toBe(true)
  })
})

describe('RevealWatcher', () => {
  it('reveals in the editor Orca creates for the target file', async () => {
    const clock = new FrameClock()
    const api = new FakeEditorApi()
    const watcher = new RevealWatcher(api, clock)
    watcher.expect({ uri: 'file:///C:/repo/b.ts', range: range(2) })

    const other = api.create()
    other.setModel(new FakeModel('file:///c:/repo/a.ts', 'x\ny'))
    const editor = api.create() // model is attached after creation
    editor.setModel(new FakeModel('file:///c%3A/repo/b.ts', ''))
    await clock.tick(2)
    editor.setText('line1\nline2\n') // async content load
    await clock.tick(1)
    expect(editor.revealed).toEqual(range(2))
    expect(other.revealed).toBeNull()
    expect(watcher.pending).toBeNull()
  })

  it('checkAll reveals in an editor that already shows the file', async () => {
    const clock = new FrameClock()
    const api = new FakeEditorApi()
    const editor = api.create()
    editor.setModel(new FakeModel('file:///repo/b.ts', 'a\nb\nc'))
    const watcher = new RevealWatcher(api, clock)
    watcher.expect({ uri: 'file:///repo/b.ts', range: range(3) })
    watcher.checkAll()
    await clock.tick(2)
    expect(editor.revealed).toEqual(range(3))
  })

  it('expires pending reveals after 10 s and clear() only drops its own record', async () => {
    const clock = new FrameClock()
    const api = new FakeEditorApi()
    const watcher = new RevealWatcher(api, clock)
    const first = watcher.expect({ uri: 'file:///repo/b.ts', range: range(1) })
    watcher.expect({ uri: 'file:///repo/c.ts', range: range(1) })
    watcher.clear(first)
    expect(watcher.pending?.uri).toBe('file:///repo/c.ts')
    clock.t += PENDING_TTL_MS + 1
    expect(watcher.pending).toBeNull()

    watcher.expect({ uri: 'file:///repo/d.ts', range: range(1) })
    clock.t += PENDING_TTL_MS + 1
    const editor = api.create()
    editor.setModel(new FakeModel('file:///repo/d.ts', 'x'))
    await flush()
    await clock.tick(3)
    expect(editor.revealed).toBeNull()
  })
})
