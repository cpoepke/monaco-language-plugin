import { describe, expect, it } from 'vitest'
import { userDataCandidates } from '../src/orca-user-data'
import { candidateServerDirs, extendedPath } from '../src/server-path'

describe('userDataCandidates', () => {
  it('derives userData from an installed plugin root first', () => {
    const candidates = userDataCandidates({
      pluginRoot: '/Users/me/Library/Application Support/orca/plugins/cpoepke.monaco-lsp/abc123',
      env: {},
      platform: 'darwin',
      homedir: '/Users/me'
    })
    expect(candidates[0]).toBe('/Users/me/Library/Application Support/orca')
    expect(candidates).toContain('/Users/me/Library/Application Support/orca-dev')
  })

  it('uses ~/.config/orca on Linux (XDG_CONFIG_HOME when present)', () => {
    expect(
      userDataCandidates({ pluginRoot: null, env: {}, platform: 'linux', homedir: '/home/me' })
    ).toEqual(['/home/me/.config/orca', '/home/me/.config/orca-dev'])
    expect(
      userDataCandidates({
        pluginRoot: null,
        env: { XDG_CONFIG_HOME: '/xdg' },
        platform: 'linux',
        homedir: '/home/me'
      })[0]
    ).toBe('/xdg/orca')
  })

  it('derives %APPDATA%\\orca from USERPROFILE on Windows', () => {
    const candidates = userDataCandidates({
      pluginRoot: null,
      env: { USERPROFILE: 'C:\\Users\\me' },
      platform: 'win32',
      homedir: 'C:\\Users\\me'
    })
    expect(candidates[0]).toBe('C:\\Users\\me\\AppData\\Roaming\\orca')
  })

  it('honours MLP_ORCA_USER_DATA exclusively', () => {
    expect(
      userDataCandidates({
        pluginRoot: '/x/plugins/k/h',
        env: { MLP_ORCA_USER_DATA: '/custom' },
        platform: 'linux',
        homedir: '/home/me'
      })
    ).toEqual(['/custom'])
  })
})

describe('extendedPath', () => {
  it('appends existing server dirs after the inherited PATH, without duplicates', () => {
    const existing = new Set(['/opt/homebrew/bin', '/Users/me/go/bin', '/usr/bin'])
    const result = extendedPath({
      platform: 'darwin',
      homedir: '/Users/me',
      env: { PATH: '/usr/bin:/bin' },
      exists: (dir) => existing.has(dir),
      listDir: () => []
    })
    expect(result.path).toBe('/usr/bin:/bin:/opt/homebrew/bin:/Users/me/go/bin')
    expect(result.added).toEqual(['/opt/homebrew/bin', '/Users/me/go/bin'])
  })

  it('includes the newest nvm node version and common user bin dirs', () => {
    const dirs = candidateServerDirs({
      platform: 'linux',
      homedir: '/home/me',
      env: {},
      listDir: () => ['v18.20.0', 'v22.3.0', 'v20.11.1', 'system']
    })
    expect(dirs).toContain('/home/me/.nvm/versions/node/v22.3.0/bin')
    for (const dir of ['/home/me/.local/bin', '/home/me/.cargo/bin', '/home/me/.volta/bin']) {
      expect(dirs).toContain(dir)
    }
  })

  it('includes the official Go toolchain dir, since gopls needs `go` on PATH', () => {
    const posix = candidateServerDirs({ platform: 'darwin', homedir: '/Users/me', env: {}, listDir: () => [] })
    expect(posix).toContain('/usr/local/go/bin')
    expect(posix.indexOf('/usr/local/go/bin')).toBeGreaterThan(posix.indexOf('/Users/me/go/bin'))
    const win = candidateServerDirs({
      platform: 'win32',
      homedir: 'C:\\Users\\me',
      env: { USERPROFILE: 'C:\\Users\\me' },
      listDir: () => []
    })
    expect(win).toContain('C:\\Program Files\\Go\\bin')
  })

  it('uses Windows dirs and ; on win32', () => {
    const result = extendedPath({
      platform: 'win32',
      homedir: 'C:\\Users\\me',
      env: { PATH: 'C:\\Windows', USERPROFILE: 'C:\\Users\\me' },
      exists: (dir) => dir === 'C:\\Users\\me\\AppData\\Roaming\\npm'
    })
    expect(result.path).toBe('C:\\Windows;C:\\Users\\me\\AppData\\Roaming\\npm')
  })
})
