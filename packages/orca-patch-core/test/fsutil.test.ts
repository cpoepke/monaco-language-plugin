import nodeFs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  atomicReplace,
  errnoCode,
  exists,
  fs,
  isWritable,
  makeTempDir,
  readJson,
  removeDir,
  replaceAsar,
  replaceDir,
  sha256File,
  TMP_SUFFIX,
  writeJsonAtomic
} from '../src/index'
import { errno, tmpDir } from './helpers'

describe('errnoCode', () => {
  it('reads string codes only', () => {
    expect(errnoCode(errno('EACCES'))).toBe('EACCES')
    expect(errnoCode({ code: 13 })).toBeNull()
    expect(errnoCode(null)).toBeNull()
    expect(errnoCode('boom')).toBeNull()
  })
})

describe('json + hashing helpers', () => {
  it('writeJsonAtomic leaves no temp file and creates parent directories', () => {
    const dir = tmpDir()
    const file = path.join(dir, 'a', 'b', 'x.json')
    writeJsonAtomic(file, { a: 1 })
    expect(readJson(file)).toEqual({ a: 1 })
    expect(nodeFs.readdirSync(path.dirname(file))).toEqual(['x.json'])
  })

  it('readJson is null for missing or damaged files', () => {
    const dir = tmpDir()
    expect(readJson(path.join(dir, 'missing.json'))).toBeNull()
    nodeFs.writeFileSync(path.join(dir, 'bad.json'), '{"a": ')
    expect(readJson(path.join(dir, 'bad.json'))).toBeNull()
  })

  it('sha256File hashes in chunks and fails for a missing file', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'f')
    nodeFs.writeFileSync(file, 'abc')
    expect(await sha256File(file)).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    )
    await expect(sha256File(path.join(dir, 'nope'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('exists sees dangling symlinks, isWritable reflects access errors', () => {
    const dir = tmpDir()
    expect(exists(path.join(dir, 'nope'))).toBe(false)
    expect(exists(dir)).toBe(true)
    expect(isWritable(dir)).toBe(true)
    vi.spyOn(fs, 'accessSync').mockImplementation(() => {
      throw errno('EACCES')
    })
    expect(isWritable(dir)).toBe(false)
  })

  it('removeDir swallows errors; makeTempDir creates a directory', () => {
    const dir = makeTempDir('mlp-fsutil-')
    expect(nodeFs.statSync(dir).isDirectory()).toBe(true)
    vi.spyOn(fs, 'rmSync').mockImplementationOnce(() => {
      throw errno('EBUSY')
    })
    expect(() => removeDir(dir)).not.toThrow()
    removeDir(dir)
    expect(exists(dir)).toBe(false)
  })

  it('replaceDir replaces the destination entirely', () => {
    const dir = tmpDir()
    const src = path.join(dir, 'src')
    const dest = path.join(dir, 'out', 'dest')
    nodeFs.mkdirSync(src)
    nodeFs.writeFileSync(path.join(src, 'new.txt'), 'new')
    nodeFs.mkdirSync(dest, { recursive: true })
    nodeFs.writeFileSync(path.join(dest, 'old.txt'), 'old')
    replaceDir(src, dest)
    expect(nodeFs.readdirSync(dest)).toEqual(['new.txt'])
    expect(nodeFs.readdirSync(path.dirname(dest))).toEqual(['dest'])
  })
})

describe('atomicReplace: interrupted writes keep the destination and clean up', () => {
  function setup(): { src: string; dest: string; tmp: string } {
    const dir = tmpDir()
    const src = path.join(dir, 'src')
    const dest = path.join(dir, 'app.asar')
    nodeFs.writeFileSync(src, 'new content')
    nodeFs.writeFileSync(dest, 'old content')
    return { src, dest, tmp: `${dest}${TMP_SUFFIX}` }
  }

  it('replaces the destination and leaves no temp file', () => {
    const { src, dest, tmp } = setup()
    atomicReplace(src, dest, tmp)
    expect(nodeFs.readFileSync(dest, 'utf8')).toBe('new content')
    expect(nodeFs.existsSync(tmp)).toBe(false)
  })

  it('removes a stale temp file from an earlier crash first', () => {
    const { src, dest, tmp } = setup()
    nodeFs.writeFileSync(tmp, 'half written garbage')
    atomicReplace(src, dest, tmp)
    expect(nodeFs.readFileSync(dest, 'utf8')).toBe('new content')
  })

  it.each([
    ['copyFileSync', 'ENOSPC'],
    ['openSync', 'EACCES'],
    ['fsyncSync', 'EIO'],
    ['renameSync', 'EBUSY']
  ] as const)('%s failing (%s) keeps the original and removes the temp file', (method, code) => {
    const { src, dest, tmp } = setup()
    // the steps before the failing one really run, so the temp file exists when it fails
    vi.spyOn(fs, method as 'copyFileSync').mockImplementation((() => {
      throw errno(code)
    }) as never)
    expect(() => atomicReplace(src, dest, tmp)).toThrow(expect.objectContaining({ code }))
    expect(nodeFs.readFileSync(dest, 'utf8')).toBe('old content')
    expect(nodeFs.existsSync(tmp)).toBe(false)
  })

  it.each(['EACCES', 'EROFS', 'EPERM', 'EBUSY'])(
    'replaceAsar surfaces %s with its code and keeps the original',
    (code) => {
      const { src, dest, tmp } = setup()
      vi.spyOn(fs, 'renameSync').mockImplementation(() => {
        throw errno(code)
      })
      let thrown: unknown
      try {
        replaceAsar(src, dest)
      } catch (error) {
        thrown = error
      }
      expect(errnoCode(thrown)).toBe(code)
      expect(nodeFs.readFileSync(dest, 'utf8')).toBe('old content')
      expect(nodeFs.existsSync(tmp)).toBe(false)
    }
  )
})
