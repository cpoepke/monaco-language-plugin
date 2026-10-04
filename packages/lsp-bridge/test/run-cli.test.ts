/** The `mlp-bridge` command, run in-process with a fake process surface. */
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { DEFAULT_BRIDGE_PORT } from '@mlp/protocol'
import { FORCE_EXIT_MS, USAGE, runCli, type CliIo } from '../src/run-cli'
import { TestClient, pollFor } from './helpers/test-client'

type FakeIo = CliIo & {
  out: string[]
  err: string[]
  exits: number[]
  signals: Map<string, (signal: NodeJS.Signals) => void>
  stdout: { write(chunk: string): unknown }
  /** Resolves with the exit code once io.exit was called. */
  exited: Promise<number>
}

function fakeIo(): FakeIo {
  const out: string[] = []
  const err: string[] = []
  const exits: number[] = []
  const signals = new Map<string, (signal: NodeJS.Signals) => void>()
  let resolveExit!: (code: number) => void
  const exited = new Promise<number>((resolve) => (resolveExit = resolve))
  return {
    out,
    err,
    exits,
    signals,
    exited,
    stdout: { write: (chunk) => out.push(chunk) },
    stderr: { write: (chunk) => err.push(chunk) },
    onSignal: (signal, handler) => void signals.set(signal, handler),
    exit: (code) => {
      exits.push(code)
      resolveExit(code)
    }
  }
}

type Printed = { url: string; port: number; token: string }

/** Parses the single connection line the CLI prints on stdout. */
function printed(io: FakeIo): Printed {
  expect(io.out).toHaveLength(1)
  expect(io.out[0]!.endsWith('\n')).toBe(true)
  expect(io.out[0]!.trim().split('\n')).toHaveLength(1)
  return JSON.parse(io.out[0]!) as Printed
}

const spyStderr = () => vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
let stderrSpy: ReturnType<typeof spyStderr>
let running: FakeIo[] = []
let tmp: string

beforeEach(() => {
  // The logger writes to the real stderr; keep test output clean and inspectable.
  stderrSpy = spyStderr()
  tmp = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'mlp-cli-')))
})

afterEach(async () => {
  // Shut down any bridge a test left running, through the same path a signal takes.
  for (const io of running) {
    if (io.exits.length === 0) {
      io.signals.get('SIGTERM')?.('SIGTERM')
      await io.exited
    }
  }
  running = []
  stderrSpy.mockRestore()
  rmSync(tmp, { recursive: true, force: true })
})

async function start(
  argv: string[],
  env: Record<string, string | undefined> = {}
): Promise<FakeIo> {
  const io = fakeIo()
  running.push(io)
  expect(await runCli(argv, env, io)).toBeNull()
  return io
}

describe('help and argument errors', () => {
  it.each([['--help'], ['-h']])(
    '%s prints the usage and exits 0 without starting a bridge',
    async (flag) => {
      const io = fakeIo()
      expect(await runCli([flag], {}, io)).toBe(0)
      expect(io.out).toEqual([USAGE])
      expect(io.err).toEqual([])
      expect(io.signals.size).toBe(0)
      expect(USAGE).toContain(`default ${DEFAULT_BRIDGE_PORT}`)
    }
  )

  it.each([
    [['--bogus'], /--bogus/],
    [['stray-positional'], /stray-positional/],
    [['--port'], /--port.*missing/],
    [['--verbose=yes'], /--verbose/]
  ])('rejects %j with exit code 2, the reason and the usage on stderr', async (argv, reason) => {
    const io = fakeIo()
    expect(await runCli(argv, {}, io)).toBe(2)
    expect(io.out).toEqual([])
    expect(io.err).toHaveLength(1)
    expect(io.err[0]).toMatch(/^mlp-bridge: /)
    expect(io.err[0]).toMatch(reason)
    expect(io.err[0]!.endsWith(USAGE)).toBe(true)
    expect(io.signals.size).toBe(0)
  })

  it.each(['abc', '-1', '65536', '70000', '1e3', '12.5', '0x10', ' 80', '', '123456'])(
    'rejects --port %j',
    async (port) => {
      const io = fakeIo()
      const args = port === '-1' ? ['--port=-1'] : ['--port', port]
      expect(await runCli(args, {}, io)).toBe(2)
      expect(io.err[0]).toContain(`invalid --port: ${port}`)
      expect(io.out).toEqual([])
    }
  )

  it('refuses a non-loopback host unless --allow-remote is given', async () => {
    const io = fakeIo()
    await expect(runCli(['--port', '0', '--host', '0.0.0.0'], {}, io)).rejects.toThrow(
      /non-loopback host 0\.0\.0\.0 without allowRemote/
    )
    expect(io.out).toEqual([])
  })

  it('rejects when the port is already taken', async () => {
    const blocker = createServer()
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve))
    const { port } = blocker.address() as { port: number }
    try {
      const io = fakeIo()
      await expect(runCli(['--port', String(port)], {}, io)).rejects.toMatchObject({
        code: 'EADDRINUSE'
      })
      expect(io.out).toEqual([])
      expect(io.signals.size).toBe(0)
    } finally {
      await new Promise((resolve) => blocker.close(resolve))
    }
  })
})

