/** Malformed server output and rarely used shapes for the pure converters. */
import { describe, expect, it } from 'vitest'
import {
  fileUriKey,
  fileUriToPath,
  isLspRange,
  lspDiagnosticsToMonacoMarkers,
  lspDocumentLinkToMonaco,
  lspDocumentLinksToMonaco,
  lspDocumentSymbolsToMonaco,
  lspHoverToMonaco,
  lspLocationsFromResult
} from '../src/conversion'

const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }
const severities = { Error: 8, Warning: 4, Info: 2, Hint: 1 }

describe('lspHoverToMonaco edge cases', () => {
  it('returns null for non-objects and for hovers without contents', () => {
    expect(lspHoverToMonaco(null)).toBeNull()
    expect(lspHoverToMonaco('text')).toBeNull()
    expect(lspHoverToMonaco({})).toBeNull()
    expect(lspHoverToMonaco({ contents: null })).toBeNull()
  })

  it('accepts plain strings, drops blank or malformed parts and never trusts markdown', () => {
    expect(
      lspHoverToMonaco({ contents: ['plain', '   ', { value: 5 }, null, { value: 'md' }] })
    ).toEqual({
      contents: [
        { value: 'plain', isTrusted: false, supportHtml: false },
        { value: 'md', isTrusted: false, supportHtml: false }
      ]
    })
    expect(lspHoverToMonaco({ contents: { value: '   ' } })).toBeNull()
  })

  it('ignores a malformed range', () => {
    expect(lspHoverToMonaco({ contents: 'x', range: { start: 1 } })).toEqual({
      contents: [{ value: 'x', isTrusted: false, supportHtml: false }]
    })
  })
})

describe('lspLocationsFromResult edge cases', () => {
  it('falls back to targetRange when a LocationLink has no selection range', () => {
    expect(lspLocationsFromResult([{ targetUri: 'file:///a.ts', targetRange: range }])).toEqual([
      { uri: 'file:///a.ts', range }
    ])
  })

  it('drops non-object and range-less entries', () => {
    expect(
      lspLocationsFromResult([1, 'x', { uri: 'file:///a.ts' }, { targetUri: 'file:///b.ts' }])
    ).toEqual([])
  })
})

describe('lspDiagnosticsToMonacoMarkers edge cases', () => {
  it('defaults the severity, clamps unknown ones and keeps code and source', () => {
    const markers = lspDiagnosticsToMonacoMarkers(
      [
        { range, message: 'a' },
        { range, message: 'b', severity: 3, code: 7, source: 'ts' },
        { range, message: 'c', severity: 99 },
        { range, message: 'd', code: { value: 'E1' } },
        { range, message: 'e', code: 0 }
      ],
      severities
    )
    expect(markers.map((marker) => marker.severity)).toEqual([8, 2, 8, 8, 8])
    expect(markers[1]).toMatchObject({ code: '7', source: 'ts' })
    expect(markers[3]?.code).toBe('E1')
    expect(markers[4]?.code).toBe('0')
    expect(markers[0]).not.toHaveProperty('code')
    expect(markers[0]).not.toHaveProperty('source')
  })
})

describe('lspDocumentSymbolsToMonaco edge cases', () => {
  it('shifts kinds, falls back for out-of-range ones and keeps deprecation tags', () => {
    const symbols = lspDocumentSymbolsToMonaco([
      { name: 'a', kind: 12, range, selectionRange: range, tags: [1, 2], children: [] },
      { name: 'b', kind: 99, range, deprecated: true },
      { name: 'c', kind: 'x', range, detail: 'detail', tags: [], deprecated: false },
      { name: 'd', range, children: [{ name: 'child', range }, { range }, 'junk'] },
      { name: 'e' },
      { range },
      null
    ]) as { name: string; kind: number; tags: number[]; detail: string; children?: unknown[] }[]
    expect(symbols.map((symbol) => [symbol.name, symbol.kind, symbol.tags])).toEqual([
      ['a', 11, [1]],
      ['b', 12, [1]],
      ['c', 12, []],
      ['d', 12, []]
    ])
    expect(symbols[2]?.detail).toBe('detail')
    expect(symbols[3]?.children).toHaveLength(1)
  })

  it('maps flat SymbolInformation with container names and drops incomplete ones', () => {
    const symbols = lspDocumentSymbolsToMonaco(
      [
        {
          name: 'm',
          kind: 6,
          containerName: 'Cls',
          deprecated: true,
          location: { uri: 'file:///a.ts', range }
        },
        { name: 'n', kind: 6, containerName: '', location: { uri: 'file:///a.ts', range } },
        { kind: 6, location: { uri: 'file:///a.ts', range } },
        { name: 'bad', location: { uri: 'file:///a.ts' } }
      ],
      (uri) => uri === 'file:///a.ts'
    ) as { name: string; containerName?: string; tags: number[] }[]
    expect(symbols.map((s) => s.name)).toEqual(['m', 'n'])
    expect(symbols[0]).toMatchObject({ containerName: 'Cls', tags: [1] })
    expect(symbols[1]).not.toHaveProperty('containerName')
  })

  it('answers an empty outline for a non-array result', () => {
    expect(lspDocumentSymbolsToMonaco(null)).toEqual([])
    expect(lspDocumentSymbolsToMonaco({ name: 'x' })).toEqual([])
  })
})

describe('document links edge cases', () => {
  it('drops malformed links and keeps links without a target for lazy resolve', () => {
    const links = lspDocumentLinksToMonaco([
      null,
      { range: 'bad' },
      { range, target: null },
      { range, target: 'HTTPS://example.com', tooltip: 'open' },
      { range, target: 'vscode://file/x' }
    ])
    expect(links.map((link) => link.url)).toEqual([undefined, 'HTTPS://example.com'])
    expect(links[1]?.tooltip).toBe('open')
    expect(lspDocumentLinksToMonaco('not an array')).toEqual([])
  })

  it('gives a rangeless resolved link a placeholder range and omits empty tooltips', () => {
    expect(lspDocumentLinkToMonaco({ target: 'file:///a.ts', tooltip: '' })).toEqual({
      range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
      url: 'file:///a.ts',
      lspLink: { target: 'file:///a.ts', tooltip: '' }
    })
  })
})

describe('file URIs', () => {
  it('rejects malformed escapes and non-file strings', () => {
    expect(fileUriToPath('file:///%E0%A4%A')).toBeNull()
    expect(fileUriToPath('file:relative')).toBeNull()
    expect(fileUriToPath('http://x/a')).toBeNull()
    expect(fileUriKey('file://server/share/a.ts')).toBeNull()
  })

  it('accepts localhost and maps a bare drive root', () => {
    expect(fileUriToPath('file://localhost/etc/hosts')).toBe('/etc/hosts')
    expect(fileUriToPath('file:///C:')).toBe('C:\\')
    expect(fileUriKey('file:///C:/Dir/A.ts')).toBe('c:/Dir/A.ts')
  })

  it('isLspRange rejects partial ranges', () => {
    expect(isLspRange({ start: { line: 0, character: 0 } })).toBe(false)
    expect(isLspRange(null)).toBe(false)
  })
})
