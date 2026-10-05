import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { JsonRpcErrorCodes } from '@mlp/protocol'

const hooks = vi.hoisted(() => ({ beforeOpen: () => {}, beforeStat: () => {} }))
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      hooks.beforeOpen()
      return fs.open(...args)
    },
    stat: async (...args: Parameters<typeof fs.stat>) => {
      const result = await fs.stat(...args)
      hooks.beforeStat()
      return result
    }
  }
})
const { readFileForClient, MAX_READ_FILE_BYTES } = await import('./read-file')
const dirs: string[] = []
afterEach(() => {
  hooks.beforeOpen = () => {}
  hooks.beforeStat = () => {}
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function fixture() {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'mlp-read-race-')))
  dirs.push(base)
  const root = join(base, 'root')
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(base, 'outside'))
  writeFileSync(join(root, 'src', 'file.txt'), 'public')
  writeFileSync(join(base, 'outside', 'file.txt'), 'secret')
  return { base, root, file: join(root, 'src', 'file.txt') }
}

it.skipIf(process.platform === 'win32')(
  'rejects an ancestor swapped to an outside symlink before open',
  async () => {
    const { base, root, file } = fixture()
    hooks.beforeOpen = () => {
      renameSync(join(root, 'src'), join(root, 'old'))
      symlinkSync(join(base, 'outside'), join(root, 'src'))
    }
    await expect(readFileForClient(pathToFileURL(file).href, [root])).rejects.toMatchObject({
      code: JsonRpcErrorCodes.PathNotAllowed
    })
  }
)

it('bounds bytes read when a file grows after its metadata checks', async () => {
  const { root, file } = fixture()
  let stats = 0
  hooks.beforeStat = () => {
    if (++stats === 2) writeFileSync(file, Buffer.alloc(MAX_READ_FILE_BYTES + 100, 65))
  }
  await expect(readFileForClient(pathToFileURL(file).href, [root])).rejects.toThrow(/too large/)
})
