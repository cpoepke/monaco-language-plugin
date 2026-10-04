/** LspConnection against a fake child process: framing, errors, cancellation, exit and the kill ladder. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { JsonRpcErrorCodes } from '@mlp/protocol'
import {
  LspConnection,
  LspResponseError,
  REQUEST_CANCELLED,
  type LspConnectionHandlers,
  type LspExitInfo
} from '../src/lsp/lsp-connection'
import { encodeLspMessage } from '../src/lsp/message-framing'
import type { ServerRequestReply } from '../src/lsp/server-requests'
import { FakeChild } from './helpers/fake-child'

type Rig = {
  child: FakeChild
  connection: LspConnection
  notifications: { method: string; params: unknown }[]
  serverRequests: { method: string; params: unknown }[]
  exits: LspExitInfo[]
  stderr: string[]
  replies: Map<string, ServerRequestReply>
}

function rig(options: { processGroup?: boolean; timeoutMs?: number } = {}): Rig {
  const child = new FakeChild()
  const notifications: Rig['notifications'] = []
  const serverRequests: Rig['serverRequests'] = []
  const exits: LspExitInfo[] = []
  const stderr: string[] = []
  const replies = new Map<string, ServerRequestReply>()
  const handlers: LspConnectionHandlers = {
    onNotification: (method, params) => notifications.push({ method, params }),
    onServerRequest: (method, params) => {
      serverRequests.push({ method, params })
      return replies.get(method) ?? { result: null }
    },
    onExit: (info) => exits.push(info),
    onStderr: (text) => stderr.push(text)
  }
  const connection = new LspConnection(
    {
      child: child as unknown as ChildProcessWithoutNullStreams,
      processGroup: options.processGroup ?? false
    },
    handlers,
    options.timeoutMs ?? 1000
  )
  return { child, connection, notifications, serverRequests, exits, stderr, replies }
}

/** Lets stream 'data' events run. */
const tick = async () => {
  await vi.advanceTimersByTimeAsync(0)
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('requests', () => {
  it('frames the request, resolves with the result and null for a missing one', async () => {
    const { child, connection } = rig()
    const first = connection.request('textDocument/hover', { a: 1 })
    const second = connection.request('textDocument/definition', {})
    await tick()
    expect(child.sent[0]).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'textDocument/hover',
      params: { a: 1 }
    })
    child.serve({ jsonrpc: '2.0', id: 2, result: undefined })
    child.serve({ jsonrpc: '2.0', id: 1, result: { contents: 'x' } })
    await tick()
    expect(await first).toEqual({ contents: 'x' })
    expect(await second).toBeNull()
  })

  it('rejects with the server’s own error code, message and data', async () => {
    const { child, connection } = rig()
    const outcome = connection.request('m', {}).catch((e: unknown) => e)
    child.serve({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32803, message: 'ServerCancelled', data: { retry: true } }
    })
    await tick()
    const error = await outcome
    expect(error).toBeInstanceOf(LspResponseError)
    expect(error).toMatchObject({ code: -32803, message: 'ServerCancelled', data: { retry: true } })
  })

  it('maps a malformed server error to InternalError with a default message', async () => {
    const { child, connection } = rig()
    const pending = connection.request('textDocument/hover', {})
    const assertion = expect(pending).rejects.toMatchObject({
      code: JsonRpcErrorCodes.InternalError,
      message: 'Language server failed: textDocument/hover'
    })
    child.serve({ jsonrpc: '2.0', id: 1, error: { code: 'bad' } })
    await tick()
    await assertion
  })

  it('times out, tells the server to stop and ignores the late answer', async () => {
    const { child, connection } = rig({ timeoutMs: 500 })
    const pending = connection.request('slow', {}).catch((e: { code: number }) => e.code)
    await vi.advanceTimersByTimeAsync(499)
    expect(child.requests('$/cancelRequest')).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(await pending).toBe(JsonRpcErrorCodes.RequestTimeout)
    expect(child.requests('$/cancelRequest')[0]?.params).toEqual({ id: 1 })
    child.serve({ jsonrpc: '2.0', id: 1, result: 'late' })
    await tick()
    expect(connection.isAlive).toBe(true)
  })

  it('accepts a numeric timeout or an options object', async () => {
    const { connection } = rig({ timeoutMs: 60_000 })
    const numeric = connection.request('a', {}, 50).catch((e: { code: number }) => e.code)
    const options = connection
      .request('b', {}, { timeoutMs: 80 })
      .catch((e: { code: number }) => e.code)
    await vi.advanceTimersByTimeAsync(80)
    expect(await numeric).toBe(JsonRpcErrorCodes.RequestTimeout)
    expect(await options).toBe(JsonRpcErrorCodes.RequestTimeout)
  })

  it('sends $/cancelRequest and rejects with RequestCancelled when the signal aborts', async () => {
    const { child, connection } = rig()
    const controller = new AbortController()
    const pending = connection.request('m', {}, { signal: controller.signal })
    await tick()
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: REQUEST_CANCELLED })
    expect(child.requests('$/cancelRequest')[0]?.params).toEqual({ id: 1 })
    // the server answering anyway does nothing
    child.serve({ jsonrpc: '2.0', id: 1, result: 'late' })
    await tick()
  })

  it('rejects an already-aborted signal without writing anything', async () => {
    const { child, connection } = rig()
    const controller = new AbortController()
    controller.abort()
    await expect(connection.request('m', {}, { signal: controller.signal })).rejects.toMatchObject({
      code: REQUEST_CANCELLED
    })
    await tick()
    expect(child.sent).toEqual([])
  })

  it('detaches the abort listener once the request is answered or failed', async () => {
    const { child, connection } = rig()
    const controller = new AbortController()
    const ok = connection.request('a', {}, { signal: controller.signal })
    const bad = connection.request('b', {}, { signal: controller.signal }).catch(() => {})
    child.serve({ jsonrpc: '2.0', id: 1, result: 1 })
    child.serve({ jsonrpc: '2.0', id: 2, error: { code: -1, message: 'x' } })
    await tick()
    await ok
    await bad
    controller.abort() // listeners are gone: no cancel notification for finished requests
    await tick()
    expect(child.requests('$/cancelRequest')).toHaveLength(0)
  })

  it('does not write requests nobody can read once stdin is gone', async () => {
    const { child, connection } = rig()
    child.stdin.destroy()
    const pending = connection.request('m', {}).catch((e: { code: number }) => e.code)
    await vi.advanceTimersByTimeAsync(1000)
    expect(await pending).toBe(JsonRpcErrorCodes.RequestTimeout)
    expect(child.sent).toEqual([])
  })

  it('survives EPIPE-style errors on stdin', () => {
    const { child } = rig()
    expect(() => child.stdin.emit('error', new Error('EPIPE'))).not.toThrow()
  })
})