describe('token handling', () => {
  it('generates a random token and prints the connection line when none is given', async () => {
    const io = await start(['--port', '0'])
    const line = printed(io)
    expect(line.token).toMatch(/^[A-Za-z0-9_-]{32}$/)
    expect(line.port).toBeGreaterThan(0)
    expect(line.url).toBe(`ws://127.0.0.1:${line.port}/?token=${line.token}`)
    const client = await TestClient.connectAndHello(line.port, line.token)
    await client.close()
  })

  it('generates a different token on every start', async () => {
    const first = printed(await start(['--port', '0']))
    const second = printed(await start(['--port', '0']))
    expect(first.token).not.toBe(second.token)
  })

  it('takes the token from MLP_BRIDGE_TOKEN and stays silent unless --print-url is given', async () => {
    const quiet = await start(['--port', '0'], { MLP_BRIDGE_TOKEN: 'from-env-secret' })
    expect(quiet.out).toEqual([])

    const loud = await start(['--port', '0', '--print-url'], {
      MLP_BRIDGE_TOKEN: 'from-env-secret'
    })
    const line = printed(loud)
    expect(line.token).toBe('from-env-secret')
    const client = await TestClient.connectAndHello(line.port, 'from-env-secret')
    await client.close()
    await expect(TestClient.connect(line.port, 'wrong')).rejects.toThrow(/401/)
  })

  it('lets --token override the environment', async () => {
    const io = await start(['--port', '0', '--token', 'explicit', '--print-url'], {
      MLP_BRIDGE_TOKEN: 'from-env'
    })
    const line = printed(io)
    expect(line.token).toBe('explicit')
    await expect(TestClient.connect(line.port, 'from-env')).rejects.toThrow(/401/)
    await (await TestClient.connect(line.port, 'explicit')).close()
  })

  it('ignores an empty MLP_BRIDGE_TOKEN and generates a token instead', async () => {
    const io = await start(['--port', '0'], { MLP_BRIDGE_TOKEN: '' })
    const line = printed(io)
    expect(line.token.length).toBeGreaterThanOrEqual(32)
  })

  it('refuses a connection without a token', async () => {
    const line = printed(await start(['--port', '0']))
    await expect(TestClient.connect(line.port, '')).rejects.toThrow(/401/)
  })
})

describe('networking', () => {
  it('refuses a handshake from a foreign Origin even with the right token', async () => {
    const line = printed(await start(['--port', '0']))
    const status = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(line.url, { headers: { Origin: 'https://evil.example' } })
      socket.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0))
      socket.once('open', () => reject(new Error('foreign origin was accepted')))
      socket.once('error', () => {})
    })
    expect(status).toBe(403)
  })

  it('binds IPv6 loopback and brackets the host in the printed URL', async () => {
    const probe = createServer()
    const available = await new Promise<boolean>((resolve) => {
      probe.once('error', () => resolve(false))
      probe.listen(0, '::1', () => probe.close(() => resolve(true)))
    })
    if (!available) {
      // No IPv6 loopback on this machine (some containers/CI images).
      return
    }
    const io = await start(['--port', '0', '--host', '::1'])
    const line = printed(io)
    expect(line.url).toBe(`ws://[::1]:${line.port}/?token=${line.token}`)
  })

  it('accepts a remote host with --allow-remote (token is the only guard)', async () => {
    const io = await start(['--port', '0', '--host', '0.0.0.0', '--allow-remote', '--token', 't'])
    expect(io.out).toEqual([])
  })
})

