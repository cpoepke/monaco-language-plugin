import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExitCode, readUserConfig, readTrustedWorkspaces } from '@mlp/orca-patch-core'
import { main, runCli } from '../src/cli'
import { PATCHER_VERSION } from '../src/constants'
import { silentLogger } from '../src/context'
import { type FakeOrca, makeFakeOrca } from './fake-orca'

const fakes: FakeOrca[] = []
async function fake(): Promise<FakeOrca> {
  const f = await makeFakeOrca()
  fakes.push(f)
  return f
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const f of fakes.splice(0)) fs.rmSync(f.root, { recursive: true, force: true })
})

/** Capture console output while running `fn`. */
async function capture<T>(fn: () => Promise<T>): Promise<{ result: T; out: string; err: string }> {
  const out: string[] = []
  const err: string[] = []
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')))
  vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => void err.push(a.join(' ')))
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void err.push(a.join(' ')))
  try {
    return { result: await fn(), out: out.join('\n'), err: err.join('\n') }
  } finally {
    vi.restoreAllMocks()
  }
}

describe('cli: arguments and exit codes', () => {
  it('explicitly trusts and revokes a workspace without patching Orca', async () => {
    const f = await fake()
    const options = { ...f.options, system: { getuid: () => 1000 } }
    expect(await main(['trust', f.root], options)).toBe(ExitCode.Ok)
    expect(readTrustedWorkspaces(f.options.stateDir!)).toEqual([fs.realpathSync(f.root)])
    expect(await main(['untrust', f.root], options)).toBe(ExitCode.Ok)
    expect(readTrustedWorkspaces(f.options.stateDir!)).toEqual([])
  })

  it('--version prints the version and exits 0, even with a command', async () => {
    const { result, out } = await capture(() => main(['--version']))
    expect(result).toBe(ExitCode.Ok)
    expect(out).toBe(PATCHER_VERSION)
    expect((await capture(() => main(['-v', 'install']))).out).toBe(PATCHER_VERSION)
  })

  it('--help / -h print the usage and exit 0; no command prints it and exits 1', async () => {
    for (const argv of [['--help'], ['-h'], ['install', '--help']]) {
      const { result, out } = await capture(() => main(argv))
      expect(result, argv.join(' ')).toBe(ExitCode.Ok)
      expect(out).toMatch(/^monaco-lsp-orca 0\.1\.0/)
      expect(out).toContain('Exit codes: 0 ok, 1 error, 2 not patched / needs action.')
    }
    const none = await capture(() => main([]))
    expect(none.result).toBe(ExitCode.Error)
    expect(none.out).toContain('Usage:')
  })

  it('an unknown command exits 1 with the usage on stderr', async () => {
    const { result, err } = await capture(() => main(['frobnicate']))
    expect(result).toBe(ExitCode.Error)
    expect(err).toMatch(/^Unknown command: frobnicate\n\nmonaco-lsp-orca/)
  })

  it('unknown flags and flags without a value are parse errors that runCli turns into exit 1', async () => {
    await expect(main(['install', '--frobnicate'])).rejects.toMatchObject({
      code: 'ERR_PARSE_ARGS_UNKNOWN_OPTION'
    })
    await expect(main(['status', '--app'])).rejects.toMatchObject({
      code: 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE'
    })
    for (const argv of [
      ['install', '--frobnicate'],
      ['status', '--app']
    ]) {
      const { result, err } = await capture(() => runCli(argv))
      expect(result, argv.join(' ')).toBe(ExitCode.Error)
      expect(err).toMatch(/^error: .*\n\nmonaco-lsp-orca 0\.1\.0/)
      expect(err).toContain('Usage:')
    }
  })

  it('expected failures (PatcherError) print one line and keep their exit code', async () => {
    const f = await fake()
    const missing = path.join(f.root, 'no-such-orca')
    const { result, err } = await capture(() => runCli(['status', '--app', missing]))
    expect(result).toBe(ExitCode.Error)
    expect(err).toMatch(/^error: No app\.asar found for --app /)
    expect(err).not.toMatch(/\n\s+at /)
  })

  it('unexpected failures print the stack and exit 1; non-Errors are stringified', async () => {
    const f = await fake()
    const thrower = (value: unknown) => ({
      ...f.options,
      app: undefined,
      runCommand: async () => {
        throw value
      }
    })
    const boom = await capture(() =>
      runCli(['install', '--app', f.appDir, '--dry-run'], thrower(new Error('boom')))
    )
    expect(boom.result).toBe(ExitCode.Error)
    expect(boom.err).toMatch(/^error: Error: boom\n\s+at /)
    const weird = await capture(() =>
      runCli(['install', '--app', f.appDir, '--dry-run'], thrower('plain string'))
    )
    expect(weird.result).toBe(ExitCode.Error)
    expect(weird.err).toBe('error: plain string')
  })

  it('a PatcherError carrying exit code 2 is passed through', async () => {
    const f = await fake()
    const { PatcherError } = await import('@mlp/orca-patch-core')
    const { result, err } = await capture(() =>
      runCli(['install', '--app', f.appDir, '--dry-run'], {
        ...f.options,
        app: undefined,
        runCommand: async () => {
          throw new PatcherError('needs action', ExitCode.NeedsAction)
        }
      })
    )
    expect(result).toBe(ExitCode.NeedsAction)
    expect(err).toBe('error: needs action')
  })
})

