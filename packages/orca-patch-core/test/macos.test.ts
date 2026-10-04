import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  adHocSign,
  type CommandResult,
  defaultRunCommand,
  GATEKEEPER_NOTE,
  handleAsarIntegrity,
  NO_RESIGN_NOTE,
  PatcherError,
  signingNote,
  silentLogger,
  verifyCodeSignature
} from '../src/index'
import { memoryLogger } from './helpers'

type Call = [string, ...string[]]

/** A command runner that records calls and answers from `reply(call)`. */
function runner(reply: (call: Call) => CommandResult | Error): {
  runCommand: (command: string, args: string[]) => Promise<CommandResult>
  calls: Call[]
} {
  const calls: Call[] = []
  return {
    calls,
    runCommand: async (command, args) => {
      const call: Call = [command, ...args]
      calls.push(call)
      const result = reply(call)
      if (result instanceof Error) throw result
      return result
    }
  }
}
const res = (code: number, stderr = '', stdout = ''): CommandResult => ({ code, stdout, stderr })

describe('adHocSign', () => {
  it('signs the whole bundle ad hoc', async () => {
    const r = runner(() => res(0))
    await adHocSign({ runCommand: r.runCommand, logger: silentLogger }, '/Applications/Orca.app')
    expect(r.calls).toEqual([
      ['codesign', '--force', '--deep', '--sign', '-', '/Applications/Orca.app']
    ])
  })

  it('a codesign failure says what state the app is in and how to recover', async () => {
    const r = runner(() => res(1, 'Orca.app: replacing existing signature\nerror: no identity \n'))
    const error = await adHocSign(
      { runCommand: r.runCommand, logger: silentLogger },
      '/Applications/Orca.app'
    ).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PatcherError)
    const message = (error as PatcherError).message
    expect(message).toMatch(/^codesign failed \(exit 1\): Orca\.app: replacing existing signature/)
    expect(message).toMatch(/modified but is not re-signed/)
    expect(message).toContain('codesign --force --deep --sign - "/Applications/Orca.app"')
    expect(message).toMatch(/monaco-lsp-orca uninstall/)
  })

  it('a missing codesign binary (exit 127) is a failure too', async () => {
    const r = runner(() => res(127, 'spawn codesign ENOENT'))
    await expect(
      adHocSign({ runCommand: r.runCommand, logger: silentLogger }, '/x/Orca.app')
    ).rejects.toThrow(/exit 127.*ENOENT/)
  })
})

describe('verifyCodeSignature', () => {
  const ctx = (r: ReturnType<typeof runner>) => ({
    runCommand: r.runCommand,
    logger: silentLogger
  })

  it('valid, with and without codesign output', async () => {
    const bundle = '/Applications/Orca.app'
    const quiet = runner(() => res(0))
    expect(await verifyCodeSignature(ctx(quiet), bundle)).toEqual({
      valid: true,
      detail: 'valid on disk'
    })
    expect(quiet.calls).toEqual([['codesign', '--verify', '--deep', '--strict', bundle]])
    expect(
      await verifyCodeSignature(
        ctx(runner(() => res(0, 'satisfies its Designated Requirement'))),
        bundle
      )
    ).toEqual({
      valid: true,
      detail: 'satisfies its Designated Requirement'
    })
  })

  it('invalid: keeps the first three lines, capped at 300 characters', async () => {
    const stderr = ['one', 'two', 'three', 'four'].join('\n')
    expect(await verifyCodeSignature(ctx(runner(() => res(1, stderr))), '/x')).toEqual({
      valid: false,
      detail: 'one two three'
    })
    const long = await verifyCodeSignature(ctx(runner(() => res(1, 'x'.repeat(500)))), '/x')
    expect(long.detail).toHaveLength(300)
    expect(await verifyCodeSignature(ctx(runner(() => res(3))), '/x')).toEqual({
      valid: false,
      detail: 'codesign exited with 3'
    })
  })

  it('unknown when codesign cannot run', async () => {
    expect(await verifyCodeSignature(ctx(runner(() => res(127, 'not found'))), '/x')).toEqual({
      valid: null,
      detail: 'codesign not available'
    })
    expect(await verifyCodeSignature(ctx(runner(() => new Error('spawn EACCES'))), '/x')).toEqual({
      valid: null,
      detail: 'Error: spawn EACCES'
    })
  })
})

describe('handleAsarIntegrity', () => {
  const bundle = path.join('/Applications', 'Orca.app')
  const plist = path.join(bundle, 'Contents', 'Info.plist')
  const extract = ['plutil', '-extract', 'ElectronAsarIntegrity', 'json', '-o', '-', plist]

  it('absent when Info.plist has no ElectronAsarIntegrity', async () => {
    const r = runner(() => res(1, 'No value at that key path'))
    const { logger, lines } = memoryLogger()
    expect(await handleAsarIntegrity({ runCommand: r.runCommand, logger }, bundle, true)).toBe(
      'absent'
    )
    expect(r.calls).toEqual([extract])
    expect(lines).toEqual([])
  })

  it('present: warns and leaves Info.plist alone unless --fix-integrity', async () => {
    const r = runner(() => res(0, '', '{"Resources/app.asar":{}}'))
    const { logger, text } = memoryLogger()
    expect(await handleAsarIntegrity({ runCommand: r.runCommand, logger }, bundle, false)).toBe(
      'present'
    )
    expect(r.calls).toEqual([extract])
    expect(text()).toMatch(/warn: Info\.plist contains ElectronAsarIntegrity.*--fix-integrity/)
  })

  it('removes the stale hash with --fix-integrity', async () => {
    const r = runner(() => res(0))
    expect(
      await handleAsarIntegrity({ runCommand: r.runCommand, logger: silentLogger }, bundle, true)
    ).toBe('removed')
    expect(r.calls).toEqual([extract, ['plutil', '-remove', 'ElectronAsarIntegrity', plist]])
  })

  it('fails loudly when plutil cannot remove it', async () => {
    const r = runner((call) => (call[1] === '-remove' ? res(1, 'permission denied') : res(0)))
    await expect(
      handleAsarIntegrity({ runCommand: r.runCommand, logger: silentLogger }, bundle, true)
    ).rejects.toThrow(
      /Could not remove ElectronAsarIntegrity from .*Info\.plist: permission denied/
    )
  })
})

describe('signing notes', () => {
  it('picks the note for the mode', () => {
    expect(signingNote(true)).toBe(GATEKEEPER_NOTE)
    expect(signingNote(false)).toBe(NO_RESIGN_NOTE)
    expect(NO_RESIGN_NOTE).toMatch(/NOT re-signed/)
  })
})

describe('defaultRunCommand', () => {
  it('captures output and exit codes of real processes', async () => {
    const ok = await defaultRunCommand(process.execPath, [
      '-e',
      "process.stdout.write('out'); process.stderr.write('err')"
    ])
    expect(ok).toEqual({ code: 0, stdout: 'out', stderr: 'err' })
    const failing = await defaultRunCommand(process.execPath, [
      '-e',
      "process.stderr.write('bad'); process.exit(3)"
    ])
    expect(failing).toMatchObject({ code: 3, stderr: 'bad' })
  })

  // Regression: a spawn failure produced an empty stderr, so "codesign failed (exit 127): " had no reason.
  it('maps a command that cannot be started to 127 and keeps the reason', async () => {
    const missing = await defaultRunCommand('definitely-not-a-real-command-mlp', [])
    expect(missing.code).toBe(127)
    expect(missing.stderr).toMatch(/ENOENT/)
  })
})