describe('messages from the server', () => {
  it('forwards notifications', async () => {
    const { child, notifications } = rig()
    child.serve({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { a: 1 } })
    child.serve({ jsonrpc: '2.0', method: '$/progress' })
    await tick()
    expect(notifications).toEqual([
      { method: 'textDocument/publishDiagnostics', params: { a: 1 } },
      { method: '$/progress', params: undefined }
    ])
  })

  it('answers server requests with the handler’s result or error, echoing numeric and string ids', async () => {
    const { child, replies, serverRequests } = rig()
    replies.set('workspace/configuration', { result: [null, null] })
    replies.set('workspace/applyEdit', { error: { code: -32601, message: 'no' } })
    child.serve({
      jsonrpc: '2.0',
      id: 7,
      method: 'workspace/configuration',
      params: { items: [1, 2] }
    })
    child.serve({ jsonrpc: '2.0', id: 'abc', method: 'workspace/applyEdit', params: {} })
    await tick()
    expect(serverRequests.map((r) => r.method)).toEqual([
      'workspace/configuration',
      'workspace/applyEdit'
    ])
    expect(child.sent).toEqual([
      { jsonrpc: '2.0', id: 7, result: [null, null] },
      { jsonrpc: '2.0', id: 'abc', error: { code: -32601, message: 'no' } }
    ])
  })

  it('ignores junk: non-objects, unknown ids, string-id responses and unparsable bodies', async () => {
    const { child, connection, notifications, serverRequests } = rig()
    const pending = connection.request('m', {})
    child.stdout.write(encodeLspMessage(5))
    child.stdout.write(encodeLspMessage(null))
    child.serve({ jsonrpc: '2.0', result: 'no id' })
    child.serve({ jsonrpc: '2.0', id: 99, result: 'unknown id' })
    child.serve({ jsonrpc: '2.0', id: '1', result: 'string id' })
    child.stdout.write(Buffer.from('Content-Length: 5\r\n\r\n{nope'))
    child.stdout.write(Buffer.from('X-Garbage: 1\r\n\r\n'))
    await tick()
    expect(notifications).toEqual([])
    expect(serverRequests).toEqual([])
    child.serve({ jsonrpc: '2.0', id: 1, result: 'real' })
    expect(await pending).toBe('real')
  })

  it('keeps only the tail of stderr and forwards every chunk', async () => {
    const { child, connection, stderr } = rig()
    child.stderr.write('a'.repeat(3000))
    child.stderr.write('b'.repeat(3000))
    await tick()
    expect(stderr).toHaveLength(2)
    expect(connection.stderr).toHaveLength(4096)
    expect(connection.stderr.endsWith('b'.repeat(3000))).toBe(true)
    expect(connection.stderr.startsWith('a')).toBe(true)
  })

  it('works without a stderr handler', async () => {
    const child = new FakeChild()
    const connection = new LspConnection(
      { child: child as unknown as ChildProcessWithoutNullStreams, processGroup: false },
      { onNotification() {}, onServerRequest: () => ({ result: null }), onExit() {} },
      1000
    )
    child.stderr.write('oops')
    await tick()
    expect(connection.stderr).toBe('oops')
  })
})

