// Adapted from stablyai/orca PR #14873 (MIT). See vendor/orca-lsp.
import { describe, expect, it } from 'vitest'
import {
  fileUriKey,
  fileUriToPath,
  isSafeLinkTarget,
  isSameFileUri,
  lspDiagnosticsToMonacoMarkers,
  lspDocumentLinkToMonaco,
  lspDocumentLinksToMonaco,
  lspDocumentSymbolsToMonaco,
  lspHoverToMonaco,
  lspLocationsFromResult,
  lspPullDiagnosticsToItems,
  lspRangeToMonaco,
  monacoRangeToLsp,
  toLspPosition
} from '../src/conversion'

const lspRange = { start: { line: 0, character: 4 }, end: { line: 2, character: 0 } }
const monacoRange = { startLineNumber: 1, startColumn: 5, endLineNumber: 3, endColumn: 1 }

describe('position and range mapping', () => {
  it('shifts Monaco 1-based positions to LSP 0-based', () => {
    expect(toLspPosition({ lineNumber: 10, column: 3 })).toEqual({ line: 9, character: 2 })
  })

  it('round-trips ranges', () => {
    expect(lspRangeToMonaco(lspRange)).toEqual(monacoRange)
    expect(monacoRangeToLsp(monacoRange)).toEqual(lspRange)
  })
})

describe('lspHoverToMonaco', () => {
  it('handles MarkupContent and never trusts it', () => {
    expect(lspHoverToMonaco({ contents: { kind: 'markdown', value: '**doc**' } })).toEqual({
      contents: [{ value: '**doc**', isTrusted: false, supportHtml: false }]
    })
  })

  it('fences language-tagged MarkedStrings and keeps the range', () => {
    const hover = lspHoverToMonaco({
      contents: [{ language: 'typescript', value: 'const x: number' }, 'extra'],
      range: lspRange
    })
    expect(hover?.contents.map((content) => content.value)).toEqual([
      '```typescript\nconst x: number\n```',
      'extra'
    ])
    expect(hover?.range).toEqual(monacoRange)
  })

  it('escapes plaintext markup', () => {
    expect(lspHoverToMonaco({ contents: { kind: 'plaintext', value: 'a*b_c' } })?.contents).toEqual(
      [{ value: 'a\\*b\\_c', isTrusted: false, supportHtml: false }]
    )
  })

  it('returns null for empty hovers', () => {
    expect(lspHoverToMonaco(null)).toBeNull()
    expect(lspHoverToMonaco({ contents: [] })).toBeNull()
    expect(lspHoverToMonaco({ contents: '   ' })).toBeNull()
  })
})

describe('lspLocationsFromResult', () => {
  it('normalizes single Location, Location[], and LocationLink[]', () => {
    const location = { uri: 'file:///a.ts', range: lspRange }
    expect(lspLocationsFromResult(location)).toEqual([location])
    expect(lspLocationsFromResult([location])).toHaveLength(1)
    expect(
      lspLocationsFromResult([
        {
          targetUri: 'file:///b.ts',
          targetRange: { start: { line: 5, character: 0 }, end: { line: 9, character: 0 } },
          targetSelectionRange: lspRange
        }
      ])
    ).toEqual([{ uri: 'file:///b.ts', range: lspRange }])
  })

  it('drops malformed entries and empty results', () => {
    expect(lspLocationsFromResult(null)).toEqual([])
    expect(lspLocationsFromResult([{ uri: 'file:///a.ts' }, 42, null])).toEqual([])
  })
})

describe('lspDiagnosticsToMonacoMarkers', () => {
  const severities = { Error: 8, Warning: 4, Info: 2, Hint: 1 }

  it('maps severity, code objects, and range', () => {
    const markers = lspDiagnosticsToMonacoMarkers(
      [
        { range: lspRange, message: 'bad', severity: 2, code: { value: 2304 }, source: 'ts' },
        { range: lspRange, message: 'unknown severity defaults to error' }
      ],
      severities
    )
    expect(markers[0]).toEqual({
      ...monacoRange,
      severity: 4,
      message: 'bad',
      code: '2304',
      source: 'ts'
    })
    expect(markers[1]?.severity).toBe(8)
  })

  it('drops malformed entries', () => {
    expect(
      lspDiagnosticsToMonacoMarkers(
        [null, { message: 'no range' }, { range: lspRange }],
        severities
      )
    ).toEqual([])
  })

  it('reads full pull reports only', () => {
    const items = [{ range: lspRange, message: 'bad' }]
    expect(lspPullDiagnosticsToItems({ kind: 'full', items })).toBe(items)
    expect(lspPullDiagnosticsToItems({ kind: 'unchanged', resultId: 'a' })).toBeNull()
    expect(lspPullDiagnosticsToItems(null)).toBeNull()
  })
})

