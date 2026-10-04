import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  chownToInvokingUser,
  consoleLogger,
  createContext,
  defaultSystemHooks,
  homeFromPasswd,
  resolveInvokingUser,
  silentLogger,
  type SystemHooks
} from '../src/context'
import { findRunningOrca } from '../src/process'
import type { OrcaTarget } from '../src/locate'
import { forgetPatch, readState, recordPatch, statePath } from '../src/state'

const dirs: string[] = []
const tmp = (): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mlp-ctx-')))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const hooks = (overrides: Partial<SystemHooks> = {}): SystemHooks => ({
  getuid: () => 0,
  readFile: () => null,
  shellHomeOf: () => null,
  chown: () => {},
  ...overrides
})

describe('passwd parsing', () => {
  const passwd = [
    'root:x:0:0:root:/root:/bin/bash',
    '# a comment',
    'short:x:1',
    'relative:x:5:5::relative-home:/bin/sh',
    'alice:x:501:20:Alice:/home/alice:/bin/zsh'
  ].join('\n')

  it('finds absolute homes only', () => {
    expect(homeFromPasswd(passwd, 'alice')).toBe('/home/alice')
    expect(homeFromPasswd(passwd, 'root')).toBe('/root')
    expect(homeFromPasswd(passwd, 'relative')).toBeNull()
    expect(homeFromPasswd(passwd, 'short')).toBeNull()
    expect(homeFromPasswd(passwd, 'nobody')).toBeNull()
  })
})

describe('resolveInvokingUser', () => {
  const env = { SUDO_USER: 'alice', SUDO_UID: '501', SUDO_GID: '20' }
  const sys = hooks({ readFile: () => 'alice:x:501:20::/home/alice:/bin/sh\n' })

  it('resolves the sudo user from passwd', () => {
    expect(resolveInvokingUser('linux', env, sys)).toEqual({
      name: 'alice',
      uid: 501,
      gid: 20,
      home: '/home/alice'
    })
  })

  it.each([
    ['not root', { ...env }, hooks({ getuid: () => 1000 })],
    ['no getuid (Windows-like)', { ...env }, hooks({ getuid: () => null })],
    ['no SUDO_USER', { SUDO_UID: '501', SUDO_GID: '20' }, sys],
    ['SUDO_USER is root', { ...env, SUDO_USER: 'root' }, sys],
    ['non-numeric uid', { ...env, SUDO_UID: 'abc' }, sys],
    ['missing gid', { SUDO_USER: 'alice', SUDO_UID: '501' }, sys],
    ['uid 0', { ...env, SUDO_UID: '0' }, sys],
    ['unsafe user name', { ...env, SUDO_USER: 'a b' }, sys],
    ['home unknown', { ...env }, hooks()]
  ])('is null when %s', (_name, e, s) => {
    expect(resolveInvokingUser('linux', e, s)).toBeNull()
  })
})

describe('createContext', () => {
  it('defaults to the real platform/env, the console logger and the real command runner', () => {
    const ctx = createContext({ homeDir: '/h' })
    expect(ctx.platform).toBe(process.platform)
    expect(ctx.env).toBe(process.env)
    expect(ctx.logger).toBe(consoleLogger)
    expect(ctx.stateDir).toBe(path.join('/h', '.monaco-lsp-orca'))
  })

  it('MONACO_LSP_ORCA_HOME moves the state directory', () => {
    const ctx = createContext({ env: { MONACO_LSP_ORCA_HOME: '/custom' }, homeDir: '/h' })
    expect(ctx.stateDir).toBe('/custom')
  })

  it('the console logger prefixes warnings and errors', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    consoleLogger.info('i')
    consoleLogger.warn('w')
    consoleLogger.error('e')
    expect(log).toHaveBeenCalledWith('i')
    expect(warn).toHaveBeenCalledWith('warning: w')
    expect(error).toHaveBeenCalledWith('error: e')
  })
})