describe('process exit', () => {
  it('rejects in-flight requests with SessionNotFound and reports the exit once', async () => {
    const { child, connection, exits } = rig()
    const pending = connection.request('m', {})
    await tick()
    child.exit(139, null)
    child.emit('exit', 139, null) // duplicate events are ignored
    await expect(pending).rejects.toMatchObject({ code: JsonRpcErrorCodes.SessionNotFound })
    expect(exits).toEqual([{ code: 139, signal: null, expected: false }])
    expect(connection.isAlive).toBe(false)
    await connection.whenExited()
    await expect(connection.request('late', {})).rejects.toMatchObject({
      code: JsonRpcErrorCodes.SessionNotFound
    })
    child.serve({ jsonrpc: '2.0', method: 'x' })
    connection.notify('exit') // no-op after exit: nothing written
    expect(child.sent.filter((m) => m.method === 'exit')).toEqual([])
  })

  it('reports a spawn failure (no pid) as an exit with the error', async () => {
    const { child, connection, exits } = rig()
    child.pid = undefined
    const error = Object.assign(new Error('spawn pyright ENOENT'), { code: 'ENOENT' })
    child.emit('error', error)
    expect(exits).toEqual([{ code: null, signal: null, error, expected: false }])
    await connection.whenExited()
    expect(connection.isAlive).toBe(false)
  })

  it('ignores error events from a process that is running', () => {
    const { child, exits, connection } = rig()
    child.emit('error', new Error('send failed'))
    expect(exits).toEqual([])
    expect(connection.isAlive).toBe(true)
    expect(connection.pid).toBe(4242)
  })

  it('terminates the whole process group when the leader exits (POSIX)', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const { child } = rig({ processGroup: true })
    child.exit(0)
    expect(kill).toHaveBeenCalledWith(-4242, 'SIGTERM')
  })

  it('does not signal a group when there is none', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const { child } = rig({ processGroup: false })
    child.exit(0)
    expect(kill).not.toHaveBeenCalled()
  })

  it('does not signal a group for a process that never started', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const { child } = rig({ processGroup: true })
    child.pid = undefined
    child.emit('error', new Error('ENOENT'))
    expect(kill).not.toHaveBeenCalled()
  })
})

describe('shutdown', () => {
  /** A server that answers `shutdown` and leaves on `exit`. */
  function wellBehaved(child: FakeChild) {
    child.onWrite = (message) => {
      if (message.method === 'shutdown') {
        child.serve({ jsonrpc: '2.0', id: message.id, result: null })
      }
      if (message.method === 'exit') {
        child.exit(0)
      }
    }
  }

  it('does shutdown → exit and marks the exit as expected', async () => {
    const { child, connection, exits } = rig()
    wellBehaved(child)
    await connection.shutdown()
    expect(child.sent.map((m) => m.method)).toEqual(['shutdown', 'exit'])
    expect(child.kills).toEqual([])
    expect(exits).toEqual([{ code: 0, signal: null, expected: true }])
  })

  it('is a no-op for a process that already exited', async () => {
    const { child, connection } = rig()
    child.exit(1)
    await connection.shutdown()
    expect(child.sent).toEqual([])
  })

  it('still sends exit when the shutdown request times out, then SIGTERMs a server that stays', async () => {
    const { child, connection } = rig()
    child.dieOn = new Set(['SIGTERM'])
    const done = connection.shutdown()
    await vi.advanceTimersByTimeAsync(2000) // shutdown request unanswered
    expect(child.requests('exit')).toHaveLength(1)
    expect(child.kills).toEqual([])
    await vi.advanceTimersByTimeAsync(2000) // did not exit after `exit`
    await done
    expect(child.kills).toEqual(['SIGTERM'])
    expect(connection.isAlive).toBe(false)
  })

  it('escalates to SIGKILL for a server that ignores everything, and gives up after the last wait', async () => {
    const { child, connection } = rig()
    child.dieOn = new Set()
    const done = connection.shutdown()
    await vi.advanceTimersByTimeAsync(2000 * 4)
    await done
    expect(child.kills).toEqual(['SIGTERM', 'SIGKILL'])
    expect(connection.isAlive).toBe(true) // the process is truly stuck; nothing more to do
  })

  it('signals the process group first and falls back to the child when that fails', async () => {
    const kill = vi
      .spyOn(process, 'kill')
      .mockImplementationOnce(() => {
        throw new Error('ESRCH')
      })
      .mockImplementation(() => true)
    const { child, connection } = rig({ processGroup: true })
    child.dieOn = new Set(['SIGTERM'])
    const done = connection.shutdown()
    await vi.advanceTimersByTimeAsync(2000 * 3)
    await done
    // first the group signal threw, so the child itself was signalled
    expect(kill).toHaveBeenCalledWith(-4242, 'SIGTERM')
    expect(child.kills).toEqual(['SIGTERM'])
  })

  it('kill() sends SIGKILL right away', () => {
    const { child, connection, exits } = rig()
    connection.kill()
    expect(child.kills).toEqual(['SIGKILL'])
    expect(exits[0]?.expected).toBe(true)
    connection.kill() // already gone: nothing more to signal
    expect(child.kills).toEqual(['SIGKILL'])
  })
})
