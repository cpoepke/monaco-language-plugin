/** A scriptable stand-in for a spawned language-server process. */
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { encodeLspMessage, LspMessageDecoder } from '../../src/lsp/message-framing'

export type Sent = {
  jsonrpc: string
  id?: number | string
  method?: string
  params?: unknown
} & Record<string, unknown>

export class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  pid: number | undefined = 4242
  exitCode: number | null = null
  readonly sent: Sent[] = []
  readonly kills: string[] = []
  /** Which kill signals make the process exit. */
  dieOn = new Set<string>(['SIGTERM', 'SIGKILL'])

  constructor() {
    super()
    const decoder = new LspMessageDecoder()
    this.stdin.on('data', (chunk: Buffer) => {
      for (const message of decoder.push(chunk)) {
        this.sent.push(message as Sent)
        this.onWrite(message as Sent)
      }
    })
  }

  /** Hook for scripting a server. */
  onWrite: (message: Sent) => void = () => {}

  kill(signal: string): boolean {
    this.kills.push(signal)
    if (this.dieOn.has(signal)) {
      this.exit(null, signal)
    }
    return true
  }

  exit(code: number | null, signal: string | null = null): void {
    this.exitCode = code
    this.emit('exit', code, signal)
  }

  /** Server → bridge message. */
  serve(message: unknown): void {
    this.stdout.write(encodeLspMessage(message))
  }

  requests(method: string): Sent[] {
    return this.sent.filter((message) => message.method === method)
  }
}