describe('default system hooks', () => {
  it('readFile returns the text, or null for unreadable files', () => {
    const dir = tmp()
    const file = path.join(dir, 'passwd')
    fs.writeFileSync(file, 'hello')
    expect(defaultSystemHooks.readFile(file)).toBe('hello')
    expect(defaultSystemHooks.readFile(path.join(dir, 'missing'))).toBeNull()
  })

  it('shellHomeOf never passes unsafe names to a shell', () => {
    for (const bad of ['x;rm -rf ~', '$(id)', 'a b', '', '-n', '`id`']) {
      expect(defaultSystemHooks.shellHomeOf(bad)).toBeNull()
    }
  })

  // Why POSIX only: resolves `~name` through /bin/sh.
  it.skipIf(process.platform === 'win32')('shellHomeOf expands ~user via the shell', () => {
    const home = defaultSystemHooks.shellHomeOf('root')
    expect(home === null || home.startsWith('/')).toBe(true)
    // an unknown user is left unexpanded ("~name"), which is not an absolute path
    expect(defaultSystemHooks.shellHomeOf('no_such_user_mlp_test')).toBeNull()
  })

  it('getuid matches the platform', () => {
    expect(defaultSystemHooks.getuid()).toBe(
      typeof process.getuid === 'function' ? process.getuid() : null
    )
  })
})

// Why skipped on Windows: the invoking user's home comes from passwd(5) text and must start with
// `/`, and sudo/chown do not exist there (the invoking-user lookup is off, covered above).
describe.skipIf(process.platform === 'win32')('chownToInvokingUser', () => {
  function setup(): { home: string; stateDir: string; target: string; sudo: SystemHooks } {
    const home = tmp()
    const stateDir = path.join(home, '.monaco-lsp-orca')
    const target = path.join(stateDir, 'plugin', 'cpoepke.monaco-lsp')
    fs.mkdirSync(path.join(target, 'dist'), { recursive: true })
    fs.writeFileSync(path.join(target, 'dist', 'main.js'), 'x')
    const sudo = hooks({ readFile: () => `alice:x:501:20::${home}:/bin/sh\n` })
    return { home, stateDir, target, sudo }
  }
  const sudoEnv = { SUDO_USER: 'alice', SUDO_UID: '501', SUDO_GID: '20' }

  it('does nothing without an invoking user', () => {
    const { home, stateDir, target } = setup()
    const chown = vi.fn()
    const ctx = createContext({
      platform: 'linux',
      env: {},
      homeDir: home,
      stateDir,
      logger: silentLogger,
      system: hooks({ getuid: () => 1000, chown })
    })
    chownToInvokingUser(ctx, target)
    expect(chown).not.toHaveBeenCalled()
  })

  it('never touches paths outside the invoking user home', () => {
    const { home, sudo } = setup()
    const chown = vi.fn()
    const outside = tmp()
    const ctx = createContext({
      platform: 'linux',
      env: sudoEnv,
      stateDir: path.join(home, '.monaco-lsp-orca'),
      logger: silentLogger,
      system: { ...sudo, chown }
    })
    chownToInvokingUser(ctx, path.join(outside, 'file'))
    chownToInvokingUser({ ...ctx, stateDir: path.join(outside, 'state') }, path.join(home, 'x'))
    expect(chown).not.toHaveBeenCalled()
    // a sibling that merely shares the home as a string prefix is outside, too
    chownToInvokingUser(ctx, `${home}-other${path.sep}x`)
    expect(chown).not.toHaveBeenCalled()
  })

  it('hands the whole tree back, directories first', () => {
    const { home, stateDir, target, sudo } = setup()
    const owned: string[] = []
    const ctx = createContext({
      platform: 'linux',
      env: sudoEnv,
      stateDir,
      logger: silentLogger,
      system: { ...sudo, chown: (file) => void owned.push(file) }
    })
    expect(ctx.invokingUser?.home).toBe(home)
    chownToInvokingUser(ctx, target)
    expect(owned).toEqual(
      expect.arrayContaining([
        stateDir,
        path.join(stateDir, 'plugin'),
        target,
        path.join(target, 'dist'),
        path.join(target, 'dist', 'main.js')
      ])
    )
  })

  it('a failing chown is logged once per path and never thrown or recursed into', () => {
    const { stateDir, target, sudo } = setup()
    const warnings: string[] = []
    const ctx = createContext({
      platform: 'linux',
      env: sudoEnv,
      stateDir,
      logger: { info() {}, warn: (m) => void warnings.push(m), error() {} },
      system: {
        ...sudo,
        chown: () => {
          throw new Error('EPERM: operation not permitted')
        }
      }
    })
    expect(() => chownToInvokingUser(ctx, target)).not.toThrow()
    expect(warnings.length).toBeGreaterThan(0)
    expect(warnings[0]).toMatch(/could not hand .* back to alice: Error: EPERM/)
    // the target itself failed, so its children were never visited
    expect(warnings.some((w) => w.includes('main.js'))).toBe(false)
  })

  it('a missing target is skipped', () => {
    const { stateDir, sudo } = setup()
    const chown = vi.fn()
    const ctx = createContext({
      platform: 'linux',
      env: sudoEnv,
      stateDir,
      logger: silentLogger,
      system: { ...sudo, chown }
    })
    chownToInvokingUser(ctx, path.join(stateDir, 'plugin', 'absent'))
    // only the (existing) state directory and plugin parent are handed back
    expect(chown.mock.calls.map((c) => c[0])).toEqual([stateDir, path.join(stateDir, 'plugin')])
  })
})

