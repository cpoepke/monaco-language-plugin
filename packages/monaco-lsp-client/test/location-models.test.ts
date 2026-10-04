// Adapted from stablyai/orca PR #24703 (MIT). See vendor/orca-lsp.
import { describe, expect, it, vi } from 'vitest'
import { URI } from 'monaco-editor/esm/vs/base/common/uri.js'
import {
  LocationModels,
  MAX_LOCATION_FILES,
  PEEK_SCHEME,
  type LocationModelMonaco,
  type ReadFile
} from '../src/location-models'

type FakeModel = {
  isAttachedToEditor: () => boolean
  dispose: () => void
  isDisposed?: () => boolean
  getValue: () => string
  setValue: (value: string) => void
  language?: string
}

function fakeMonaco(existing: string[] = []): LocationModelMonaco<URI> & {
  created: string[]
  disposedUris: string[]
  models: Map<string, FakeModel>
} {
  const created: string[] = []
  const disposedUris: string[] = []
  const models = new Map<string, FakeModel>()
  for (const uri of existing) {
    models.set(uri, {
      isAttachedToEditor: () => true,
      dispose: vi.fn(),
      getValue: () => '',
      setValue: vi.fn()
    })
  }
  return {
    created,
    disposedUris,
    models,
    Uri: URI,
    editor: {
      getModel: (uri) => models.get(uri.toString()) ?? null,
      createModel: (initial, language, uri) => {
        created.push(uri.toString())
        let disposed = false
        let value = initial
        const model: FakeModel = {
          language,
          isAttachedToEditor: () => false,
          dispose: () => {
            disposed = true
            disposedUris.push(uri.toString())
            models.delete(uri.toString())
          },
          isDisposed: () => disposed,
          getValue: () => value,
          setValue: vi.fn((next: string) => {
            value = next
          })
        }
        models.set(uri.toString(), model)
        return model
      }
    }
  }
}

const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }
const text = (value: string): ReturnType<ReadFile> =>
  Promise.resolve({ text: value, languageId: 'typescript' })

