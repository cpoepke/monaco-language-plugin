import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import type { Server, Socket } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'

export type ReceivedRequest = {
  id: unknown
  authToken: unknown
  method: unknown
  params: unknown
}

export type FakeHandler = (
  request: ReceivedRequest
) =>
  | { result: unknown }
  | { error: { code: string; message: string } }
  | { silent: true }
  | { keepaliveThen: { result: unknown } }

/**
 * A stand-in for Orca's unix-socket runtime transport
 * (src/main/runtime/rpc/unix-socket-transport.ts): one NDJSON request per
 * connection, auth token check as in runtime-rpc-request-admission.ts, one
 * response line, then `socket.end()`.
 */
export class FakeOrcaRuntime {
  readonly userData: string
  readonly requests: ReceivedRequest[] = []
  authToken = randomBytes(8).toString('hex')
  runtimeId = `rt-${randomBytes(4).toString('hex')}`
  handler: FakeHandler = () => ({ result: null })
  private server: Server | null = null
  private sockets = new Set<Socket>()
  endpoint = ''

  constructor() {
    // Why os.tmpdir(): unix socket paths are limited to ~104 bytes.
    this.userData = mkdtempSync(path.join(tmpdir(), 'mlp-orca-'))
  }

  async start(): Promise<void> {
    this.endpoint =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\mlp-test-${randomBytes(6).toString('hex')}`
        : path.join(this.userData, `o-${randomBytes(3).toString('hex')}.sock`)
    const server = createServer((socket) => this.onConnection(socket))
    await new Promise<void>((resolve) => server.listen(this.endpoint, resolve))
    this.server = server
    this.writeMetadata()
  }

  writeMetadata(): void {
    writeFileSync(
      path.join(this.userData, 'orca-runtime.json'),
      JSON.stringify({
        runtimeId: this.runtimeId,
        pid: process.pid,
        authToken: this.authToken,
        startedAt: Date.now(),
        transports: [
          { kind: 'websocket', endpoint: 'ws://127.0.0.1:1' },
          { kind: process.platform === 'win32' ? 'named-pipe' : 'unix', endpoint: this.endpoint }
        ]
      }),
      { mode: 0o600 }
    )
  }

  /** Simulates an Orca restart: new token, runtime id and socket. */
  async restart(): Promise<void> {
    await this.stopServer()
    this.authToken = randomBytes(8).toString('hex')
    this.runtimeId = `rt-${randomBytes(4).toString('hex')}`
    await this.start()
  }

  async stopServer(): Promise<void> {
    for (const socket of this.sockets) {
      socket.destroy()
    }
    const server = this.server
    this.server = null
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }

  async dispose(): Promise<void> {
    await this.stopServer()
    rmSync(this.userData, { recursive: true, force: true })
  }

  private onConnection(socket: Socket): void {
    this.sockets.add(socket)
    socket.on('close', () => this.sockets.delete(socket))
    socket.setEncoding('utf8')
    let buffer = ''
    socket.on('data', (chunk: string) => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline === -1) {
        return
      }
      const line = buffer.slice(0, newline)
      buffer = ''
      this.respond(socket, line)
    })
  }

  private respond(socket: Socket, line: string): void {
    const request = JSON.parse(line) as ReceivedRequest
    this.requests.push(request)
    const send = (frame: unknown): void => {
      socket.write(`${JSON.stringify(frame)}\n`)
      socket.end()
    }
    const id = typeof request.id === 'string' ? request.id : 'unknown'
    if (typeof request.authToken !== 'string' || request.authToken.length === 0) {
      send(this.failure(id, 'unauthorized', 'Missing auth token'))
      return
    }
    if (request.authToken !== this.authToken) {
      send(this.failure(id, 'unauthorized', 'Invalid auth token'))
      return
    }
    const outcome = this.handler(request)
    if ('silent' in outcome) {
      return
    }
    if ('keepaliveThen' in outcome) {
      socket.write('{"_keepalive":true}\n')
      setTimeout(
        () => send({ id, ok: true, result: outcome.keepaliveThen.result, _meta: this.meta() }),
        20
      )
      return
    }
    if ('error' in outcome) {
      send(this.failure(id, outcome.error.code, outcome.error.message))
      return
    }
    send({ id, ok: true, result: outcome.result, _meta: this.meta() })
  }

  private meta(): { runtimeId: string } {
    return { runtimeId: this.runtimeId }
  }

  private failure(id: string, code: string, message: string): unknown {
    return { id, ok: false, error: { code, message }, _meta: this.meta() }
  }
}
