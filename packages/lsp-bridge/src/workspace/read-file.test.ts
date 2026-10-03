import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { JsonRpcErrorCodes } from '@mlp/protocol'
import { RpcError } from '../rpc/rpc-error'
import { isPathInside, realpathLenient } from './path-policy'
import { filePathFromUri, MAX_READ_FILE_BYTES, readFileForClient } from './read-file'

let base: string
let root: string
let outside: string

async function rejection(promise: Promise<unknown>): Promise<RpcError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof RpcError) {
      return error
    }
    throw error
  }
  throw new Error('expected a rejection')
}

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'mlp-read-')))
  root = join(base, 'root')
  outside = join(base, 'outside')
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(outside)
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1\n')
  writeFileSync(join(outside, 'secret.txt'), 'top secret\n')
  writeFileSync(join(root, 'bin.dat'), Buffer.from([0x41, 0x00, 0x42]))
  writeFileSync(join(root, 'big.txt'), Buffer.alloc(MAX_READ_FILE_BYTES + 1, 0x61))
  if (process.platform !== 'win32') {
    symlinkSync(join(outside, 'secret.txt'), join(root, 'escape.txt'))
    symlinkSync(outside, join(root, 'escape-dir'))
    symlinkSync(join(root, 'src', 'a.ts'), join(root, 'inside-link.ts'))
  }
})
afterAll(() => rmSync(base, { recursive: true, force: true }))

describe('readFileForClient', () => {
  it('reads a text file inside an allowed root and infers the language', async () => {
    const uri = pathToFileURL(join(root, 'src', 'a.ts')).toString()
    await expect(readFileForClient(uri, [root])).resolves.toEqual({
      uri,
      text: 'export const a = 1\n',
      languageId: 'typescript'
    })
  })

  it('rejects files outside every root', async () => {
    const error = await rejection(
      readFileForClient(pathToFileURL(join(outside, 'secret.txt')).toString(), [root])
    )
    expect(error.code).toBe(JsonRpcErrorCodes.PathNotAllowed)
  })

  it('rejects `..` traversal out of the root', async () => {
    // Build the URI by hand: URL parsing would normalize the `..` away early,
    // which is fine, but the check must hold either way.
    const raw = `${pathToFileURL(root).toString()}/src/../../outside/secret.txt`
    const error = await rejection(readFileForClient(raw, [root]))
    expect(error.code).toBe(JsonRpcErrorCodes.PathNotAllowed)
    const encoded = `${pathToFileURL(root).toString()}/src/%2E%2E/%2E%2E/outside/secret.txt`
    const encodedError = await rejection(readFileForClient(encoded, [root]))
    expect([JsonRpcErrorCodes.PathNotAllowed, JsonRpcErrorCodes.InvalidParams]).toContain(
      encodedError.code
    )
  })

  it.skipIf(process.platform === 'win32')('rejects symlinks escaping the root', async () => {
    for (const path of [join(root, 'escape.txt'), join(root, 'escape-dir', 'secret.txt')]) {
      const error = await rejection(readFileForClient(pathToFileURL(path).toString(), [root]))
      expect(error.code).toBe(JsonRpcErrorCodes.PathNotAllowed)
    }
  })

  it.skipIf(process.platform === 'win32')('follows symlinks that stay inside', async () => {
    const result = await readFileForClient(pathToFileURL(join(root, 'inside-link.ts')).toString(), [
      root
    ])
    expect(result.text).toBe('export const a = 1\n')
  })

  it('rejects directories, binary files, large files, missing files and non-file URIs', async () => {
    const cases: [string, number][] = [
      [pathToFileURL(join(root, 'src')).toString(), JsonRpcErrorCodes.InvalidParams],
      [pathToFileURL(join(root, 'bin.dat')).toString(), JsonRpcErrorCodes.InvalidParams],
      [pathToFileURL(join(root, 'big.txt')).toString(), JsonRpcErrorCodes.InvalidParams],
      [pathToFileURL(join(root, 'missing.ts')).toString(), JsonRpcErrorCodes.InvalidParams],
      ['https://example.com/a.ts', JsonRpcErrorCodes.InvalidParams],
      ['not a uri', JsonRpcErrorCodes.InvalidParams]
    ]
    for (const [uri, code] of cases) {
      const error = await rejection(readFileForClient(uri, [root]))
      expect({ uri, code: error.code }).toEqual({ uri, code })
    }
  })
})

describe('path policy', () => {
  it('isPathInside is segment-aware', () => {
    expect(isPathInside('/a/b/c', '/a/b')).toBe(true)
    expect(isPathInside('/a/b', '/a/b')).toBe(true)
    expect(isPathInside('/a/bc', '/a/b')).toBe(false)
    expect(isPathInside('/a', '/a/b')).toBe(false)
    // Children whose names merely start with two dots are still inside.
    expect(isPathInside(join('/a', '..foo'), '/a')).toBe(true)
    expect(isPathInside(join('/a', '..foo', 'x.ts'), '/a')).toBe(true)
    expect(isPathInside(join('/a', '..'), '/a')).toBe(false)
  })

  it('filePathFromUri refuses remote hosts but accepts localhost', () => {
    expect(() => filePathFromUri('file://server/share/a.ts')).toThrow(/Remote file URIs/)
    expect(() => filePathFromUri('file://192.168.1.2/a.ts')).toThrow(/Remote file URIs/)
    if (process.platform !== 'win32') {
      expect(filePathFromUri('file://localhost/tmp/a.ts')).toBe('/tmp/a.ts')
    }
  })

  it('realpathLenient resolves the existing prefix of a missing path', () => {
    expect(realpathLenient(join(root, 'src', 'new', 'file.ts'))).toBe(
      join(root, 'src', 'new', 'file.ts')
    )
  })
})
