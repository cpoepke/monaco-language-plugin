import { describe, expect, it, vi } from 'vitest'
import { URI } from 'monaco-editor/esm/vs/base/common/uri.js'
import type * as Monaco from 'monaco-editor'
import { PEEK_SCHEME } from '../src/location-models'
import { registerOpeners, resolveEditorOpenTarget, resolveLinkOpenTarget } from '../src/openers'
import { FakeMonaco } from './fake-monaco'

const toFileUri = (path: string) => URI.from({ scheme: 'file', path }).toString()
const range = { startLineNumber: 5, startColumn: 17, endLineNumber: 5, endColumn: 22 }

describe('resolveEditorOpenTarget', () => {
  it('maps a file resource in another model to a host target', () => {
    expect(
      resolveEditorOpenTarget(
        URI.file('/repo/src/greeter.ts'),
        range,
        'file:///repo/src/app.ts',
        toFileUri
      )
    ).toEqual({ uri: 'file:///repo/src/greeter.ts', range })
  })

  it('maps peek models back to their file', () => {
    const peek = URI.from({ scheme: PEEK_SCHEME, path: '/repo/src/my file.ts' })
    expect(resolveEditorOpenTarget(peek, range, 'file:///repo/src/app.ts', toFileUri)).toEqual({
      uri: 'file:///repo/src/my%20file.ts',
      range
    })
  })

  it('turns positions into collapsed ranges and defaults to the file start', () => {
    const target = URI.file('/repo/b.ts')
    expect(
      resolveEditorOpenTarget(target, { lineNumber: 3, column: 4 }, null, toFileUri)?.range
    ).toEqual({ startLineNumber: 3, startColumn: 4, endLineNumber: 3, endColumn: 4 })
    expect(resolveEditorOpenTarget(target, undefined, null, toFileUri)?.range).toEqual({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 1
    })
  })

  it('leaves same-model navigation and foreign schemes to Monaco', () => {
    const self = URI.file('/repo/a.ts')
    expect(resolveEditorOpenTarget(self, range, self.toString(), toFileUri)).toBeNull()
    expect(
      resolveEditorOpenTarget(URI.parse('inmemory://model/1'), range, null, toFileUri)
    ).toBeNull()
  })
})

describe('resolveLinkOpenTarget', () => {
  it('parses file links with line fragments', () => {
    expect(resolveLinkOpenTarget(URI.parse('file:///repo/greeter.ts#L10,18'))).toEqual({
      uri: 'file:///repo/greeter.ts',
      range: { startLineNumber: 10, startColumn: 18, endLineNumber: 10, endColumn: 18 }
    })
  })

  it('ignores http(s) links', () => {
    expect(resolveLinkOpenTarget(URI.parse('https://example.com/greeting-guide'))).toBeNull()
  })
})

describe('registerOpeners', () => {
  it('routes editor and link openers to the host with their source', async () => {
    const monaco = new FakeMonaco()
    const model = monaco.createModel('x', 'typescript', URI.file('/repo/app.ts'))
    const editor = monaco.createEditor(model)
    const open = vi.fn(async () => true)
    registerOpeners(monaco.asMonaco(), open, () => editor as unknown as Monaco.editor.ICodeEditor)

    const [editorOpener] = monaco.editorOpeners
    expect(await editorOpener!.openCodeEditor(editor, URI.file('/repo/greeter.ts'), range)).toBe(
      true
    )
    expect(open).toHaveBeenLastCalledWith(
      { uri: 'file:///repo/greeter.ts', range },
      { editor, modelUri: 'file:///repo/app.ts', reason: 'definition' }
    )
    expect(await editorOpener!.openCodeEditor(editor, URI.file('/repo/app.ts'), range)).toBe(false)

    const [linkOpener] = monaco.linkOpeners
    expect(await linkOpener!.open(URI.parse('file:///repo/greeter.ts#L2'))).toBe(true)
    expect(open).toHaveBeenLastCalledWith(
      {
        uri: 'file:///repo/greeter.ts',
        range: { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 1 }
      },
      { editor, modelUri: 'file:///repo/app.ts', reason: 'link' }
    )
    expect(await linkOpener!.open(URI.parse('https://example.com'))).toBe(false)
    expect(open).toHaveBeenCalledTimes(2)
  })
})
