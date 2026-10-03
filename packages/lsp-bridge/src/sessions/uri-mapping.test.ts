import { describe, expect, it } from 'vitest'
import { derivePrefixMapping, rewriteResultUris, toClientUri } from './uri-mapping'

// Pure-path tests use POSIX URIs; the symlink end-to-end test lives in
// test/bridge-lifecycle.test.ts.
const posix = process.platform !== 'win32'

describe.skipIf(!posix)('derivePrefixMapping', () => {
  const realpaths: Record<string, string> = {
    '/w/link': '/data/real',
    '/tmp': '/private/tmp',
    '/tmp/x': '/private/tmp/x',
    '/w/proj': '/data/proj',
    '/w': '/w'
  }
  const realpath = (path: string): string | null => realpaths[path] ?? path

  it('maps a symlinked directory to its target', () => {
    expect(
      derivePrefixMapping('file:///w/link/src/a.ts', 'file:///data/real/src/a.ts', realpath)
    ).toEqual({ realPrefix: '/data/real', clientPrefixUri: 'file:///w/link' })
  })

  it('prefers the widest prefix that really resolves', () => {
    expect(
      derivePrefixMapping('file:///tmp/x/a.ts', 'file:///private/tmp/x/a.ts', realpath)
    ).toEqual({ realPrefix: '/private/tmp', clientPrefixUri: 'file:///tmp' })
    // `/w` shares no identity with `/data` even though `proj` matches.
    expect(derivePrefixMapping('file:///w/proj/a.ts', 'file:///data/proj/a.ts', realpath)).toEqual({
      realPrefix: '/data/proj',
      clientPrefixUri: 'file:///w/proj'
    })
  })

  it('returns null when nothing maps', () => {
    expect(derivePrefixMapping('file:///a/b.ts', 'file:///a/b.ts', realpath)).toBeNull()
    // A symlinked file (different names): nothing below it to map.
    expect(derivePrefixMapping('file:///a/link.ts', 'file:///a/real.ts', realpath)).toBeNull()
    expect(derivePrefixMapping('untitled:1', 'file:///a/b.ts', realpath)).toBeNull()
  })
})

describe.skipIf(!posix)('rewriteResultUris', () => {
  const mappings = [{ realPrefix: '/data/real', clientPrefixUri: 'file:///w/link' }]

  it('rewrites uri, targetUri and target under the real prefix only', () => {
    const result = rewriteResultUris(
      [
        { uri: 'file:///data/real/src/a.ts', range: {} },
        { targetUri: 'file:///data/real/b%20c.ts', targetRange: {} },
        { target: 'file:///data/real', data: { uri: 'file:///data/other/x.ts' } },
        { uri: 'file:///data/realism/x.ts' },
        { uri: 'https://example.com/data/real/x.ts' },
        { title: 'file:///data/real/not-a-uri-key.ts' }
      ],
      mappings
    )
    expect(result).toEqual([
      { uri: 'file:///w/link/src/a.ts', range: {} },
      { targetUri: 'file:///w/link/b%20c.ts', targetRange: {} },
      { target: 'file:///w/link', data: { uri: 'file:///data/other/x.ts' } },
      { uri: 'file:///data/realism/x.ts' },
      { uri: 'https://example.com/data/real/x.ts' },
      { title: 'file:///data/real/not-a-uri-key.ts' }
    ])
  })

  it('picks the longest matching prefix and leaves values alone without mappings', () => {
    const nested = [
      ...mappings,
      { realPrefix: '/data/real/vendor', clientPrefixUri: 'file:///vendored' }
    ]
    expect(toClientUri('file:///data/real/vendor/x.ts', nested)).toBe('file:///vendored/x.ts')
    const value = { uri: 'file:///data/real/a.ts' }
    expect(rewriteResultUris(value, [])).toBe(value)
    expect(rewriteResultUris(null, mappings)).toBeNull()
  })
})
