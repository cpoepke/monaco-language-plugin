/** The detached helper's command line, in-process (the built helper is exercised by bundle-smoke). */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApplyPendingOptions } from '@mlp/orca-patch-core'
import { fileLogger, positiveInt, runApplyPending } from '../src/apply-pending-run'

let dir: string
let asar: string
let log: string

beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'mlp-helper-')))
  asar = path.join(dir, 'resources', 'app.asar')
  log = path.join(dir, 'logs', 'apply-pending.log')
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const lines = () =>
  readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .map((line) => line.replace(/^\S+ \[\d+\] /, ''))

describe('positiveInt', () => {
  it('accepts positive integers only', () => {
    expect(positiveInt('5000')).toBe(5000)
    for (const bad of [undefined, '', '0', '-3', '1.5', 'abc', '1e3x', 'NaN']) {
      expect(positiveInt(bad)).toBeUndefined()
    }
  })
})

describe('fileLogger', () => {
  it('appends timestamped lines and creates the log directory', () => {
    const logger = fileLogger(log)
    logger.info('hello')
    logger.warn('careful')
    logger.error('boom')
    expect(lines()).toEqual(['info: hello', 'warn: careful', 'error: boom'])
    expect(readFileSync(log, 'utf8')).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[\d+\] info: hello/)
  })

  it('is silent without a file, and when the file cannot be written', () => {
    const silent = fileLogger(undefined)
    expect(() => silent.error('nowhere')).not.toThrow()
    // a directory where the log file should be
    mkdirSync(log, { recursive: true })
    expect(() => fileLogger(log).info('cannot write')).not.toThrow()
  })
})

describe('runApplyPending', () => {
  const argv = (...extra: string[]) => [
    '--asar',
    asar,
    '--wait-pid',
    '4242',
    '--log',
    log,
    ...extra
  ]

  it('exits 2 and logs the arguments when they are unusable', async () => {
    const apply = vi.fn()
    for (const bad of [
      [],
      ['--asar', asar],
      ['--wait-pid', '4242'],
      ['--asar', 'relative/app.asar', '--wait-pid', '4242', '--log', log],
      ['--asar', asar, '--wait-pid', '0', '--log', log],
      ['--asar', asar, '--wait-pid', 'abc', '--log', log],
      ['--asar', asar, '--log', log]
    ]) {
      expect(await runApplyPending(bad, apply)).toBe(2)
    }
    expect(apply).not.toHaveBeenCalled()
    // only the cases that named a log file wrote something
    expect(lines().every((line) => line.startsWith('error: bad arguments: '))).toBe(true)
  })

  it('hands the parsed options to the swap and exits 0 once applied', async () => {
    const apply = vi.fn(async (_options: ApplyPendingOptions) => 'applied' as const)
    expect(await runApplyPending(argv('--timeout-ms', '9000', '--poll-ms', '50'), apply)).toBe(0)
    expect(apply).toHaveBeenCalledTimes(1)
    const options = apply.mock.calls[0]![0]
    expect(options).toMatchObject({ asarPath: asar, waitPid: 4242, timeoutMs: 9000, pollMs: 50 })
    expect(lines()).toEqual([`info: started for ${asar}`, 'info: finished: applied'])
  })

  it('leaves the timeouts to the defaults when they are missing or invalid', async () => {
    const apply = vi.fn(async (_options: ApplyPendingOptions) => 'applied' as const)
    await runApplyPending(argv('--timeout-ms', 'soon', '--poll-ms', '0'), apply)
    const options = apply.mock.calls[0]![0]
    expect(options.timeoutMs).toBeUndefined()
    expect(options.pollMs).toBeUndefined()
  })

  it.each(['missing', 'busy', 'timeout', 'stale', 'failed'] as const)(
    'exits 1 when the swap ended with %s',
    async (outcome) => {
      const apply = vi.fn(async () => outcome as never)
      expect(await runApplyPending(argv(), apply)).toBe(1)
      expect(lines().at(-1)).toBe(`info: finished: ${outcome}`)
    }
  )

  it('lets a failing swap reject (the wrapper turns that into exit code 1)', async () => {
    const apply = vi.fn(async () => {
      throw new Error('EPERM')
    })
    await expect(runApplyPending(argv(), apply)).rejects.toThrow('EPERM')
  })

  it('works without a log file', async () => {
    const apply = vi.fn(async () => 'applied' as const)
    expect(await runApplyPending(['--asar', asar, '--wait-pid', '7'], apply)).toBe(0)
  })

  it('runs the real swap logic: no pending archive is an exit code 1', async () => {
    mkdirSync(path.dirname(asar), { recursive: true })
    writeFileSync(asar, 'original')
    // no .mlp-pending next to it: the real swap reports "missing", which is an exit code 1
    expect(await runApplyPending(argv('--poll-ms', '10', '--timeout-ms', '1000'))).toBe(1)
    expect(lines().at(-1)).toBe('info: finished: missing')
    expect(readFileSync(asar, 'utf8')).toBe('original')
  })
})

describe('the bin wrapper', () => {
  it('exits with the code the command line produced', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    const savedArgv = process.argv
    process.argv = [savedArgv[0]!, 'apply-pending.mjs'] // no arguments: exit code 2
    try {
      vi.resetModules()
      await import('../src/apply-pending')
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(2))
    } finally {
      process.argv = savedArgv
      exit.mockRestore()
    }
  })
})