describe('state file', () => {
  it('survives a missing, damaged or wrongly shaped state.json', () => {
    const dir = tmp()
    const ctx = createContext({ homeDir: dir, stateDir: dir, logger: silentLogger, env: {} })
    expect(readState(ctx)).toEqual({ installs: {} })
    fs.writeFileSync(statePath(ctx), '{ nope')
    expect(readState(ctx)).toEqual({ installs: {} })
    fs.writeFileSync(statePath(ctx), JSON.stringify({ installs: null }))
    expect(readState(ctx)).toEqual({ installs: {} })
    fs.writeFileSync(statePath(ctx), JSON.stringify([1]))
    expect(readState(ctx)).toEqual({ installs: {} })
  })

  it('records and forgets patches; forgetting an unknown one writes nothing', () => {
    const dir = tmp()
    const ctx = createContext({ homeDir: dir, stateDir: dir, logger: silentLogger, env: {} })
    const record = {
      orcaVersion: '1',
      injectorVersion: '2',
      patcherVersion: '3',
      patchedAt: 'now'
    }
    forgetPatch(ctx, '/a')
    expect(fs.existsSync(statePath(ctx))).toBe(false)
    recordPatch(ctx, '/a', record)
    recordPatch(ctx, '/b', record)
    forgetPatch(ctx, '/a')
    expect(Object.keys(readState(ctx).installs)).toEqual(['/b'])
  })
})

describe('findRunningOrca', () => {
  const target = (appRoot: string): OrcaTarget => ({
    kind: 'linux',
    asarPath: path.join(appRoot, 'resources', 'app.asar'),
    resourcesDir: path.join(appRoot, 'resources'),
    appRoot
  })
  const ctxWith = (platform: NodeJS.Platform, stdout: string, code = 0) =>
    createContext({
      platform,
      env: {},
      homeDir: '/h',
      logger: silentLogger,
      runCommand: async () => ({ code, stdout, stderr: '' })
    })

  it('matches processes by install path, not by name, and skips itself', async () => {
    const ps = [
      '  4242 /opt/Orca/orca-ide --no-sandbox',
      '  4243 /opt/Orca/orca-ide --type=renderer',
      '   77 /usr/bin/orca --screen-reader',
      `${process.pid} /opt/Orca/node something`,
      '',
      '  9 /opt/OrcaOther/orca-ide'
    ].join('\n')
    expect(await findRunningOrca(ctxWith('linux', ps), target('/opt/Orca'))).toEqual([
      '4242 /opt/Orca/orca-ide --no-sandbox',
      '4243 /opt/Orca/orca-ide --type=renderer'
    ])
    // a root with a trailing slash behaves the same
    expect(await findRunningOrca(ctxWith('darwin', ps), target('/opt/Orca/'))).toHaveLength(2)
  })

  it('returns null when the process list cannot be read', async () => {
    expect(await findRunningOrca(ctxWith('linux', '', 1), target('/opt/Orca'))).toBeNull()
    expect(await findRunningOrca(ctxWith('win32', '', 1), target('C:\\Orca'))).toBeNull()
  })

  it('on Windows looks for orca.exe in tasklist output', async () => {
    const csv =
      '"System","4","Services","0","100 K"\r\n"orca.exe","812","Console","1","90,000 K"\r\n'
    expect(await findRunningOrca(ctxWith('win32', csv), target('C:\\Orca'))).toEqual([
      '"orca.exe","812","Console","1","90,000 K"'
    ])
    expect(await findRunningOrca(ctxWith('win32', '"other.exe","1"'), target('C:\\Orca'))).toEqual(
      []
    )
  })
})
