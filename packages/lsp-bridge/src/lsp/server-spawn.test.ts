import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const spawnMock = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: spawnMock
}))

const { resolveLspServerForLanguage } = await import('./server-catalog')
const { spawnLspServer } = await import('./server-spawn')

describe.skipIf(process.platform === 'win32')('spawnLspServer', () => {
  let dir: string
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'mlp-spawn-'))
    mkdirSync(join(dir, 'bin'))
    writeFileSync(join(dir, 'bin', 'gopls'), '#!/bin/sh\n')
    chmodSync(join(dir, 'bin', 'gopls'), 0o755)
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('spawns an absolute command even when PATH holds relative entries', () => {
    const relativeBin = relative(process.cwd(), join(dir, 'bin'))
    const resolution = resolveLspServerForLanguage('go', {
      pathEnv: ['.', '', relativeBin, join(dir, 'bin')].join(':'),
      extraDirs: []
    })
    if (!resolution.server) throw new Error(resolution.reason)
    spawnMock.mockReturnValueOnce({})
    spawnLspServer(resolution.server, dir)
    const [command, , options] = spawnMock.mock.calls[0] as [string, string[], { shell: boolean }]
    expect(command).toBe(join(dir, 'bin', 'gopls'))
    expect(isAbsolute(command)).toBe(true)
    expect(options.shell).toBe(false)
  })

  it('refuses a relative executable path outright', () => {
    spawnMock.mockClear()
    expect(() =>
      spawnLspServer({ serverId: 'x', command: 'x', args: [], executablePath: 'bin/x' }, dir)
    ).toThrow(/relative/)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('makes the server a process-group leader on POSIX', () => {
    spawnMock.mockClear()
    spawnMock.mockReturnValueOnce({})
    const spawned = spawnLspServer(
      { serverId: 'x', command: 'x', args: [], executablePath: join(dir, 'bin', 'gopls') },
      dir
    )
    expect(spawned.processGroup).toBe(true)
    expect((spawnMock.mock.calls[0]?.[2] as { detached: boolean }).detached).toBe(true)
  })
})