describe('LocationModels', () => {
  it('reuses an open file model even when the server spells the URI differently', async () => {
    const monaco = fakeMonaco([URI.file('C:/src/a.ts').toString()])
    const readFile = vi.fn<ReadFile>()
    const result = await new LocationModels(monaco, readFile).resolve([
      { uri: 'file:///C:/src/a.ts', range }
    ])
    expect(result[0]?.uri.toString()).toBe(URI.file('C:/src/a.ts').toString())
    expect(readFile).not.toHaveBeenCalled()
  })

  it('creates language-tagged peek models for unopened files and drops unreadable ones', async () => {
    const monaco = fakeMonaco()
    const readFile = vi.fn<ReadFile>(async (uri) =>
      uri.endsWith('missing.ts') ? null : { text: 'x', languageId: 'typescript' }
    )
    const result = await new LocationModels(monaco, readFile).resolve([
      { uri: 'file:///repo/b.ts', range },
      { uri: 'file:///repo/missing.ts', range }
    ])
    expect(result).toHaveLength(1)
    expect(result[0]?.uri.scheme).toBe(PEEK_SCHEME)
    expect(result[0]?.uri.path).toBe('/repo/b.ts')
    expect(result[0]?.range).toEqual({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 2
    })
    expect(readFile).toHaveBeenCalledWith('file:///repo/b.ts')
    expect(monaco.models.get(result[0]!.uri.toString())?.language).toBe('typescript')
  })

  it('resolveEach stays aligned with its input', async () => {
    const monaco = fakeMonaco()
    const readFile = vi.fn<ReadFile>(async (uri) =>
      uri.endsWith('gone.ts') ? null : await text('x')
    )
    const result = await new LocationModels(monaco, readFile).resolveEach([
      { uri: 'file:///repo/gone.ts', range },
      { uri: 'file:///repo/here.ts', range }
    ])
    expect(result[0]).toBeNull()
    expect(result[1]?.uri.path).toBe('/repo/here.ts')
  })

  it('reads at most MAX_LOCATION_FILES distinct files', async () => {
    const monaco = fakeMonaco()
    const readFile = vi.fn<ReadFile>(() => text('x'))
    const locations = Array.from({ length: MAX_LOCATION_FILES + 50 }, (_, i) => ({
      uri: `file:///repo/f${i}.ts`,
      range
    }))
    const result = await new LocationModels(monaco, readFile).resolve(locations)
    expect(readFile).toHaveBeenCalledTimes(MAX_LOCATION_FILES)
    expect(result).toHaveLength(MAX_LOCATION_FILES)
  })

  it('keeps every model of the current result alive, then prunes to the cap on the next resolve', async () => {
    const monaco = fakeMonaco()
    const models = new LocationModels(monaco, () => text('x'))
    const locations = Array.from({ length: 80 }, (_, i) => ({
      uri: `file:///pool/f${i}.ts`,
      range
    }))
    expect(await models.resolve(locations)).toHaveLength(80)
    expect(monaco.disposedUris).toEqual([])

    await models.resolve([{ uri: 'file:///other/x.ts', range }])
    expect(monaco.disposedUris).toHaveLength(31)
    // Oldest first: the earliest entries of the previous result went.
    expect(monaco.disposedUris[0]).toBe(
      URI.from({ scheme: PEEK_SCHEME, path: '/pool/f0.ts' }).toString()
    )
  })

  it('refreshes a reused detached peek model, and drops it once unreadable', async () => {
    const monaco = fakeMonaco()
    let disk: string | null = 'v1'
    const models = new LocationModels(monaco, async () => {
      if (disk === null) {
        throw new Error('gone')
      }
      return { text: disk, languageId: null }
    })
    const locations = [{ uri: 'file:///refresh/a.ts', range }]
    const [first] = await models.resolve(locations)
    disk = 'v2'
    const [second] = await models.resolve(locations)
    expect(second?.uri.toString()).toBe(first?.uri.toString())
    expect(monaco.created).toHaveLength(1)
    expect(monaco.models.get(first!.uri.toString())?.getValue()).toBe('v2')

    disk = null
    expect(await models.resolve(locations)).toEqual([])
    expect(monaco.disposedUris).toContain(first!.uri.toString())
  })

  it('starts every file read before awaiting any of them', async () => {
    const monaco = fakeMonaco()
    const resolvers: (() => void)[] = []
    const readFile = vi.fn<ReadFile>(
      () =>
        new Promise((resolve) => {
          resolvers.push(() => resolve({ text: 'x', languageId: null }))
        })
    )
    const result = new LocationModels(monaco, readFile).resolve([
      { uri: 'file:///concurrent/a.ts', range },
      { uri: 'file:///concurrent/b.ts', range }
    ])
    await Promise.resolve()
    expect(readFile).toHaveBeenCalledTimes(2)
    resolvers.forEach((resolve) => resolve())
    expect(await result).toHaveLength(2)
  })

  it('dispose() removes the peek models it created', async () => {
    const monaco = fakeMonaco()
    const models = new LocationModels(monaco, () => text('x'))
    await models.resolve([{ uri: 'file:///d/a.ts', range }])
    models.dispose()
    expect(monaco.models.size).toBe(0)
  })

  it('creates no peek models for reads that finish after dispose()', async () => {
    const monaco = fakeMonaco()
    let finish!: () => void
    const readFile = vi.fn(
      () =>
        new Promise<{ text: string; languageId: string }>(
          (resolve) => (finish = () => resolve({ text: 'late', languageId: 'typescript' }))
        )
    )
    const models = new LocationModels(monaco, readFile)
    const result = models.resolveEach([{ uri: 'file:///d/late.ts', range }])
    await vi.waitFor(() => expect(readFile).toHaveBeenCalled())
    models.dispose()
    finish()
    expect(await result).toEqual([null])
    expect(monaco.created).toEqual([])
    expect(monaco.models.size).toBe(0)
    // and nothing new is read or created afterwards
    expect(await models.resolve([{ uri: 'file:///d/other.ts', range }])).toEqual([])
    expect(readFile).toHaveBeenCalledTimes(1)
    expect(monaco.created).toEqual([])
  })
})

