import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRealBridge, detectServers, pluginExtraBinDirs } from '../src/bridge-host'
import { applyExtendedPath, candidateServerDirs, extendedPath } from '../src/server-path'
import { TestClient } from '../../lsp-bridge/test/helpers/test-client'

describe('candidateServerDirs', () => {
  it('falls back to the home directory for the Windows profile', () => {
    const dirs = candidateServerDirs({ platform: 'win32', homedir: 'C:\\Users\\me', env: {} })
    expect(dirs).toContain('C:\\Users\\me\\AppData\\Roaming\\npm')
    expect(dirs).toContain('C:\\Users\\me\\go\\bin')
    expect(dirs).toContain('C:\\Program Files\\nodejs')
    expect(dirs.every((dir) => !dir.includes('/'))).toBe(true)
  })

  it('does not look for nvm when there is none, and ignores non-version entries', () => {
    const none = candidateServerDirs({
      platform: 'linux',
      homedir: '/home/me',
      env: {},
      listDir: () => []
    })
    expect(none.some((dir) => dir.includes('.nvm'))).toBe(false)
    const junk = candidateServerDirs({
      platform: 'linux',
      homedir: '/home/me',
      env: {},
      listDir: () => ['default', 'v20', 'latest', 'v20.1']
    })
    expect(junk.some((dir) => dir.includes('.nvm'))).toBe(false)
  })

  it('picks the newest nvm version across major, minor and patch', () => {
    const newest = (versions: string[]) =>
      candidateServerDirs({
        platform: 'linux',
        homedir: '/h',
        env: {},
        listDir: () => versions
      }).find((dir) => dir.includes('.nvm'))
    expect(newest(['v20.1.0', 'v20.10.0', 'v20.9.9'])).toBe('/h/.nvm/versions/node/v20.10.0/bin')
    expect(newest(['v20.10.1', 'v20.10.2', 'v20.10.0'])).toBe('/h/.nvm/versions/node/v20.10.2/bin')
    expect(newest(['v18.0.0', 'v22.0.0', 'v22.0.0'])).toBe('/h/.nvm/versions/node/v22.0.0/bin')
  })

  it('reads the real nvm directory when none is injected, tolerating its absence', () => {
    expect(() =>
      candidateServerDirs({
        platform: 'linux',
        homedir: path.join(tmpdir(), 'mlp-no-such-home'),
        env: {}
      })
    ).not.toThrow()
  })
})

describe('extendedPath', () => {
  it('works without any inherited PATH, and reads Path on Windows spellings', () => {
    const exists = (dir: string) => dir === '/usr/local/bin'
    expect(
      extendedPath({ platform: 'linux', homedir: '/h', env: {}, exists, listDir: () => [] })
    ).toEqual({ path: '/usr/local/bin', added: ['/usr/local/bin'] })
    expect(
      extendedPath({
        platform: 'win32',
        homedir: 'C:\\h',
        env: { Path: 'C:\\Windows', USERPROFILE: 'C:\\h' },
        exists: (dir) => dir === 'C:\\h\\go\\bin'
      })
    ).toEqual({ path: 'C:\\Windows;C:\\h\\go\\bin', added: ['C:\\h\\go\\bin'] })
  })

  it('adds nothing, and keeps the PATH as it is, when every dir is present or missing', () => {
    const result = extendedPath({
      platform: 'linux',
      homedir: '/h',
      env: { PATH: '/usr/local/bin::/usr/bin' },
      exists: (dir) => dir === '/usr/local/bin' || dir === '/usr/bin',
      listDir: () => []
    })
    expect(result.added).toEqual([])
    expect(result.path).toBe('/usr/local/bin::/usr/bin')
  })

  it('never puts a candidate before what Orca provided', () => {
    const result = extendedPath({
      platform: 'linux',
      homedir: '/h',
      env: { PATH: '/orca/bin' },
      exists: () => true,
      listDir: () => []
    })
    expect(result.path.startsWith('/orca/bin:')).toBe(true)
  })
})

describe('applyExtendedPath', () => {
  let home: string
  const saved = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE
  }

  beforeEach(() => {
    home = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'mlp-home-')))
  })
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(home, { recursive: true, force: true })
  })

  it('appends existing candidate dirs to process.env.PATH once', () => {
    // os.homedir() reads HOME (POSIX) or USERPROFILE (Windows).
    process.env.HOME = home
    process.env.USERPROFILE = home
    const cargo = path.join(home, '.cargo', 'bin')
    const goBin = path.join(home, 'go', 'bin')
    mkdirSync(cargo, { recursive: true })
    mkdirSync(goBin, { recursive: true })
    process.env.PATH = `${path.join(home, 'orca-provided')}`
    const added = applyExtendedPath()
    expect(added).toEqual(expect.arrayContaining([cargo, goBin]))
    const delimiter = process.platform === 'win32' ? ';' : ':'
    const parts = (process.env.PATH ?? '').split(delimiter)
    expect(parts[0]).toBe(path.join(home, 'orca-provided'))
    expect(parts).toEqual(expect.arrayContaining([cargo, goBin]))
    // idempotent: everything is on PATH now
    const before = process.env.PATH
    expect(applyExtendedPath()).toEqual([])
    expect(process.env.PATH).toBe(before)
  })

  it('leaves PATH alone when no candidate exists', () => {
    process.env.HOME = home
    process.env.USERPROFILE = home
    // Put every directory that could exist on this machine on PATH already.
    process.env.PATH = candidateServerDirs({
      platform: process.platform,
      homedir: home,
      env: process.env
    }).join(process.platform === 'win32' ? ';' : ':')
    const before = process.env.PATH
    expect(applyExtendedPath()).toEqual([])
    expect(process.env.PATH).toBe(before)
  })
})

describe('bridge-host', () => {
  it('searches only explicit dirs after PATH, never a node_modules/.bin of the plugin', () => {
    const dirs = pluginExtraBinDirs()
    expect(dirs.length).toBeGreaterThan(0)
    for (const dir of dirs) {
      expect(path.isAbsolute(dir)).toBe(true)
      expect(dir).not.toContain('node_modules')
    }
  })

  it('reports every catalogued server, resolved or not', () => {
    const servers = detectServers()
    expect(Object.keys(servers)).toEqual(
      expect.arrayContaining(['typescript-language-server', 'pyright', 'gopls', 'rust-analyzer'])
    )
    for (const executable of Object.values(servers)) {
      expect(executable === null || path.isAbsolute(executable)).toBe(true)
    }
  })

  it('creates a working bridge', async () => {
    const bridge = createRealBridge({ port: 0, host: '127.0.0.1', token: 'abc' })
    const { port } = await bridge.listen()
    try {
      const client = await TestClient.connectAndHello(port, 'abc')
      expect(bridge.status().clients).toBe(1)
      expect(bridge.serverPids()).toEqual([])
      await client.close()
    } finally {
      await bridge.close()
    }
  })
})
