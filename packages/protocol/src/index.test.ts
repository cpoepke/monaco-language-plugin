import { describe, expect, it } from 'vitest'
import { bridgeUrl, isAllowedLspMethod, languageIdForPath } from './index'

describe('protocol helpers', () => {
  it('maps extensions to language ids', () => {
    expect(languageIdForPath('/a/b.tsx')).toBe('typescript')
    expect(languageIdForPath('file:///a/b.py')).toBe('python')
    expect(languageIdForPath('/a/main.go')).toBe('go')
    expect(languageIdForPath('/a/lib.rs')).toBe('rust')
    expect(languageIdForPath('/a/README.md')).toBeNull()
  })

  it('allowlists navigation methods only', () => {
    expect(isAllowedLspMethod('textDocument/definition')).toBe(true)
    expect(isAllowedLspMethod('workspace/executeCommand')).toBe(false)
  })

  it('builds a tokenized url', () => {
    expect(bridgeUrl(1234, 'a b')).toBe('ws://127.0.0.1:1234/?token=a%20b')
  })
})
