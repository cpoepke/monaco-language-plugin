import nodeFs from 'node:fs'
import path from 'node:path'
import { createPackageWithOptions } from '@electron/asar'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type AsarEntry,
  buildPatchedArchive,
  checkUnpackedDir,
  diffArchives,
  extractArchive,
  findAnchorFiles,
  inspectAsar,
  loadInjector,
  MONACO_GLOBAL_API_ANCHOR,
  parseInjectorVersion,
  PatcherError,
  readAppPackage,
  readAsarFile,
  readEntries,
  readOrcaVersion,
  rebuildArchive,
  replaceAsar,
  verifyPatched
} from '../src/index'
import { type FakeOrca, makeFakeOrca, ORIGINAL_INDEX_HTML } from '../../orca-patcher/test/fake-orca'
import { tmpDir } from './helpers'

const fakes: FakeOrca[] = []
async function fake(opts?: Parameters<typeof makeFakeOrca>[0]): Promise<FakeOrca> {
  const f = await makeFakeOrca(opts)
  fakes.push(f)
  return f
}
afterEach(() => {
  for (const f of fakes.splice(0)) nodeFs.rmSync(f.root, { recursive: true, force: true })
})

/** Pack a tree of text files into an app.asar inside a fresh temp dir. */
async function packTree(files: Record<string, string>): Promise<string> {
  const root = tmpDir('mlp-tree-')
  const src = path.join(root, 'src')
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(src, ...rel.split('/'))
    nodeFs.mkdirSync(path.dirname(abs), { recursive: true })
    nodeFs.writeFileSync(abs, content)
  }
  const asarPath = path.join(root, 'app.asar')
  await createPackageWithOptions(src, asarPath, {})
  return asarPath
}

describe('damaged archives', () => {
  async function damaged(): Promise<Record<string, string>> {
    const f = await fake()
    const buf = nodeFs.readFileSync(f.asarPath)
    const variants: Record<string, Buffer> = {
      truncatedHeader: buf.subarray(0, 40),
      truncatedHalf: buf.subarray(0, Math.floor(buf.length / 2)),
      empty: Buffer.alloc(0),
      notAnArchive: Buffer.from('this is not an asar archive at all, definitely not')
    }
    const out: Record<string, string> = {}
    for (const [name, data] of Object.entries(variants)) {
      out[name] = `${f.asarPath}.${name}`
      nodeFs.writeFileSync(out[name]!, data)
    }
    return out
  }

  // Regression: readEntries surfaced bare RangeError/Error stacks for a truncated app.asar, so
  // `install` crashed with a stack trace instead of an actionable message.
  it('readEntries explains instead of throwing a bare stack', async () => {
    for (const file of Object.values(await damaged())) {
      let thrown: unknown
      try {
        readEntries(file)
      } catch (error) {
        thrown = error
      }
      expect(thrown, file).toBeInstanceOf(PatcherError)
      expect((thrown as PatcherError).message).toMatch(/not a readable asar archive/)
      expect((thrown as PatcherError).message).toMatch(/Nothing was changed/)
    }
  })

  it('lookups on damaged archives report "absent" rather than throwing', async () => {
    for (const file of Object.values(await damaged())) {
      expect(readAsarFile(file, 'package.json')).toBeNull()
      expect(readAppPackage(file)).toEqual({ name: null, version: null })
      expect(inspectAsar(file)).toEqual({
        orcaVersion: null,
        hasIndexHtml: false,
        injectedBlocks: 0,
        versionInfo: null
      })
    }
  })

  it('extraction and patching fail with a PatcherError and change nothing', async () => {
    const f = await fake()
    const bad = await damaged()
    for (const file of Object.values(bad)) {
      expect(() => extractArchive(file, path.join(f.root, 'out'))).toThrow(
        /Could not extract .*app\.asar\./
      )
    }
    const before = nodeFs.readFileSync(f.asarPath)
    await expect(
      buildPatchedArchive({
        asarPath: bad.truncatedHalf!,
        workDir: tmpDir(),
        injector: loadInjector(f.injectorPath),
        patcherVersion: '0',
        patchedBy: 'test'
      })
    ).rejects.toBeInstanceOf(PatcherError)
    expect(nodeFs.readFileSync(f.asarPath).equals(before)).toBe(true)
  })
})

describe('inspect', () => {
  it('survives unparseable package.json and version.json', async () => {
    const asarPath = await packTree({
      'package.json': '{ nope',
      'out/renderer/index.html': ORIGINAL_INDEX_HTML,
      'out/renderer/mlp/version.json': '<<<'
    })
    expect(readAppPackage(asarPath)).toEqual({ name: null, version: null })
    expect(readOrcaVersion(asarPath)).toBeNull()
    expect(inspectAsar(asarPath)).toMatchObject({
      hasIndexHtml: true,
      injectedBlocks: 0,
      versionInfo: null
    })
  })

  it('ignores a package.json whose name/version are not strings', async () => {
    const asarPath = await packTree({ 'package.json': '{"name":1,"version":[2]}' })
    expect(readAppPackage(asarPath)).toEqual({ name: null, version: null })
  })
})