describe('--root', () => {
  it('confines documents to the given roots (relative roots resolve against the cwd)', async () => {
    const inside = path.join(tmp, 'inside')
    const outside = path.join(tmp, 'outside')
    mkdirSync(inside)
    mkdirSync(outside)
    writeFileSync(path.join(inside, 'a.ts'), 'export {}\n')
    writeFileSync(path.join(outside, 'b.ts'), 'export {}\n')
    const relative = path.relative(process.cwd(), inside)
    const line = printed(
      await start(['--port', '0', '--print-url', '--root', relative, '--token', 't'])
    )
    const client = await TestClient.connectAndHello(line.port, 't')
    await expect(
      client.openDocument(path.join(outside, 'b.ts'), 'typescript')
    ).rejects.toMatchObject({
      code: -32003
    })
    // inside the root the document is accepted by the path policy (a server may or may not exist)
    const result = await client.openDocument(path.join(inside, 'a.ts'), 'typescript')
    expect(result).toBeDefined()
    await client.close()
  })

  it('is repeatable', async () => {
    const one = path.join(tmp, 'one')
    const two = path.join(tmp, 'two')
    mkdirSync(one)
    mkdirSync(two)
    writeFileSync(path.join(two, 'b.ts'), 'export {}\n')
    const line = printed(
      await start(['--port', '0', '--print-url', '--root', one, '--root', two, '--token', 't'])
    )
    const client = await TestClient.connectAndHello(line.port, 't')
    // not rejected as PathNotAllowed: it lies inside the second root
    await client.openDocument(path.join(two, 'b.ts'), 'typescript').then(
      () => undefined,
      (error: { code: number }) => expect(error.code).not.toBe(-32003)
    )
    await client.close()
  })
})

describe('--verbose', () => {
  it('logs debug lines only when asked to', async () => {
    const quiet = await start(['--port', '0'])
    const quietLine = printed(quiet)
    await (await TestClient.connectAndHello(quietLine.port, quietLine.token)).close()
    await pollFor(() => (stderrSpy.mock.calls.length > 0 ? true : null), 2000, 'info logs')
    const quietOutput = stderrSpy.mock.calls.map((c) => String(c[0])).join('')
    expect(quietOutput).toContain('[mlp-bridge] info: listening')
    expect(quietOutput).not.toContain('debug:')

    stderrSpy.mockClear()
    const loud = await start(['--port', '0', '--verbose'])
    const loudLine = printed(loud)
    const client = await TestClient.connectAndHello(loudLine.port, loudLine.token)
    await client.close()
    await pollFor(
      () =>
        stderrSpy.mock.calls.some((c) => String(c[0]).includes('debug: client disconnected'))
          ? true
          : null,
      2000,
      'debug log'
    )
  })
})

describe('signals', () => {
  it('registers SIGINT and SIGTERM and shuts down gracefully with exit code 0', async () => {
    const io = await start(['--port', '0', '--token', 't', '--print-url'])
    const line = printed(io)
    expect([...io.signals.keys()].sort()).toEqual(['SIGINT', 'SIGTERM'])
    const client = await TestClient.connectAndHello(line.port, 't')
    io.signals.get('SIGINT')!('SIGINT')
    expect(await io.exited).toBe(0)
    expect(io.exits).toEqual([0])
    expect(stderrSpy.mock.calls.map((c) => String(c[0])).join('')).toContain(
      'received SIGINT, shutting down'
    )
    // connected clients were told to go, and the port is closed
    await pollFor(
      () => (client.socket.readyState === WebSocket.CLOSED ? true : null),
      3000,
      'close'
    )
    await expect(TestClient.connect(line.port, 't')).rejects.toBeDefined()
  })

  it('handles a second signal while shutting down as a no-op', async () => {
    const io = await start(['--port', '0', '--token', 't'])
    const stop = io.signals.get('SIGTERM')!
    stop('SIGTERM')
    stop('SIGINT')
    stop('SIGTERM')
    expect(await io.exited).toBe(0)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(io.exits).toEqual([0])
    const logged = stderrSpy.mock.calls.map((c) => String(c[0])).join('')
    expect(logged.match(/shutting down/g)).toHaveLength(1)
  })
})

describe('constants', () => {
  it('allows a shutdown 10 seconds before forcing the exit', () => {
    expect(FORCE_EXIT_MS).toBe(10_000)
  })
})
