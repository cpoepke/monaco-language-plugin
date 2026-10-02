import { describe, expect, it, vi } from 'vitest'
import { createOrcaHostAdapter, shouldAttachModel, toLspRange } from '../src/host-adapter'
import { FakeEditor, FakeModel, range } from './fakes'

function setup(response: () => Promise<unknown>) {
  const calls: string[] = []
  const watcher = {
    expect: vi.fn((t: { uri: string }) => {
      calls.push(`expect ${t.uri}`)
      return { uri: t.uri, key: t.uri, range: range(1), at: 0 }
    }),
    clear: vi.fn(),
    checkAll: vi.fn()
  }
  const request = vi.fn(async (method: string) => {
    calls.push(`request ${method}`)
    return response()
  })
  const notify = vi.fn()
  const adapter = createOrcaHostAdapter({ request, watcher, notify })
  return { adapter, watcher, request, notify, calls }
}

describe('Orca host adapter', () => {
  it('reveals same-file targets directly in the source editor', async () => {
    const { adapter, request } = setup(async () => ({ opened: true }))
    const editor = new FakeEditor()
    editor.setModel(new FakeModel('file:///c:/repo/a.ts', 'a\nb\nc'))
    const ok = await adapter.openLocation(
      { uri: 'file:///C%3A/repo/a.ts', range: range(3, 2) },
      { editor, modelUri: 'file:///c:/repo/a.ts', reason: 'definition' }
    )
    expect(ok).toBe(true)
    expect(request).not.toHaveBeenCalled()
    expect(editor.selection).toEqual(range(3, 2))
    expect(editor.revealed).toEqual(range(3, 2))
    expect(editor.focused).toBe(1)
  })

  it('arms the reveal watcher, then asks the bridge with a 0-based range', async () => {
    const { adapter, watcher, request, calls } = setup(async () => ({ opened: true }))
    const ok = await adapter.openLocation(
      { uri: 'file:///repo/b.ts', range: range(10, 4) },
      { editor: null, modelUri: 'file:///repo/a.ts', reason: 'definition' }
    )
    expect(ok).toBe(true)
    expect(calls).toEqual(['expect file:///repo/b.ts', 'request host/openLocation'])
    expect(request).toHaveBeenCalledWith('host/openLocation', {
      uri: 'file:///repo/b.ts',
      range: { start: { line: 9, character: 3 }, end: { line: 9, character: 6 } }
    })
    expect(watcher.checkAll).toHaveBeenCalled()
    expect(watcher.clear).not.toHaveBeenCalled()
  })

  it('returns false and shows the reason when Orca cannot open the file', async () => {
    const { adapter, watcher, notify } = setup(async () => ({
      opened: false,
      reason: 'outside every worktree'
    }))
    const ok = await adapter.openLocation(
      { uri: 'file:///usr/lib/node_modules/typescript/lib/lib.d.ts', range: range(1) },
      { editor: null, modelUri: null, reason: 'definition' }
    )
    expect(ok).toBe(false)
    expect(watcher.clear).toHaveBeenCalled()
    expect(notify).toHaveBeenCalledWith('Could not open lib.d.ts', 'outside every worktree')
  })

  it('returns false when the request fails', async () => {
    const { adapter, notify } = setup(async () => {
      throw new Error('Not connected to the bridge')
    })
    const ok = await adapter.openLocation(
      { uri: 'file:///repo/b.ts', range: range(1) },
      { editor: null, modelUri: null }
    )
    expect(ok).toBe(false)
    expect(notify).toHaveBeenCalledWith('Could not open b.ts', 'Not connected to the bridge')
  })

  it('converts ranges to LSP', () => {
    expect(toLspRange(range(1, 1))).toEqual({
      start: { line: 0, character: 0 },
      end: { line: 0, character: 3 }
    })
  })
})

describe('shouldAttachModel', () => {
  const model = (scheme: string, languageId: string, length: number) => ({
    uri: { scheme },
    getLanguageId: () => languageId,
    getValueLength: () => length
  })
  it('attaches only file: models of supported languages up to 2 MB', () => {
    expect(shouldAttachModel(model('file', 'typescript', 10))).toBe(true)
    expect(shouldAttachModel(model('file', 'python', 10))).toBe(true)
    expect(shouldAttachModel(model('file', 'markdown', 10))).toBe(false)
    expect(shouldAttachModel(model('inmemory', 'typescript', 10))).toBe(false)
    expect(shouldAttachModel(model('diff', 'go', 10))).toBe(false)
    expect(shouldAttachModel(model('file', 'rust', 2 * 1024 * 1024 + 1))).toBe(false)
  })
})
