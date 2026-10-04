import { describe, expect, it } from 'vitest'
import { diagnoseServers } from './diagnose'

const fakeFiles = (...files: string[]) => {
  const set = new Set(files)
  return (candidate: string): boolean => set.has(candidate)
}

describe('diagnoseServers', () => {
  it('reports every catalog candidate as ok, broken or missing', () => {
    const probed: string[] = []
    const result = diagnoseServers({
      platform: 'linux',
      pathEnv: '/usr/bin',
      extraDirs: ['/home/me/.cargo/bin'],
      isExecutable: fakeFiles(
        '/usr/bin/typescript-language-server',
        '/usr/bin/pyright-langserver',
        '/home/me/.cargo/bin/rust-analyzer'
      ),
      probe: (file, args) => {
        probed.push(`${file} ${args.join(' ')}`)
        return file.endsWith('rust-analyzer')
          ? { ok: false, reason: 'exited with 1: no component' }
          : { ok: true, version: '5.3.0' }
      }
    })
    expect(result.map((d) => [d.serverId, d.status])).toEqual([
      ['typescript-language-server', 'ok'],
      ['tsgo', 'missing'],
      ['pyright', 'ok'],
      ['basedpyright', 'missing'],
      ['gopls', 'missing'],
      ['rust-analyzer', 'broken']
    ])
    expect(result[0]).toMatchObject({
      languages: ['typescript', 'javascript'],
      path: '/usr/bin/typescript-language-server',
      version: '5.3.0'
    })
    expect(result[5]).toMatchObject({
      path: '/home/me/.cargo/bin/rust-analyzer',
      reason: 'exited with 1: no component'
    })
    // pyright has no probe command in the catalog, so it is never probed
    expect(result[2]?.version).toBeUndefined()
    expect(probed).toEqual([
      '/usr/bin/typescript-language-server --version',
      '/home/me/.cargo/bin/rust-analyzer --version'
    ])
  })

  it('skips probing when probe is false', () => {
    const result = diagnoseServers({
      platform: 'linux',
      pathEnv: '/usr/bin',
      extraDirs: [],
      isExecutable: fakeFiles('/usr/bin/gopls'),
      probe: false
    })
    expect(result.find((d) => d.serverId === 'gopls')).toMatchObject({
      status: 'ok',
      path: '/usr/bin/gopls'
    })
  })

  it('applies PATHEXT on Windows', () => {
    const result = diagnoseServers({
      platform: 'win32',
      pathEnv: 'C:\\tools',
      pathExt: '.CMD;.EXE',
      extraDirs: [],
      isExecutable: (candidate) => candidate.toLowerCase() === 'c:\\tools\\gopls.exe',
      probe: false
    })
    expect(result.find((d) => d.serverId === 'gopls')?.path?.toLowerCase()).toBe(
      'c:\\tools\\gopls.exe'
    )
  })
})
