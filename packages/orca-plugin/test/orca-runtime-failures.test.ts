/** The Orca runtime client against misbehaving runtimes: garbage frames, dropped connections, stale metadata. */
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  OrcaRuntimeError,
  RUNTIME_METADATA_FILENAME,
  createOrcaRuntimeClient,
  findSocketTransport,
  interpretFrame,
  parseRuntimeMetadata
} from '../src/orca-runtime-client'

type Reply = (request: { id: string; method: string }, socket: Socket) => void

/** A runtime whose answers the test scripts byte by byte. */
class RawRuntime {
  readonly dir = mkdtempSync(path.join(tmpdir(), 'mlp-raw-'))
  readonly endpoint =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\mlp-raw-${randomBytes(6).toString('hex')}`
      : path.join(this.dir, `r-${randomBytes(3).toString('hex')}.sock`)
  reply: Reply = () => {}
  connections = 0
  private server: Server | null = null
  private readonly sockets = new Set<Socket>()

  async start(metadata: Record<string, unknown> | string | null = {}): Promise<void> {
    this.server = createServer((socket) => {
      this.connections++
      this.sockets.add(socket)
      socket.on('close', () => this.sockets.delete(socket))
      socket.on('error', () => {})
      socket.setEncoding('utf8')
      let buffer = ''
      socket.on('data', (chunk: string) => {
        buffer += chunk
        const newline = buffer.indexOf('\n')
        if (newline !== -1) {
          const request = JSON.parse(buffer.slice(0, newline)) as { id: string; method: string }
          buffer = ''
          this.reply(request, socket)
        }
      })
    })
    await new Promise<void>((resolve) => this.server!.listen(this.endpoint, resolve))
    if (metadata !== null) {
      this.writeMetadata(metadata)
    }
  }

  writeMetadata(metadata: Record<string, unknown> | string = {}): void {
    writeFileSync(
      path.join(this.dir, RUNTIME_METADATA_FILENAME),
      typeof metadata === 'string'
        ? metadata
        : JSON.stringify({
            runtimeId: 'rt-1',
            pid: process.pid,
            authToken: 'secret-token',
            transports: [
              {
                kind: process.platform === 'win32' ? 'named-pipe' : 'unix',
                endpoint: this.endpoint
              }
            ],
            ...metadata
          })
    )
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy()
    await new Promise<void>((resolve) =>
      this.server ? this.server.close(() => resolve()) : resolve()
    )
    rmSync(this.dir, { recursive: true, force: true })
  }
}

let runtime: RawRuntime
beforeEach(() => {
  runtime = new RawRuntime()
})
afterEach(async () => {
  await runtime.stop()
})

const ok = (id: string, result: unknown, runtimeId = 'rt-1') =>
  `${JSON.stringify({ id, ok: true, result, _meta: { runtimeId } })}\n`

function client(timeoutMs = 1000) {
  return createOrcaRuntimeClient({ userDataCandidates: () => [runtime.dir], timeoutMs })
}

describe('metadata problems', () => {
  it('reports unreadable and unrecognised metadata files', async () => {
    await runtime.start('{ not json')
    await expect(client().call('x')).rejects.toMatchObject({
      code: 'runtime_unavailable',
      message: expect.stringMatching(/could not read .*orca-runtime\.json/)
    })
    runtime.writeMetadata('{"pid": 1}')
    await expect(client().call('x')).rejects.toMatchObject({
      code: 'runtime_unavailable',
      message: expect.stringContaining('unrecognised runtime metadata')
    })
    runtime.writeMetadata('"just a string"')
    await expect(client().call('x')).rejects.toMatchObject({ code: 'runtime_unavailable' })
  })

  it('needs a unix-socket or named-pipe transport', async () => {
    await runtime.start({ transports: [{ kind: 'websocket', endpoint: 'ws://127.0.0.1:1' }] })
    await expect(client().call('x')).rejects.toMatchObject({
      code: 'runtime_unavailable',
      message: 'no unix-socket/named-pipe transport in metadata'
    })
  })

  it('skips candidate dirs without metadata and uses the first that has it', async () => {
    await runtime.start()
    const empty = path.join(runtime.dir, 'empty')
    mkdirSync(empty)
    const c = createOrcaRuntimeClient({ userDataCandidates: () => [empty, runtime.dir] })
    expect(c.metadataPath()).toBe(path.join(runtime.dir, RUNTIME_METADATA_FILENAME))
    runtime.reply = (request, socket) => socket.end(ok(request.id, 'found'))
    await expect(c.call('x')).resolves.toBe('found')
  })

  it('reports a runtime that is not listening at all', async () => {
    const missing =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\mlp-missing-${randomBytes(6).toString('hex')}`
        : path.join(runtime.dir, 'missing.sock')
    await runtime.start({
      transports: [
        { kind: process.platform === 'win32' ? 'named-pipe' : 'unix', endpoint: missing }
      ]
    })
    await expect(client(500).call('x')).rejects.toMatchObject({
      code: 'runtime_unavailable',
      message: expect.stringMatching(/cannot reach the Orca runtime/)
    })
  })
})

