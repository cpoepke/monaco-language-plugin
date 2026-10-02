import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JsonRpcErrorCodes, type OpenDocumentResult } from '@mlp/protocol'
import { RpcError, type BridgeConnection } from '../src/connection'
import {
  DocumentManager,
  OPEN_RETRY_INITIAL_MS,
  OPEN_RETRY_MAX_MS,
  isRetryableNoSession,
  type SyncModel
} from '../src/documents'

function model(uri = 'file:///repo/a.ts'): SyncModel {
  return {
    uri: { toString: () => uri },
    getLanguageId: () => 'typescript',
    getValue: () => 'x',
    isDisposed: () => false,
    onDidChangeContent: () => ({ dispose() {} })
  }
}

const opened: OpenDocumentResult = {
  sessionId: 's1',
  uri: 'file:///repo/a.ts',
  serverId: 'ts',
  rootPath: '/repo',
  pullDiagnostics: false
}

function setup(answers: (() => unknown)[]) {
  const request = vi.fn(async () => {
    const next = answers.shift()
    if (!next) throw new Error('no more answers')
    return next()
  })
  const connection = {
    isConnected: true,
    request,
    notify: vi.fn(() => true)
  } as unknown as BridgeConnection
  const documents = new DocumentManager({ connection, logger: {} })
  return { documents, request, connection }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('pull diagnostics', () => {
  it('a newer pull supersedes (and cancels) an older one that answers late', async () => {
    let content = 'v1'
    const listeners: (() => void)[] = []
    const syncModel: SyncModel = {
      uri: { toString: () => 'file:///repo/a.ts' },
      getLanguageId: () => 'typescript',
      getValue: () => content,
      isDisposed: () => false,
      onDidChangeContent: (listener) => {
        listeners.push(listener)
        return { dispose() {} }
      }
    }
    const pulls: {
      resolve: (value: unknown) => void
      token: { isCancellationRequested: boolean }
    }[] = []
    const request = vi.fn(
      async (method: string, params: { method?: string }, options?: { token?: never }) => {
        if (method === 'document/open') return { ...opened, pullDiagnostics: true }
        expect(params.method).toBe('textDocument/diagnostic')
        return new Promise((resolve) => pulls.push({ resolve, token: options!.token! }))
      }
    )
    const connection = {
      isConnected: true,
      request,
      notify: vi.fn(() => true)
    } as unknown as BridgeConnection
    const markers: unknown[][] = []
    const documents = new DocumentManager({
      connection,
      logger: {},
      changeDebounceMs: 10,
      setMarkers: (_model, diagnostics) => markers.push(diagnostics)
    })
    documents.attach(syncModel)
    await vi.advanceTimersByTimeAsync(0)
    expect(pulls).toHaveLength(1)
    content = 'v2'
    listeners.forEach((listener) => listener())
    await vi.advanceTimersByTimeAsync(10)
    expect(pulls).toHaveLength(2)
    expect(pulls[0]!.token.isCancellationRequested).toBe(true)
    pulls[1]!.resolve({ kind: 'full', items: [{ message: 'new' }] })
    await vi.advanceTimersByTimeAsync(0)
    pulls[0]!.resolve({ kind: 'full', items: [{ message: 'old' }] })
    await vi.advanceTimersByTimeAsync(0)
    expect(markers).toEqual([[{ message: 'new' }]])
  })
})

describe('no-session results', () => {
  it('classifies reasons, honouring the optional retryable flag', () => {
    expect(isRetryableNoSession({ reason: 'unsupported language: plaintext' })).toBe(false)
    expect(isRetryableNoSession({ reason: 'no language server found for go' })).toBe(false)
    expect(isRetryableNoSession({ reason: 'too many language servers running (max 8)' })).toBe(true)
    expect(isRetryableNoSession({ reason: 'pyright failed to start: initialize timed out' })).toBe(
      true
    )
    expect(isRetryableNoSession({ reason: 'gopls exited during startup' })).toBe(true)
    expect(isRetryableNoSession({ reason: 'gopls exited during startup', retryable: false })).toBe(
      false
    )
    expect(isRetryableNoSession({ reason: 'whatever', retryable: true })).toBe(true)
  })

  it('stays sticky for non-retryable reasons', async () => {
    const { documents, request } = setup([
      () => ({ sessionId: null, reason: 'no language server found for typescript' })
    ])
    const entry = documents.attach(model())
    await vi.advanceTimersByTimeAsync(0)
    expect(documents.info()[0]).toMatchObject({ state: 'no-session' })
    await vi.advanceTimersByTimeAsync(10 * OPEN_RETRY_MAX_MS)
    expect(await documents.ensureSession(entry)).toBeNull()
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('also stays sticky when the bridge says retryable: false', async () => {
    const { documents, request } = setup([
      () => ({ sessionId: null, reason: 'too many language servers', retryable: false })
    ])
    documents.attach(model())
    await vi.advanceTimersByTimeAsync(10 * OPEN_RETRY_MAX_MS)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('retries retryable failures with backoff 2 s → 4 s → 8 s, then succeeds', async () => {
    const cap = { sessionId: null, reason: 'too many language servers running (max 1)' }
    const { documents, request } = setup([
      () => cap,
      () => cap,
      () => ({ sessionId: null, reason: 'x', retryable: true }),
      () => opened
    ])
    const entry = documents.attach(model())
    await vi.advanceTimersByTimeAsync(0)
    expect(request).toHaveBeenCalledTimes(1)
    // not due yet: provider requests answer null without another document/open
    expect(await documents.ensureSession(entry)).toBeNull()
    expect(request).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(OPEN_RETRY_INITIAL_MS)
    expect(request).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(2 * OPEN_RETRY_INITIAL_MS - 1)
    expect(request).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(request).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(4 * OPEN_RETRY_INITIAL_MS)
    expect(request).toHaveBeenCalledTimes(4)
    expect(documents.info()[0]).toMatchObject({ state: 'open', sessionId: 's1', reason: null })
    expect(entry.openFailures).toBe(0)
  })

  it('caps the delay at 60 s and gives up after a bounded number of attempts', async () => {
    const cap = () => ({ sessionId: null, reason: 'x', retryable: true })
    const { documents, request } = setup(Array.from({ length: 50 }, () => cap))
    documents.attach(model())
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    const calls = request.mock.calls.length
    expect(calls).toBeGreaterThan(5)
    expect(calls).toBeLessThan(15)
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(request.mock.calls.length).toBe(calls)
  })

  it('backs off after transport errors, but a PathNotAllowed error is final', async () => {
    const { documents, request } = setup([
      () => {
        throw new RpcError(JsonRpcErrorCodes.RequestTimeout, 'slow')
      },
      () => opened
    ])
    const entry = documents.attach(model())
    await vi.advanceTimersByTimeAsync(0)
    expect(documents.info()[0]?.state).toBe('no-session')
    expect(await documents.ensureSession(entry)).toBeNull()
    await vi.advanceTimersByTimeAsync(OPEN_RETRY_INITIAL_MS)
    expect(request).toHaveBeenCalledTimes(2)
    expect(documents.info()[0]?.state).toBe('open')

    const denied = setup([
      () => {
        throw new RpcError(JsonRpcErrorCodes.PathNotAllowed, 'outside roots')
      }
    ])
    denied.documents.attach(model('file:///elsewhere/b.ts'))
    await vi.advanceTimersByTimeAsync(10 * OPEN_RETRY_MAX_MS)
    expect(denied.request).toHaveBeenCalledTimes(1)
  })

  it('cancels a pending retry when the document is detached', async () => {
    const { documents, request } = setup([
      () => ({ sessionId: null, reason: 'x', retryable: true })
    ])
    documents.attach(model())
    await vi.advanceTimersByTimeAsync(0)
    documents.detach('file:///repo/a.ts')
    await vi.advanceTimersByTimeAsync(OPEN_RETRY_MAX_MS)
    expect(request).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