describe('cli: commands', () => {
  it('status exits 2 until Orca is patched, then 0; --json is machine-readable', async () => {
    const f = await fake()
    const defaults = { ...f.options, app: undefined }
    const before = await capture(() => main(['status', '--app', f.appDir, '--json'], defaults))
    expect(before.result).toBe(ExitCode.NeedsAction)
    const parsed = JSON.parse(before.out)
    expect(parsed).toMatchObject({ patched: false, orcaVersion: '1.4.214', exitCode: 2 })
    expect(parsed.actions[0]).toMatch(/not patched/)

    const install = await capture(() =>
      main(['install', '--app', f.appDir], { ...defaults, logger: silentLogger })
    )
    expect(install.result).toBe(ExitCode.Ok)
    const after = await capture(() => main(['status', '--app', f.appDir], defaults))
    expect(after.result).toBe(ExitCode.Ok)
    expect(after.out).toContain('Patched:         yes (injector 9.9.9)')
    expect(after.out).toContain('All good.')
  })

  it('install honours --dry-run, --skip-plugin, --force; uninstall honours --purge', async () => {
    const f = await fake()
    const defaults = { ...f.options, app: undefined, logger: silentLogger }
    const sha = fs.readFileSync(f.asarPath)
    expect(await main(['install', '--app', f.appDir, '--dry-run'], defaults)).toBe(ExitCode.Ok)
    expect(fs.readFileSync(f.asarPath).equals(sha)).toBe(true)

    const running = {
      ...defaults,
      runCommand: async () => ({
        code: 0,
        stdout: `  4242 ${f.appDir}/orca-ide --no-sandbox\n`,
        stderr: ''
      })
    }
    const refused = await capture(() => runCli(['install', '--app', f.appDir], running))
    expect(refused.result).toBe(ExitCode.Error)
    expect(refused.err).toMatch(/Orca appears to be running/)

    expect(
      await main(
        ['install', '--app', f.appDir, '--force', '--skip-plugin', '--no-auto-repair'],
        running
      )
    ).toBe(ExitCode.Ok)
    expect(fs.existsSync(path.join(f.stateDir, 'plugin'))).toBe(false)
    expect(readUserConfig(f.stateDir).autoRepair).toBe(false)

    expect(await main(['install', '--app', f.appDir], defaults)).toBe(ExitCode.Ok)
    expect(fs.existsSync(path.join(f.stateDir, 'plugin', 'cpoepke.monaco-lsp'))).toBe(true)
    expect(await main(['uninstall', '--app', f.appDir, '--purge'], defaults)).toBe(ExitCode.Ok)
    expect(fs.existsSync(path.join(f.stateDir, 'plugin', 'cpoepke.monaco-lsp'))).toBe(false)
  })

  it('uses defaults.app when --app is not given', async () => {
    const f = await fake()
    const { result, out } = await capture(() => main(['status', '--json'], f.options))
    expect(result).toBe(ExitCode.NeedsAction)
    expect(JSON.parse(out).target.asarPath).toBe(f.asarPath)
  })
})

// The built executable: exercises the real entry point (argument parsing, exit codes).
const dist = fileURLToPath(new URL('../dist/cli.js', import.meta.url))
describe.skipIf(!fs.existsSync(dist))('cli: built executable', () => {
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [dist, ...args], { encoding: 'utf8', timeout: 30_000 })

  it('--help exits 0, no arguments and unknown input exit 1', () => {
    const help = run('--help')
    expect(help.status).toBe(0)
    expect(help.stdout).toContain('Usage:')
    expect(run().status).toBe(1)
    const unknownCommand = run('frobnicate')
    expect(unknownCommand.status).toBe(1)
    expect(unknownCommand.stderr).toContain('Unknown command: frobnicate')
    const unknownFlag = run('install', '--frobnicate')
    expect(unknownFlag.status).toBe(1)
    expect(unknownFlag.stderr).toContain('--frobnicate')
  })

  it('a missing Orca is exit 1 with a one-line error', () => {
    const missing = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mlp-no-orca-')), 'x')
    try {
      const result = run('status', '--app', missing)
      expect(result.status).toBe(1)
      expect(result.stderr).toMatch(/^error: No app\.asar found/)
    } finally {
      fs.rmSync(path.dirname(missing), { recursive: true, force: true })
    }
  })

  it('doctor --json prints parseable JSON', () => {
    const result = run('doctor', '--json')
    expect([0, 2]).toContain(result.status)
    expect(JSON.parse(result.stdout)).toHaveProperty('entries')
  })
})
