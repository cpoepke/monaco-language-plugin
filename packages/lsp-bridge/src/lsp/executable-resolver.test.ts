import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  bridgeBinDirs,
  bridgePackageRoot,
  nodeModulesBinDirs,
  resolveExecutable
} from './executable-resolver'
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
  it('lists node_modules/.bin upwards but never at the filesystem root', () => {
    const dirs = nodeModulesBinDirs(join('/', 'a', 'b'))
    expect(dirs).toEqual([
      join('/', 'a', 'b', 'node_modules', '.bin'),
      join('/', 'a', 'node_modules', '.bin')
    ])
    expect(nodeModulesBinDirs(join('/', 'a', 'b', 'c'), join('/', 'a', 'b'))).toEqual([
      join('/', 'a', 'b', 'c', 'node_modules', '.bin'),
      join('/', 'a', 'b', 'node_modules', '.bin')
    ])
  })

  it('win32: never C:\\node_modules\\.bin (any user can create it)', () => {
    if (process.platform !== 'win32') return
    expect(nodeModulesBinDirs('C:\\a')).toEqual(['C:\\a\\node_modules\\.bin'])
  })
})

describe('bridgeBinDirs', () => {
  let tree: string
  beforeAll(() => {
    tree = mkdtempSync(join(tmpdir(), 'mlp-binwalk-'))
    mkdirSync(join(tree, 'host', 'node_modules', '@mlp', 'lsp-bridge', 'dist'), {
      recursive: true
    })
    writeFileSync(join(tree, 'host', 'package.json'), '{"name":"host-app"}')
    writeFileSync(
      join(tree, 'host', 'node_modules', '@mlp', 'lsp-bridge', 'package.json'),
      '{"name":"@mlp/lsp-bridge"}'
    )
    mkdirSync(join(tree, 'bundled', 'dist'), { recursive: true })
    writeFileSync(join(tree, 'bundled', 'package.json'), '{"name":"some-plugin"}')
  })
  afterAll(() => rmSync(tree, { recursive: true, force: true }))

  it('stops at the bridge package root', () => {
    const bridgeRoot = join(tree, 'host', 'node_modules', '@mlp', 'lsp-bridge')
    const moduleUrl = pathToFileURL(join(bridgeRoot, 'dist', 'index.js')).href
    expect(bridgePackageRoot(join(bridgeRoot, 'dist'))).toBe(bridgeRoot)
    expect(bridgeBinDirs(moduleUrl)).toEqual([
      join(bridgeRoot, 'dist', 'node_modules', '.bin'),
      join(bridgeRoot, 'node_modules', '.bin')
    ])
  })

  it('is empty when the bridge is bundled into another package', () => {
    const moduleUrl = pathToFileURL(join(tree, 'bundled', 'dist', 'main.mjs')).href
    expect(bridgeBinDirs(moduleUrl)).toEqual([])
  })

  it('finds this repo checkout without walking above packages/lsp-bridge', () => {
    const dirs = bridgeBinDirs()
    expect(dirs.length).toBeGreaterThan(0)
    const packageRoot = bridgePackageRoot(fileURLToPath(new URL('.', import.meta.url)))
    expect(packageRoot).not.toBeNull()
    for (const dir of dirs) {
      expect(relative(packageRoot as string, dir).startsWith('..')).toBe(false)
    }
  })
})

describe.skipIf(process.platform === 'win32')('relative PATH entries', () => {
  let dir: string
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'mlp-relpath-'))
    mkdirSync(join(dir, 'bin'))
    writeFileSync(join(dir, 'bin', 'planted'), '#!/bin/sh\n')
    chmodSync(join(dir, 'bin', 'planted'), 0o755)
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('ignores relative and empty PATH entries and relative extra dirs', () => {
    const cwdRelative = relative(process.cwd(), join(dir, 'bin'))
    const isExecutable = (candidate: string): boolean => candidate.endsWith('planted')
    expect(resolveExecutable('planted', { pathEnv: `${cwdRelative}::.`, isExecutable })).toBeNull()
    expect(
      resolveExecutable('planted', { pathEnv: '', extraDirs: [cwdRelative], isExecutable })
    ).toBeNull()
    const found = resolveExecutable('planted', { pathEnv: `.:${join(dir, 'bin')}` })
    expect(found).toBe(join(dir, 'bin', 'planted'))
    expect(isAbsolute(found as string)).toBe(true)
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
