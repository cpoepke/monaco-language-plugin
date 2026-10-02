import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { nodeModulesBinDirs, resolveExecutable } from './executable-resolver'
import { resolveLspServerForLanguage, toLspDocumentLanguageId } from './server-catalog'

describe.skipIf(process.platform === 'win32')('resolveExecutable (posix)', () => {
  let dir: string
  let binA: string
  let binB: string
  let extra: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'mlp-resolve-'))
    binA = join(dir, 'a')
    binB = join(dir, 'b')
    extra = join(dir, 'extra')
    for (const d of [binA, binB, extra]) {
      mkdirSync(d)
    }
    writeFileSync(join(binA, 'not-executable'), '')
    writeFileSync(join(binB, 'tool'), '#!/bin/sh\n')
    chmodSync(join(binB, 'tool'), 0o755)
    writeFileSync(join(binB, 'not-executable'), '#!/bin/sh\n')
    chmodSync(join(binB, 'not-executable'), 0o755)
    mkdirSync(join(binA, 'tool'))
    writeFileSync(join(extra, 'only-extra'), '#!/bin/sh\n')
    chmodSync(join(extra, 'only-extra'), 0o755)
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('searches PATH in order, skipping directories and non-executable files', () => {
    const pathEnv = [binA, binB].join(':')
    expect(resolveExecutable('tool', { pathEnv, extraDirs: [] })).toBe(join(binB, 'tool'))
    expect(resolveExecutable('not-executable', { pathEnv, extraDirs: [] })).toBe(
      join(binB, 'not-executable')
    )
  })

  it('falls back to extra dirs after PATH', () => {
    expect(resolveExecutable('only-extra', { pathEnv: binA, extraDirs: [] })).toBeNull()
    expect(resolveExecutable('only-extra', { pathEnv: binA, extraDirs: [extra] })).toBe(
      join(extra, 'only-extra')
    )
  })

  it('checks absolute paths directly and refuses relative paths', () => {
    expect(resolveExecutable(join(binB, 'tool'), { pathEnv: '' })).toBe(join(binB, 'tool'))
    expect(resolveExecutable(join(binA, 'not-executable'), { pathEnv: '' })).toBeNull()
    expect(resolveExecutable('./tool', { pathEnv: binB })).toBeNull()
  })

  it('returns null when nothing matches', () => {
    expect(resolveExecutable('definitely-missing-binary', { pathEnv: binB })).toBeNull()
  })
})

describe('resolveExecutable (win32 semantics)', () => {
  const files = new Set(['C:\\tools\\tsls.CMD', 'C:\\bin\\gopls.exe', 'C:\\bin\\exact.cmd'])
  const isExecutable = (candidate: string): boolean =>
    [...files].some((f) => f.toLowerCase() === candidate.toLowerCase())
  const base = {
    platform: 'win32' as const,
    pathEnv: 'C:\\bin;C:\\tools',
    pathExt: '.COM;.EXE;.BAT;.CMD',
    extraDirs: [],
    isExecutable
  }

  it('honours PATHEXT for bare names', () => {
    expect(resolveExecutable('gopls', base)?.toLowerCase()).toBe('c:\\bin\\gopls.exe')
    expect(resolveExecutable('tsls', base)?.toLowerCase()).toBe('c:\\tools\\tsls.cmd')
  })

  it('accepts a name that already carries a PATHEXT extension', () => {
    expect(resolveExecutable('exact.cmd', base)?.toLowerCase()).toBe('c:\\bin\\exact.cmd')
  })

  it('does not run extensionless files', () => {
    expect(resolveExecutable('nothing', base)).toBeNull()
  })
})

describe('nodeModulesBinDirs', () => {
  it('lists node_modules/.bin from the start dir up to the root', () => {
    const dirs = nodeModulesBinDirs(join('/', 'a', 'b'))
    expect(dirs[0]).toBe(join('/', 'a', 'b', 'node_modules', '.bin'))
    expect(dirs.at(-1)).toBe(join('/', 'node_modules', '.bin'))
  })
})

describe('server catalog', () => {
  it('prefers typescript-language-server, then tsgo', () => {
    const resolution = resolveLspServerForLanguage('typescript', {
      pathEnv: '',
      extraDirs: [],
      overrides: { tsgo: { command: process.execPath } }
    })
    expect(resolution.server?.serverId).toBe('tsgo')
    expect(resolution.server?.args).toEqual(['--lsp', '--stdio'])

    const both = resolveLspServerForLanguage('typescript', {
      pathEnv: '',
      extraDirs: [],
      overrides: {
        tsgo: { command: process.execPath },
        'typescript-language-server': { command: process.execPath, args: ['x'] }
      }
    })
    expect(both.server?.serverId).toBe('typescript-language-server')
    expect(both.server?.args).toEqual(['x'])
  })

  it('explains missing and unsupported languages', () => {
    const missing = resolveLspServerForLanguage('go', { pathEnv: '', extraDirs: [] })
    expect(missing.server).toBeNull()
    expect(missing.server === null && missing.reason).toContain('gopls')
    const unsupported = resolveLspServerForLanguage('cobol', { pathEnv: '', extraDirs: [] })
    expect(unsupported.server === null && unsupported.reason).toContain('unsupported')
  })

  it('maps react file extensions to react language ids', () => {
    expect(toLspDocumentLanguageId('typescript', '/a/b.tsx')).toBe('typescriptreact')
    expect(toLspDocumentLanguageId('javascript', '/a/b.jsx')).toBe('javascriptreact')
    expect(toLspDocumentLanguageId('typescript', '/a/b.ts')).toBe('typescript')
    expect(toLspDocumentLanguageId('python', '/a/b.py')).toBe('python')
  })
})