describe('lspDocumentSymbolsToMonaco', () => {
  it('maps hierarchical DocumentSymbols with kinds shifted to Monaco', () => {
    const symbols = lspDocumentSymbolsToMonaco([
      {
        name: 'Greeter',
        kind: 5,
        range: lspRange,
        selectionRange: { start: { line: 0, character: 13 }, end: { line: 0, character: 20 } },
        children: [{ name: 'greetPerson', kind: 6, range: lspRange, tags: [1] }]
      }
    ])
    expect(symbols).toEqual([
      {
        name: 'Greeter',
        detail: '',
        kind: 4,
        tags: [],
        range: monacoRange,
        selectionRange: { startLineNumber: 1, startColumn: 14, endLineNumber: 1, endColumn: 21 },
        children: [
          {
            name: 'greetPerson',
            detail: '',
            kind: 5,
            tags: [1],
            range: monacoRange,
            selectionRange: monacoRange
          }
        ]
      }
    ])
  })

  it('maps flat SymbolInformation and drops other documents', () => {
    const symbols = lspDocumentSymbolsToMonaco(
      [
        { name: 'greet', kind: 12, location: { uri: 'file:///a.py', range: lspRange } },
        { name: 'other', kind: 12, location: { uri: 'file:///b.py', range: lspRange } },
        {
          name: 'm',
          kind: 6,
          containerName: 'Greeter',
          location: { uri: 'file:///a.py', range: lspRange }
        }
      ],
      (uri) => uri === 'file:///a.py'
    )
    expect(symbols.map((symbol) => [symbol.name, symbol.kind, symbol.containerName])).toEqual([
      ['greet', 11, undefined],
      ['m', 5, 'Greeter']
    ])
  })
})

describe('lspDocumentLinksToMonaco', () => {
  it('keeps the raw link for resolve and maps target/tooltip', () => {
    const raw = { range: lspRange, data: { id: 1 } }
    const links = lspDocumentLinksToMonaco([
      { range: lspRange, target: 'https://example.com/greeting-guide', tooltip: 'Open' },
      raw,
      { target: 'https://no-range.example' }
    ])
    expect(links).toHaveLength(2)
    expect(links[0]).toMatchObject({
      range: monacoRange,
      url: 'https://example.com/greeting-guide',
      tooltip: 'Open'
    })
    expect(links[1]?.url).toBeUndefined()
    expect(links[1]?.lspLink).toBe(raw)
  })

  it('drops links whose target is not file:, http: or https:', () => {
    const unsafe = [
      'command:workbench.action.terminal.new',
      'COMMAND:editor.action.x',
      'javascript:alert(1)',
      'vscode://file/etc/passwd',
      'data:text/html,<script>1</script>',
      ' command:x',
      'relative/path.ts',
      ''
    ]
    const links = lspDocumentLinksToMonaco([
      ...unsafe.map((target) => ({ range: lspRange, target })),
      { range: lspRange, target: 'FILE:///repo/a.ts' },
      { range: lspRange, target: 'http://example.com' }
    ])
    expect(links.map((link) => link.url)).toEqual(['FILE:///repo/a.ts', 'http://example.com'])
    for (const target of unsafe) {
      expect(isSafeLinkTarget(target)).toBe(false)
      // resolve results go through the single-link mapper: no url means "not resolved"
      expect(lspDocumentLinkToMonaco({ range: lspRange, target }).url).toBeUndefined()
    }
    expect(isSafeLinkTarget('https://x')).toBe(true)
  })
})

describe('file URIs', () => {
  it('decodes posix paths and drops fragments', () => {
    expect(fileUriToPath('file:///Users/dev/my%20project/a.ts')).toBe('/Users/dev/my project/a.ts')
    expect(fileUriToPath('file:///a.ts#L3')).toBe('/a.ts')
  })

  it('converts drive-letter URIs to Windows paths', () => {
    expect(fileUriToPath('file:///C:/dev/repo/a.ts')).toBe('C:\\dev\\repo\\a.ts')
    expect(fileUriToPath('file:///c%3A/dev/a.ts')).toBe('c:\\dev\\a.ts')
  })

  it('rejects non-file and remote-host URIs', () => {
    expect(fileUriToPath('untitled:Untitled-1')).toBeNull()
    expect(fileUriToPath('file://server/share/a.ts')).toBeNull()
    expect(fileUriToPath('file://localhost/a.ts')).toBe('/a.ts')
  })

  it('compares URIs across encodings and drive-letter case', () => {
    expect(isSameFileUri('file:///C:/dev/a.ts', 'file:///c%3A/dev/a.ts')).toBe(true)
    expect(isSameFileUri('file:///repo/a%20b.ts', 'file:///repo/a b.ts')).toBe(true)
    expect(isSameFileUri('file:///repo/a.ts', 'file:///repo/b.ts')).toBe(false)
    expect(isSameFileUri('mlp-peek:/repo/a.ts', 'mlp-peek:/repo/a.ts')).toBe(false)
    expect(fileUriKey('file:///C:/dev/a.ts')).toBe('c:/dev/a.ts')
  })
})