describe('injector asset', () => {
  it('reads the version banner, falling back to "unknown"', () => {
    const dir = tmpDir()
    const withBanner = path.join(dir, 'a.js')
    const without = path.join(dir, 'b.js')
    nodeFs.writeFileSync(withBanner, '/*! @mlp/orca-injector v1.2.3-rc.1 */\n')
    nodeFs.writeFileSync(without, 'console.log(1)')
    expect(loadInjector(withBanner).version).toBe('1.2.3-rc.1')
    expect(loadInjector(without).version).toBe('unknown')
    expect(parseInjectorVersion(`${'x'.repeat(600)}@mlp/orca-injector v1.0.0`)).toBeNull()
  })

  it('a missing bundle tells how to build it', () => {
    expect(() => loadInjector(path.join(tmpDir(), 'missing.js'))).toThrow(
      /Injector bundle not found .*pnpm --filter @mlp\/orca-injector build/
    )
  })
})

describe('buildPatchedArchive guards', () => {
  const injector = (f: FakeOrca): ReturnType<typeof loadInjector> => loadInjector(f.injectorPath)

  it('refuses an archive without the renderer index.html (unexpected-layout)', async () => {
    const f = await fake()
    const asarPath = await packTree({ 'package.json': '{"name":"orca","version":"1"}' })
    const error = await buildPatchedArchive({
      asarPath,
      workDir: tmpDir(),
      injector: injector(f),
      patcherVersion: '0',
      patchedBy: 't'
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PatcherError)
    expect((error as PatcherError).reason).toBe('unexpected-layout')
    expect((error as PatcherError).message).toMatch(/unexpected layout; nothing was changed/)
  })

  it('refuses an archive without the Monaco anchor (anchor-missing)', async () => {
    const f = await fake({ anchor: false })
    const error = await buildPatchedArchive({
      asarPath: f.asarPath,
      workDir: tmpDir(),
      injector: injector(f),
      patcherVersion: '0',
      patchedBy: 't'
    }).catch((e: unknown) => e)
    expect((error as PatcherError).reason).toBe('anchor-missing')
    expect((error as PatcherError).message).toContain(MONACO_GLOBAL_API_ANCHOR)
  })

  it('records who patched and when in version.json', async () => {
    const f = await fake()
    const built = await buildPatchedArchive({
      asarPath: f.asarPath,
      workDir: tmpDir(),
      injector: injector(f),
      patcherVersion: '4.5.6',
      patchedBy: 'unit-test',
      now: () => new Date('2030-01-02T03:04:05.000Z')
    })
    expect(inspectAsar(built.asar).versionInfo).toEqual({
      injectorVersion: '9.9.9',
      orcaVersion: '1.4.214',
      patcherVersion: '4.5.6',
      patchedBy: 'unit-test',
      patchedAt: '2030-01-02T03:04:05.000Z'
    })
  })

  it('findAnchorFiles tolerates a missing assets directory', () => {
    expect(findAnchorFiles(path.join(tmpDir(), 'nothing'))).toEqual([])
  })

  it('verifyPatched demands exactly one block and the expected injector version', async () => {
    const f = await fake()
    expect(() => verifyPatched(f.asarPath)).toThrow(/found 0 injected blocks/)
    const built = await buildPatchedArchive({
      asarPath: f.asarPath,
      workDir: tmpDir(),
      injector: injector(f),
      patcherVersion: '0',
      patchedBy: 't'
    })
    replaceAsar(built.asar, f.asarPath)
    expect(verifyPatched(f.asarPath, '9.9.9').injectedBlocks).toBe(1)
    let thrown: unknown
    try {
      verifyPatched(f.asarPath, '1.0.0')
    } catch (error) {
      thrown = error
    }
    expect((thrown as PatcherError).reason).toBe('verification-failed')
    expect((thrown as PatcherError).message).toMatch(/injector 9\.9\.9/)
  })
})

describe('rebuildArchive', () => {
  async function run(
    f: FakeOrca,
    touched: string[],
    mutate: (dir: string) => void
  ): ReturnType<typeof rebuildArchive> {
    return rebuildArchive({
      asarPath: f.asarPath,
      workDir: tmpDir(),
      originalEntries: readEntries(f.asarPath),
      touched: new Set(touched),
      mutate
    })
  }

  it('refuses to modify an unpacked (native) file', async () => {
    const f = await fake()
    await expect(run(f, ['node_modules/x/x.node'], () => {})).rejects.toThrow(
      /unpacked in this Orca build; refusing to modify it/
    )
  })

  it('a pass-through rebuild is identical in structure', async () => {
    const f = await fake()
    const { entries } = await run(f, [], () => {})
    expect([...entries.keys()].sort()).toEqual([...readEntries(f.asarPath).keys()].sort())
  })

  it('verification rejects untouched files that were added, removed or resized', async () => {
    const f = await fake()
    const mutate = (fn: (dir: string) => void) => (dir: string) => fn(dir)
    await expect(
      run(
        f,
        [],
        mutate((dir) => nodeFs.writeFileSync(path.join(dir, 'extra.txt'), 'x'))
      )
    ).rejects.toThrow(/nothing was changed:\n {2}unexpected new entry: extra\.txt/)
    await expect(
      run(
        f,
        [],
        mutate((dir) => nodeFs.rmSync(path.join(dir, 'out', 'main', 'index.js')))
      )
    ).rejects.toThrow(/missing after repack: out\/main\/index\.js/)
    await expect(
      run(
        f,
        [],
        mutate((dir) => nodeFs.appendFileSync(path.join(dir, 'out', 'main', 'index.js'), 'more'))
      )
    ).rejects.toThrow(/size changed: out\/main\/index\.js/)
  })

  it('truncates a long problem list', async () => {
    const f = await fake()
    await expect(
      run(f, [], (dir) => {
        for (let i = 0; i < 25; i++) nodeFs.writeFileSync(path.join(dir, `extra-${i}.txt`), 'x')
      })
    ).rejects.toThrow(/… and 5 more/)
  })

  it('an incomplete .unpacked directory is caught before anything is replaced', async () => {
    const f = await fake()
    const native = path.join(`${f.asarPath}.unpacked`, 'node_modules', 'x', 'x.node')
    nodeFs.writeFileSync(native, 'short')
    await expect(run(f, [], () => {})).rejects.toThrow(
      /size (changed|mismatch).*node_modules\/x\/x\.node/
    )
    nodeFs.rmSync(native)
    await expect(run(f, [], () => {})).rejects.toThrow(/Could not extract[\s\S]*unpacked complete/)
    expect(checkUnpackedDir(f.asarPath, readEntries(f.asarPath))).toEqual([
      'missing from app.asar.unpacked: node_modules/x/x.node'
    ])
  })

  it('a missing .unpacked directory makes extraction fail with a hint', async () => {
    const f = await fake()
    nodeFs.rmSync(`${f.asarPath}.unpacked`, { recursive: true })
    await expect(run(f, [], () => {})).rejects.toThrow(/Could not extract[\s\S]*unpacked/)
  })

  it('an exception in mutate leaves app.asar and its directory untouched', async () => {
    const f = await fake()
    const before = nodeFs.readdirSync(path.dirname(f.asarPath)).sort()
    await expect(
      run(f, [], () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    expect(nodeFs.readdirSync(path.dirname(f.asarPath)).sort()).toEqual(before)
  })
})

describe('archive diffing', () => {
  const file = (p: string, extra: Partial<AsarEntry> = {}): AsarEntry => ({
    path: p,
    type: 'file',
    unpacked: false,
    size: 1,
    ...extra
  })
  const map = (...entries: AsarEntry[]): Map<string, AsarEntry> =>
    new Map(entries.map((e) => [e.path, e]))

  it('reports type, unpacked-flag and size changes, but allows touched paths', () => {
    const original = map(
      file('a'),
      file('b'),
      file('c'),
      { path: 'd', type: 'directory', unpacked: false },
      file('dir/touched')
    )
    const repacked = map(
      { ...file('a'), type: 'directory' },
      file('b', { unpacked: true }),
      file('c', { size: 2 }),
      { path: 'd', type: 'directory', unpacked: false },
      file('dir/touched', { size: 99 }),
      file('new')
    )
    expect(diffArchives(original, repacked, new Set(['dir/touched']))).toEqual([
      'type changed: a',
      'unpacked flag changed (false → true): b',
      'size changed: c',
      'unexpected new entry: new'
    ])
    // directories that only exist to hold touched paths may come and go
    expect(
      diffArchives(
        map({ path: 'mlp', type: 'directory', unpacked: false }),
        map(),
        new Set(['mlp/injector.js'])
      )
    ).toEqual([])
  })

  it('checkUnpackedDir ignores directories and packed entries', async () => {
    const f = await fake()
    expect(checkUnpackedDir(f.asarPath, readEntries(f.asarPath))).toEqual([])
    expect(
      checkUnpackedDir(
        f.asarPath,
        map({ path: 'd', type: 'directory', unpacked: true }, file('x', { unpacked: false }))
      )
    ).toEqual([])
  })
})