describe('misbehaving runtimes', () => {
  beforeEach(async () => {
    await runtime.start()
  })

  it('reports a connection closed without an answer', async () => {
    runtime.reply = (_request, socket) => socket.end()
    await expect(client().call('x')).rejects.toMatchObject({
      code: 'runtime_unavailable',
      message: 'Orca runtime closed the connection'
    })
  })

  it('rejects frames that are not JSON, not objects, or not recognisable', async () => {
    for (const frame of ['definitely not json', '42', '"text"', 'null', '{"hello":"world"}']) {
      runtime.reply = (_request, socket) => socket.write(`${frame}\n`)
      await expect(client().call('x')).rejects.toMatchObject({ code: 'invalid_runtime_response' })
    }
  })

  it('rejects an answer to a different request id', async () => {
    runtime.reply = (_request, socket) => socket.end(ok('someone-else', 1))
    await expect(client().call('x')).rejects.toMatchObject({
      code: 'invalid_runtime_response',
      message: 'runtime answered a different request id'
    })
  })

  it('rejects responses beyond the size limit', async () => {
    runtime.reply = (_request, socket) => {
      const chunk = 'x'.repeat(1024 * 1024)
      for (let i = 0; i < 9; i++) socket.write(chunk)
    }
    await expect(client(5000).call('x')).rejects.toMatchObject({
      code: 'invalid_runtime_response',
      message: 'response too large'
    })
  })

  it('ignores blank lines and handles several frames in one chunk', async () => {
    runtime.reply = (request, socket) =>
      socket.write(`\n\n{"_keepalive":true}\n${ok(request.id, 'late')}`)
    await expect(client().call('x')).resolves.toBe('late')
  })

  it('uses defaults for an error envelope without code or message', async () => {
    runtime.reply = (request, socket) =>
      socket.end(`${JSON.stringify({ id: request.id, ok: false })}\n`)
    const error = (await client()
      .call('x')
      .catch((e: unknown) => e)) as OrcaRuntimeError
    expect(error).toBeInstanceOf(OrcaRuntimeError)
    expect(error.code).toBe('runtime_error')
    expect(error.message).toBe('Orca runtime error')
    expect(error.name).toBe('OrcaRuntimeError')
  })

  it('keeps an error’s data', async () => {
    runtime.reply = (request, socket) =>
      socket.end(
        `${JSON.stringify({ id: request.id, ok: false, error: { code: 'busy', message: 'later', data: { retryMs: 5 } } })}\n`
      )
    await expect(client().call('x')).rejects.toMatchObject({ code: 'busy', data: { retryMs: 5 } })
  })

  it('retries once after the runtime restarted mid-request, and reports a second failure', async () => {
    runtime.reply = (request, socket) => {
      // First attempt: answered by a runtime with another id (Orca restarted); then it is fine again.
      socket.end(ok(request.id, 'x', runtime.connections === 1 ? 'rt-OTHER' : 'rt-1'))
    }
    await expect(client().call('x')).resolves.toBe('x')
    expect(runtime.connections).toBe(2)

    runtime.connections = 0
    runtime.reply = (request, socket) => socket.end(ok(request.id, 'x', 'rt-OTHER'))
    await expect(client().call('x')).rejects.toMatchObject({ code: 'runtime_changed' })
    expect(runtime.connections).toBe(2) // exactly one retry
  })

  it('does not retry errors that fresh metadata cannot fix', async () => {
    runtime.reply = (request, socket) =>
      socket.end(
        `${JSON.stringify({ id: request.id, ok: false, error: { code: 'selector_not_found', message: 'no' } })}\n`
      )
    await expect(client().call('x')).rejects.toMatchObject({ code: 'selector_not_found' })
    expect(runtime.connections).toBe(1)
  })

  it('numbers its requests', async () => {
    const ids: string[] = []
    runtime.reply = (request, socket) => {
      ids.push(request.id)
      socket.end(ok(request.id, null))
    }
    const c = client()
    await c.call('a')
    await c.call('b')
    expect(ids).toHaveLength(2)
    expect(ids[0]).toMatch(/^mlp-[0-9a-f]{8}-0$/)
    expect(ids[1]).toMatch(/-1$/)
  })
})

describe('parseRuntimeMetadata / findSocketTransport', () => {
  it('rejects non-objects and metadata without a runtime id', () => {
    for (const bad of [null, undefined, 3, 'x', {}, { runtimeId: 7 }]) {
      expect(parseRuntimeMetadata(bad)).toBeNull()
    }
  })

  it('keeps only well-formed transports and defaults pid and token', () => {
    const parsed = parseRuntimeMetadata({
      runtimeId: 'r',
      transports: [
        { kind: 'unix', endpoint: '/a' },
        { kind: 'tcp', endpoint: '/b' },
        { kind: 'unix' },
        null,
        'x',
        { kind: 'websocket', endpoint: 'ws://x' }
      ]
    })
    expect(parsed).toEqual({
      runtimeId: 'r',
      pid: 0,
      authToken: null,
      transports: [
        { kind: 'unix', endpoint: '/a' },
        { kind: 'websocket', endpoint: 'ws://x' }
      ]
    })
    expect(parseRuntimeMetadata({ runtimeId: 'r' })?.transports).toEqual([])
    expect(findSocketTransport(parsed!)).toEqual({ kind: 'unix', endpoint: '/a' })
    expect(
      findSocketTransport({ ...parsed!, transports: [{ kind: 'websocket', endpoint: 'ws://x' }] })
    ).toBeNull()
  })
})

describe('interpretFrame', () => {
  it('recognises keepalives and unrecognised success flags', () => {
    expect(interpretFrame('{"_keepalive":true}', 'a', 'r')).toBe('keepalive')
    expect(interpretFrame('{"ok":"yes"}', 'a', 'r')).toMatchObject({
      ok: false,
      error: { message: 'runtime sent an unrecognised frame' }
    })
    expect(interpretFrame('{"id":"a","ok":true,"result":null}', 'a', 'r')).toEqual({
      ok: true,
      result: null
    })
  })
})