describe('LocationModels edge cases', () => {
  it('skips URIs Monaco cannot parse and resolves the rest', async () => {
    const monaco = fakeMonaco()
    const parse = monaco.Uri.parse.bind(monaco.Uri)
    monaco.Uri = {
      parse: (value: string) => {
        if (value === 'bad') throw new Error('Unable to parse')
        return parse(value)
      },
      from: URI.from.bind(URI)
    } as never
    const result = await new LocationModels(monaco, () => text('x')).resolveEach([
      { uri: 'bad', range },
      { uri: 'file:///repo/a.ts', range }
    ])
    expect(result[0]).toBeNull()
    expect(result[1]?.uri.path).toBe('/repo/a.ts')
  })

  it('reads a file once for several locations in it', async () => {
    const monaco = fakeMonaco()
    const readFile = vi.fn<ReadFile>(() => text('x'))
    const result = await new LocationModels(monaco, readFile).resolve([
      { uri: 'file:///repo/a.ts', range },
      { uri: 'file:///repo/a.ts', range },
      { uri: 'file:///repo/a.ts', range }
    ])
    expect(result).toHaveLength(3)
    expect(readFile).toHaveBeenCalledTimes(1)
    expect(monaco.created).toHaveLength(1)
  })

  it('only shows non-file URIs that already have a model, and never reads them', async () => {
    const monaco = fakeMonaco(['untitled:Untitled-1'])
    const readFile = vi.fn<ReadFile>()
    const result = await new LocationModels(monaco, readFile).resolveEach([
      { uri: 'untitled:Untitled-1', range },
      { uri: 'jdt://contents/Foo.class', range }
    ])
    expect(result[0]?.uri.toString()).toBe('untitled:Untitled-1')
    expect(result[1]).toBeNull()
    expect(readFile).not.toHaveBeenCalled()
  })

  it('leaves a peek model that an editor is showing alone, without reading', async () => {
    const peek = URI.from({ scheme: PEEK_SCHEME, path: '/repo/a.ts' }).toString()
    const monaco = fakeMonaco([peek])
    const readFile = vi.fn<ReadFile>()
    const result = await new LocationModels(monaco, readFile).resolve([
      { uri: 'file:///repo/a.ts', range }
    ])
    expect(result[0]?.uri.toString()).toBe(peek)
    expect(readFile).not.toHaveBeenCalled()
  })

  it('does not touch a peek model that became visible while its file was being read', async () => {
    const monaco = fakeMonaco()
    const peekUri = URI.from({ scheme: PEEK_SCHEME, path: '/repo/a.ts' })
    // a detached stale model exists when the resolve starts ...
    monaco.editor.createModel('stale', 'typescript', peekUri)
    const model = monaco.models.get(peekUri.toString())!
    const readFile = vi.fn<ReadFile>(async () => {
      // ... and an editor attaches it while the read is in flight
      model.isAttachedToEditor = () => true
      return { text: 'fresh', languageId: 'typescript' }
    })
    const result = await new LocationModels(monaco, readFile).resolve([
      { uri: 'file:///repo/a.ts', range }
    ])
    expect(result[0]?.uri.toString()).toBe(peekUri.toString())
    expect(model.setValue).not.toHaveBeenCalled()
    expect(model.getValue()).toBe('stale')
  })

  it('keeps an up-to-date detached peek model as it is', async () => {
    const monaco = fakeMonaco()
    const peekUri = URI.from({ scheme: PEEK_SCHEME, path: '/repo/a.ts' })
    monaco.editor.createModel('same', 'typescript', peekUri)
    const model = monaco.models.get(peekUri.toString())!
    await new LocationModels(monaco, () => text('same')).resolve([
      { uri: 'file:///repo/a.ts', range }
    ])
    expect(model.setValue).not.toHaveBeenCalled()
  })

  it('treats a read that rejects as unreadable', async () => {
    const monaco = fakeMonaco()
    const result = await new LocationModels(monaco, () =>
      Promise.reject(new Error('socket'))
    ).resolve([{ uri: 'file:///repo/a.ts', range }])
    expect(result).toEqual([])
    expect(monaco.created).toEqual([])
  })

  it('creates a model without a language when the bridge does not report one', async () => {
    const monaco = fakeMonaco()
    await new LocationModels(monaco, async () => ({ text: 'x', languageId: null })).resolve([
      { uri: 'file:///repo/a.ts', range }
    ])
    expect([...monaco.models.values()][0]?.language).toBeUndefined()
  })
})
