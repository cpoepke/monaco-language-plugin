/**
 * SessionManager with scripted fake language servers: startup failures, crash
 * handling and loops, shared documents, ownership checks and idle shutdown.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BridgeMethods, JsonRpcErrorCodes } from '@mlp/protocol'
import type { BridgeLogger } from '../src/logger'
import type { ResolvedLspServer } from '../src/lsp/server-catalog'
import { SessionManager, type OpenDocumentArgs } from '../src/sessions/session-manager'
import { activeTreeWatchers } from '../src/workspace/watched-files'
import { FakeChild, type Sent } from './helpers/fake-child'

const server = (serverId = 'fake'): ResolvedLspServer => ({
  serverId,
  command: serverId,
  args: ['--stdio'],
  executablePath: path.resolve('/opt', serverId)
})

let root: string
let otherRoot: string
let base: string

const uri = (dir: string, name: string) => pathToFileURL(path.join(dir, name)).toString()

type Script = (child: FakeChild, message: Sent) => boolean | void

type Rig = ReturnType<typeof makeRig>

function makeRig(options: { maxSessions?: number; idleShutdownMs?: number } = {}) {
  const children: FakeChild[] = []
  const notified: { clientId: number; method: string; params: any }[] = []
  const logs: { level: string; message: string; meta?: Record<string, unknown> }[] = []
  const logger: BridgeLogger = {
    debug: (message, meta) => logs.push({ level: 'debug', message, meta }),
    info: (message, meta) => logs.push({ level: 'info', message, meta }),
    warn: (message, meta) => logs.push({ level: 'warn', message, meta }),
    error: (message, meta) => logs.push({ level: 'error', message, meta })
  }
  const state: { script: Script; capabilities: Record<string, unknown>; spawnError: Error | null } =
    {
      script: () => false,
      capabilities: {},
      spawnError: null
    }
  const manager = new SessionManager({
    requestTimeoutMs: 1000,
    idleShutdownMs: options.idleShutdownMs ?? 500,
    maxSessions: options.maxSessions ?? 8,
    logger,
    notifyClient: (clientId, method, params) => notified.push({ clientId, method, params }),
    spawnServer: () => {
      if (state.spawnError) {
        throw state.spawnError
      }
      const child = new FakeChild()
      child.onWrite = (message) => {
        if (state.script(child, message)) {
          return
        }
        if (message.method === 'initialize') {
          child.serve({
            jsonrpc: '2.0',
            id: message.id,
            result: { capabilities: state.capabilities }
          })
        } else if (message.method === 'shutdown') {
          child.serve({ jsonrpc: '2.0', id: message.id, result: null })
        } else if (message.method === 'exit') {
          child.exit(0)
        } else if (message.id !== undefined) {
          child.serve({ jsonrpc: '2.0', id: message.id, result: { echo: message.params } })
        }
      }
      children.push(child)
      return { child: child as unknown as ChildProcessWithoutNullStreams, processGroup: false }
    }
  })
  return { manager, children, notified, logs, state }
}

function openArgs(overrides: Partial<OpenDocumentArgs> = {}): OpenDocumentArgs {
  const serverUri = uri(root, 'a.ts')
  return {
    clientId: 1,
    server: server(),
    rootPath: root,
    clientUri: serverUri,
    serverUri,
    lspLanguageId: 'typescript',
    text: 'let a = 1',
    ...overrides
  }
}

const methods = (child: FakeChild) => child.sent.map((message) => message.method)
const tick = () => vi.advanceTimersByTimeAsync(0)
/** Lets stream data events and promise chains settle (real timers). */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10))

let rigs: Rig[] = []
function rig(options?: Parameters<typeof makeRig>[0]): Rig {
  const created = makeRig(options)
  rigs.push(created)
  return created
}

beforeEach(() => {
  base = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'mlp-sessions-')))
  root = path.join(base, 'proj')
  otherRoot = path.join(base, 'other')
})

afterEach(async () => {
  vi.useRealTimers()
  for (const created of rigs) {
    await created.manager.closeAll()
  }
  rigs = []
  rmSync(base, { recursive: true, force: true })
})

describe('opening documents', () => {
  it('starts the server once, performs the LSP handshake and sends didOpen', async () => {
    const { manager, children } = rig()
    const result = await manager.openDocument(openArgs())
    expect(result).toEqual({
      sessionId: 's1',
      uri: uri(root, 'a.ts'),
      serverId: 'fake',
      rootPath: root,
      pullDiagnostics: false
    })
    expect(children).toHaveLength(1)
    await settle()
    const sent = children[0]!.sent
    expect(sent[0]).toMatchObject({
      method: 'initialize',
      params: { rootPath: root, processId: process.pid }
    })
    expect(methods(children[0]!).slice(1)).toEqual(['initialized', 'textDocument/didOpen'])
    expect(sent[2]).toMatchObject({
      params: {
        textDocument: {
          uri: uri(root, 'a.ts'),
          languageId: 'typescript',
          version: 1,
          text: 'let a = 1'
        }
      }
    })
    expect(manager.status()).toEqual([
      { sessionId: 's1', serverId: 'fake', rootPath: root, openDocuments: 1, state: 'running' }
    ])
  })

  it('reports pull-diagnostics servers', async () => {
    const t = rig()
    t.state.capabilities = { diagnosticProvider: { interFileDependencies: false } }
    expect(
      (await t.manager.openDocument(openArgs())) as { pullDiagnostics: boolean }
    ).toMatchObject({
      pullDiagnostics: true
    })
  })

  it('shares one session between concurrent opens and between clients', async () => {
    const { manager, children } = rig()
    const [a, b] = await Promise.all([
      manager.openDocument(openArgs({ clientId: 1 })),
      manager.openDocument(openArgs({ clientId: 2, text: 'let a = 1' }))
    ])
    expect(children).toHaveLength(1)
    expect(a).toMatchObject({ sessionId: 's1' })
    expect(b).toMatchObject({ sessionId: 's1' })
    await settle()
    // one didOpen no matter how many clients view the file
    expect(methods(children[0]!).filter((m) => m === 'textDocument/didOpen')).toHaveLength(1)
  })

  it('last writer wins when a second client opens the same file with different text', async () => {
    const { manager, children } = rig()
    await manager.openDocument(openArgs({ clientId: 1 }))
    await manager.openDocument(openArgs({ clientId: 2, text: 'let a = 2 // unsaved' }))
    await settle()
    const change = children[0]!.requests('textDocument/didChange')[0]
    expect(change?.params).toEqual({
      textDocument: { uri: uri(root, 'a.ts'), version: 2 },
      contentChanges: [{ text: 'let a = 2 // unsaved' }]
    })
  })

  it('refuses to open anything once the manager is closing', async () => {
    const { manager, children } = rig()
    await manager.closeAll()
    expect(await manager.openDocument(openArgs())).toEqual({
      sessionId: null,
      reason: 'bridge is shutting down',
      retryable: true
    })
    expect(children).toHaveLength(0)
  })

  it('keeps servers of different roots apart', async () => {
    const { manager, children } = rig()
    await manager.openDocument(openArgs())
    await manager.openDocument(
      openArgs({
        rootPath: otherRoot,
        serverUri: uri(otherRoot, 'b.ts'),
        clientUri: uri(otherRoot, 'b.ts')
      })
    )
    expect(children).toHaveLength(2)
    expect(manager.status().map((s) => s.rootPath)).toEqual([root, otherRoot])
  })
})

describe('startup failures', () => {
  it('reports a server that rejects initialize as final and kills it', async () => {
    const t = rig()
    t.state.script = (child, message) => {
      if (message.method === 'initialize') {
        child.serve({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32603, message: 'bad config' }
        })
        child.stderr.write('server log line')
        return true
      }
      return false
    }
    const result = await t.manager.openDocument(openArgs())
    expect(result).toMatchObject({ sessionId: null, retryable: false })
    expect((result as { reason: string }).reason).toMatch(/^fake failed to start: bad config/)
    expect(t.children[0]!.kills).toEqual(['SIGKILL'])
    expect(t.manager.status()).toEqual([])
    expect(
      t.logs.some((l) => l.level === 'warn' && l.message === 'language server failed to initialize')
    ).toBe(true)
  })

  it('includes the server’s stderr tail in the reason', async () => {
    const t = rig()
    t.state.script = (child, message) => {
      if (message.method === 'initialize') {
        child.stderr.write('Traceback: module not found\n')
        setTimeout(
          () =>
            child.serve({ jsonrpc: '2.0', id: message.id, error: { code: -1, message: 'boom' } }),
          5
        )
        return true
      }
      return false
    }
    const result = (await t.manager.openDocument(openArgs())) as { reason: string }
    expect(result.reason).toContain('Traceback: module not found')
  })

  it('treats a server that dies while initializing as retryable', async () => {
    const t = rig()
    t.state.script = (child, message) => {
      if (message.method === 'initialize') {
        setTimeout(() => child.exit(1), 5)
        return true
      }
      return false
    }
    const result = await t.manager.openDocument(openArgs())
    expect(result).toMatchObject({ sessionId: null, retryable: true })
    expect((result as { reason: string }).reason).toMatch(/failed to start: Language server exited/)
  })

  it('treats an initialize timeout as retryable', async () => {
    vi.useFakeTimers()
    const t = rig()
    t.state.script = (_child, message) => message.method === 'initialize'
    const pending = t.manager.openDocument(openArgs())
    await vi.advanceTimersByTimeAsync(60_000)
    const result = await pending
    expect(result).toMatchObject({ sessionId: null, retryable: true })
    expect((result as { reason: string }).reason).toMatch(/timed out: initialize/)
  })

  it('treats a binary that cannot be spawned as final', async () => {
    const t = rig()
    t.state.script = (child, message) => {
      if (message.method === 'initialize') {
        child.pid = undefined
        child.emit('error', Object.assign(new Error('spawn fake ENOENT'), { code: 'ENOENT' }))
        return true
      }
      return false
    }
    const result = await t.manager.openDocument(openArgs())
    expect(result).toMatchObject({ sessionId: null, retryable: false })
    expect((result as { reason: string }).reason).toMatch(/^fake failed to start/)
  })

  it('lets a spawn exception propagate instead of leaving a half-created session', async () => {
    const t = rig()
    t.state.spawnError = new Error('refusing to spawn a relative command')
    await expect(t.manager.openDocument(openArgs())).rejects.toThrow(/relative command/)
    expect(t.manager.status()).toEqual([])
  })

  it('answers retryably when the session was stopped before it finished starting', async () => {
    const t = rig()
    let initialize: Sent | undefined
    t.state.script = (_child, message) => {
      if (message.method === 'initialize') {
        initialize = message
        return true
      }
      return false
    }
    const pending = t.manager.openDocument(openArgs())
    await settle()
    const closing = t.manager.closeAll()
    t.children[0]!.serve({ jsonrpc: '2.0', id: initialize!.id, result: { capabilities: {} } })
    expect(await pending).toMatchObject({
      sessionId: null,
      retryable: true,
      reason: expect.stringContaining('exited during startup')
    })
    await closing
  })

  it('stops restarting a server that keeps failing for the same root', async () => {
    const t = rig()
    t.state.script = (child, message) => {
      if (message.method === 'initialize') {
        child.serve({ jsonrpc: '2.0', id: message.id, error: { code: -1, message: 'nope' } })
        return true
      }
      return false
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(await t.manager.openDocument(openArgs())).toMatchObject({ sessionId: null })
      await settle()
    }
    expect(t.children).toHaveLength(3)
    const fourth = await t.manager.openDocument(openArgs())
    expect(fourth).toMatchObject({ sessionId: null, retryable: false })
    expect((fourth as { reason: string }).reason).toMatch(/crashed 3 times in the last 5 minutes/)
    expect(t.children).toHaveLength(3)
    // another root is unaffected
    t.state.script = () => false
    expect(
      await t.manager.openDocument(
        openArgs({
          rootPath: otherRoot,
          serverUri: uri(otherRoot, 'b.ts'),
          clientUri: uri(otherRoot, 'b.ts')
        })
      )
    ).toMatchObject({ sessionId: 's4' })
  })

  it('forgets old crashes after the window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const t = rig()
    let crash = true
    t.state.script = (child, message) => {
      if (crash && message.method === 'initialize') {
        child.serve({ jsonrpc: '2.0', id: message.id, error: { code: -1, message: 'nope' } })
        return true
      }
      return false
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      await t.manager.openDocument(openArgs())
      await settle()
    }
    vi.setSystemTime(Date.now() + 5 * 60_000 + 1)
    crash = false
    expect(await t.manager.openDocument(openArgs())).toMatchObject({
      sessionId: expect.any(String)
    })
  })
})

describe('session cap', () => {
  const other = () => ({
    rootPath: otherRoot,
    serverUri: uri(otherRoot, 'b.ts'),
    clientUri: uri(otherRoot, 'b.ts')
  })

  it('refuses a new session when every slot is busy', async () => {
    const { manager } = rig({ maxSessions: 1 })
    await manager.openDocument(openArgs())
    expect(await manager.openDocument(openArgs(other()))).toEqual({
      sessionId: null,
      reason: 'too many language servers running (max 1)',
      retryable: true
    })
  })

  it('evicts an idle session (no documents) to make room', async () => {
    const t = rig({ maxSessions: 1 })
    await t.manager.openDocument(openArgs())
    const opened = uri(root, 'a.ts')
    expect(t.manager.closeDocument(1, 's1', opened)).toBe(true)
    expect(await t.manager.openDocument(openArgs(other()))).toMatchObject({ sessionId: 's2' })
    await t.manager.closeAll()
    expect(t.children[0]!.requests('shutdown')).toHaveLength(1)
  })
})

describe('document ownership', () => {
  it('syncs full-text changes only for owners, skipping identical text', async () => {
    const { manager, children } = rig()
    await manager.openDocument(openArgs({ clientId: 1 }))
    const documentUri = uri(root, 'a.ts')
    expect(manager.changeDocument(2, 's1', documentUri, 'x')).toBe(false) // not an owner
    expect(manager.changeDocument(1, 'nope', documentUri, 'x')).toBe(false) // unknown session
    expect(manager.changeDocument(1, 's1', uri(root, 'missing.ts'), 'x')).toBe(false)
    expect(manager.changeDocument(1, 's1', documentUri, 'let a = 1')).toBe(true) // unchanged
    expect(manager.changeDocument(1, 's1', documentUri, 'let a = 2')).toBe(true)
    await settle()
    expect(children[0]!.requests('textDocument/didChange')).toHaveLength(1)
    expect(children[0]!.requests('textDocument/didChange')[0]?.params).toMatchObject({
      textDocument: { version: 2 },
      contentChanges: [{ text: 'let a = 2' }]
    })
  })

  it('counts opens per client and closes the document after the last close', async () => {
    const { manager, children } = rig()
    await manager.openDocument(openArgs())
    await manager.openDocument(openArgs())
    const documentUri = uri(root, 'a.ts')
    expect(manager.closeDocument(2, 's1', documentUri)).toBe(false) // not an owner
    expect(manager.closeDocument(1, 'nope', documentUri)).toBe(false)
    expect(manager.closeDocument(1, 's1', documentUri)).toBe(true)
    await settle()
    expect(children[0]!.requests('textDocument/didClose')).toHaveLength(0)
    expect(manager.closeDocument(1, 's1', documentUri)).toBe(true)
    await settle()
    expect(children[0]!.requests('textDocument/didClose')).toHaveLength(1)
    expect(manager.closeDocument(1, 's1', documentUri)).toBe(false)
  })

  it('keeps the document open for other clients when one closes', async () => {
    const { manager, children } = rig()
    await manager.openDocument(openArgs({ clientId: 1 }))
    await manager.openDocument(openArgs({ clientId: 2 }))
    manager.closeDocument(1, 's1', uri(root, 'a.ts'))
    await settle()
    expect(children[0]!.requests('textDocument/didClose')).toHaveLength(0)
    manager.releaseClient(2)
    await settle()
    expect(children[0]!.requests('textDocument/didClose')).toHaveLength(1)
  })

  it('finds a document through the spelling the client used (symlinked paths)', async () => {
    const { manager, children } = rig()
    const clientUri = uri(path.join(base, 'link'), 'a.ts')
    await manager.openDocument(openArgs({ clientUri }))
    expect(manager.changeDocument(1, 's1', clientUri, 'let a = 3')).toBe(true)
    await expect(
      manager.request(1, 's1', 'textDocument/hover', { textDocument: { uri: clientUri } })
    ).resolves.toMatchObject({ echo: { textDocument: { uri: uri(root, 'a.ts') } } })
    expect(manager.closeDocument(1, 's1', clientUri)).toBe(true)
    await settle()
    expect(children[0]!.requests('textDocument/didClose')[0]?.params).toEqual({
      textDocument: { uri: uri(root, 'a.ts') }
    })
    // the alias died with the document
    expect(manager.changeDocument(1, 's1', clientUri, 'x')).toBe(false)
  })

  it('releases every document of a disconnected client', async () => {
    const { manager, children } = rig()
    await manager.openDocument(openArgs({ clientId: 1 }))
    await manager.openDocument(
      openArgs({ clientId: 1, serverUri: uri(root, 'b.ts'), clientUri: uri(root, 'b.ts') })
    )
    manager.releaseClient(1)
    manager.releaseClient(99) // unknown clients are fine
    await settle()
    expect(children[0]!.requests('textDocument/didClose')).toHaveLength(2)
    expect(manager.status()[0]?.openDocuments).toBe(0)
  })
})

describe('forwarding requests', () => {
  it('rewrites the document uri to the server’s and returns the result', async () => {
    const { manager } = rig()
    await manager.openDocument(openArgs())
    const result = await manager.request(1, 's1', 'textDocument/hover', {
      textDocument: { uri: uri(root, 'a.ts') },
      position: { line: 0, character: 1 }
    })
    expect(result).toEqual({
      echo: {
        textDocument: { uri: uri(root, 'a.ts') },
        position: { line: 0, character: 1 }
      }
    })
  })

  it('rejects unknown sessions with SessionNotFound', async () => {
    const { manager } = rig()
    await expect(manager.request(1, 'sX', 'textDocument/hover', {})).rejects.toMatchObject({
      code: JsonRpcErrorCodes.SessionNotFound
    })
  })

  it('refuses documents the client has not opened, and malformed params', async () => {
    const { manager } = rig()
    await manager.openDocument(openArgs({ clientId: 1 }))
    const bad = (params: unknown, clientId = 1) =>
      manager.request(clientId, 's1', 'textDocument/hover', params)
    await expect(bad({ textDocument: { uri: uri(root, 'a.ts') } }, 2)).rejects.toMatchObject({
      code: JsonRpcErrorCodes.InvalidParams,
      message: expect.stringContaining('not open')
    })
    await expect(bad({ textDocument: { uri: uri(root, 'zzz.ts') } })).rejects.toMatchObject({
      code: JsonRpcErrorCodes.InvalidParams
    })
    await expect(bad(null)).rejects.toMatchObject({ code: JsonRpcErrorCodes.InvalidParams })
    await expect(bad([1])).rejects.toMatchObject({ code: JsonRpcErrorCodes.InvalidParams })
    await expect(bad({ textDocument: { uri: 5 } })).rejects.toMatchObject({
      code: JsonRpcErrorCodes.InvalidParams,
      message: 'textDocument.uri must be a string'
    })
    await expect(bad({ textDocument: 'x' })).rejects.toMatchObject({
      code: JsonRpcErrorCodes.InvalidParams
    })
  })

  it('scopes document-less requests to clients that use the session', async () => {
    const { manager } = rig()
    await manager.openDocument(openArgs({ clientId: 1 }))
    await expect(manager.request(1, 's1', 'documentLink/resolve', { data: 1 })).resolves.toEqual({
      echo: { data: 1 }
    })
    await expect(
      manager.request(2, 's1', 'documentLink/resolve', { data: 1 })
    ).rejects.toMatchObject({
      code: JsonRpcErrorCodes.InvalidParams,
      message: 'No documents open on session s1'
    })
  })

  it('cancels the server request through the abort signal', async () => {
    const t = rig()
    t.state.script = (_child, message) => message.method === 'textDocument/hover'
    await t.manager.openDocument(openArgs())
    const controller = new AbortController()
    const pending = t.manager.request(
      1,
      's1',
      'textDocument/hover',
      { textDocument: { uri: uri(root, 'a.ts') } },
      controller.signal
    )
    await settle()
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: -32800 })
    await settle()
    expect(t.children[0]!.requests('$/cancelRequest')).toHaveLength(1)
  })

  it('fails requests with SessionNotFound once the server crashed', async () => {
    const t = rig()
    t.state.script = (_child, message) => message.method === 'textDocument/hover'
    await t.manager.openDocument(openArgs())
    const pending = t.manager.request(1, 's1', 'textDocument/hover', {
      textDocument: { uri: uri(root, 'a.ts') }
    })
    const assertion = expect(pending).rejects.toMatchObject({
      code: JsonRpcErrorCodes.SessionNotFound
    })
    await settle()
    t.children[0]!.exit(139)
    await assertion
    await expect(t.manager.request(1, 's1', 'textDocument/hover', {})).rejects.toMatchObject({
      code: JsonRpcErrorCodes.SessionNotFound
    })
  })
})

describe('crashes', () => {
  async function crashWith(exit: (child: FakeChild) => void, stderr = '') {
    const t = rig()
    await t.manager.openDocument(openArgs({ clientId: 1 }))
    await t.manager.openDocument(
      openArgs({ clientId: 2, serverUri: uri(root, 'b.ts'), clientUri: uri(root, 'b.ts') })
    )
    if (stderr) {
      t.children[0]!.stderr.write(stderr)
      await settle()
    }
    exit(t.children[0]!)
    await settle()
    return t
  }

  it('tells every owner when the server exits with a code', async () => {
    const t = await crashWith((child) => child.exit(3), 'panic: out of memory\n')
    expect(t.notified.map((n) => [n.clientId, n.method])).toEqual([
      [1, BridgeMethods.sessionClosed],
      [2, BridgeMethods.sessionClosed]
    ])
    expect(t.notified[0]?.params).toMatchObject({ sessionId: 's1' })
    expect(t.notified[0]?.params.reason).toMatch(
      /^fake exited unexpectedly \(code 3\)\npanic: out of memory/
    )
    expect(t.manager.status()).toEqual([])
    expect(t.logs.some((l) => l.message === 'language server crashed')).toBe(true)
  })

  it('names the signal, or an unknown code', async () => {
    const signalled = await crashWith((child) => child.exit(null, 'SIGSEGV'))
    expect(signalled.notified[0]?.params.reason).toContain('(signal SIGSEGV)')
    const unknown = await crashWith((child) => child.exit(null, null))
    expect(unknown.notified[0]?.params.reason).toContain('(code unknown)')
  })

  it('names a spawn error', async () => {
    const t = await crashWith((child) => {
      child.pid = undefined
      child.emit('error', new Error('spawn EACCES'))
    })
    expect(t.notified[0]?.params.reason).toContain('spawn EACCES')
  })

  it('lets the next open start a fresh server', async () => {
    const t = await crashWith((child) => child.exit(1))
    expect(await t.manager.openDocument(openArgs({ clientId: 1 }))).toMatchObject({
      sessionId: 's2'
    })
    expect(t.children).toHaveLength(2)
  })

  it('does not report a requested stop as a crash', async () => {
    const t = rig()
    await t.manager.openDocument(openArgs())
    await t.manager.closeAll()
    expect(t.notified).toEqual([])
    expect(t.logs.some((l) => l.message === 'language server stopped')).toBe(true)
    expect(t.logs.some((l) => l.message === 'language server crashed')).toBe(false)
  })
})

describe('idle shutdown', () => {
  it('stops a session with no documents after the idle period', async () => {
    vi.useFakeTimers()
    const t = rig({ idleShutdownMs: 500 })
    await t.manager.openDocument(openArgs())
    await tick()
    t.manager.closeDocument(1, 's1', uri(root, 'a.ts'))
    await vi.advanceTimersByTimeAsync(499)
    expect(t.manager.status()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(t.manager.status()).toEqual([])
    expect(t.children[0]!.requests('shutdown')).toHaveLength(1)
    expect(t.logs.some((l) => l.message === 'stopping idle language server')).toBe(true)
  })

  it('keeps the session when a document is opened again in time', async () => {
    vi.useFakeTimers()
    const t = rig({ idleShutdownMs: 500 })
    await t.manager.openDocument(openArgs())
    t.manager.closeDocument(1, 's1', uri(root, 'a.ts'))
    await vi.advanceTimersByTimeAsync(300)
    await t.manager.openDocument(openArgs())
    await vi.advanceTimersByTimeAsync(5000)
    expect(t.manager.status()).toHaveLength(1)
    expect(t.children).toHaveLength(1)
  })

  it('schedules the idle stop only once and not for a session that is already gone', async () => {
    vi.useFakeTimers()
    const t = rig({ idleShutdownMs: 500 })
    await t.manager.openDocument(openArgs())
    await t.manager.openDocument(
      openArgs({ serverUri: uri(root, 'b.ts'), clientUri: uri(root, 'b.ts') })
    )
    t.manager.closeDocument(1, 's1', uri(root, 'a.ts'))
    t.manager.closeDocument(1, 's1', uri(root, 'b.ts'))
    t.manager.releaseClient(1) // second trigger while the timer runs
    await vi.advanceTimersByTimeAsync(500)
    expect(t.children[0]!.requests('shutdown')).toHaveLength(1)
  })

  it('does not stop a session that gained a document while the timer ran', async () => {
    vi.useFakeTimers()
    const t = rig({ idleShutdownMs: 500 })
    await t.manager.openDocument(openArgs())
    t.manager.closeDocument(1, 's1', uri(root, 'a.ts'))
    // the timer is armed; a pending open keeps the session busy when it fires
    const second = t.manager.openDocument(
      openArgs({ clientId: 2, serverUri: uri(root, 'b.ts'), clientUri: uri(root, 'b.ts') })
    )
    await vi.advanceTimersByTimeAsync(600)
    await second
    expect(t.manager.status()).toHaveLength(1)
    expect(t.manager.status()[0]?.openDocuments).toBe(1)
  })

  it('stops a doc-less session when its only client disconnects', async () => {
    vi.useFakeTimers()
    const t = rig({ idleShutdownMs: 100 })
    await t.manager.openDocument(openArgs())
    t.manager.releaseClient(1)
    await vi.advanceTimersByTimeAsync(100)
    expect(t.manager.status()).toEqual([])
  })
})

describe('diagnostics and logging from the server', () => {
  const publish = (child: FakeChild, params: unknown) =>
    child.serve({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params })

  it('forwards diagnostics only to owners of the document, with their spelling of the uri', async () => {
    const t = rig()
    const clientUri = uri(path.join(base, 'link'), 'a.ts')
    await t.manager.openDocument(openArgs({ clientId: 1, clientUri }))
    await t.manager.openDocument(openArgs({ clientId: 2 }))
    await t.manager.openDocument(
      openArgs({ clientId: 3, serverUri: uri(root, 'b.ts'), clientUri: uri(root, 'b.ts') })
    )
    publish(t.children[0]!, {
      uri: uri(root, 'a.ts'),
      diagnostics: [{ message: 'x', range: {} }]
    })
    await settle()
    const diagnostics = t.notified.filter((n) => n.method === BridgeMethods.diagnostics)
    expect(diagnostics.map((n) => [n.clientId, n.params.uri])).toEqual([
      [1, clientUri],
      [2, uri(root, 'a.ts')]
    ])
    expect(diagnostics[0]?.params).toMatchObject({
      sessionId: 's1',
      diagnostics: [{ message: 'x' }]
    })
  })

  it('ignores diagnostics for files nobody opened and malformed notifications', async () => {
    const t = rig()
    await t.manager.openDocument(openArgs())
    publish(t.children[0]!, { uri: uri(root, 'other.ts'), diagnostics: [] })
    publish(t.children[0]!, null)
    publish(t.children[0]!, { uri: 5 })
    await settle()
    expect(t.notified).toEqual([])
  })

  it('treats a non-array diagnostics field as "none"', async () => {
    const t = rig()
    await t.manager.openDocument(openArgs())
    publish(t.children[0]!, { uri: uri(root, 'a.ts'), diagnostics: 'nope' })
    await settle()
    expect(t.notified[0]?.params.diagnostics).toEqual([])
  })

  it('replays the last diagnostics to a client that joins an open document', async () => {
    const t = rig()
    await t.manager.openDocument(openArgs({ clientId: 1 }))
    publish(t.children[0]!, { uri: uri(root, 'a.ts'), diagnostics: [{ message: 'old news' }] })
    await settle()
    t.notified.length = 0
    await t.manager.openDocument(openArgs({ clientId: 2 }))
    await settle()
    expect(t.notified).toHaveLength(1)
    expect(t.notified[0]).toMatchObject({
      clientId: 2,
      method: BridgeMethods.diagnostics,
      params: { diagnostics: [{ message: 'old news' }] }
    })
  })

  it('logs window messages at debug level and ignores other notifications', async () => {
    const t = rig()
    await t.manager.openDocument(openArgs())
    t.children[0]!.serve({
      jsonrpc: '2.0',
      method: 'window/logMessage',
      params: { message: 'indexing' }
    })
    t.children[0]!.serve({ jsonrpc: '2.0', method: 'window/showMessage', params: 'junk' })
    t.children[0]!.serve({ jsonrpc: '2.0', method: '$/progress', params: {} })
    t.children[0]!.stderr.write('stderr text')
    await settle()
    const debug = t.logs.filter((l) => l.level === 'debug').map((l) => l.message)
    expect(debug).toContain('fake: indexing')
    expect(debug).toContain('fake: ')
    expect(debug).toContain('fake stderr')
  })
})

describe('server requests', () => {
  const request = (child: FakeChild, id: number, method: string, params: unknown) =>
    child.serve({ jsonrpc: '2.0', id, method, params })

  it('acknowledges registrations and answers configuration and folders', async () => {
    const t = rig()
    await t.manager.openDocument(openArgs())
    const child = t.children[0]!
    request(child, 100, 'workspace/configuration', { items: [{}, {}] })
    request(child, 101, 'workspace/workspaceFolders', null)
    request(child, 102, 'workspace/applyEdit', {})
    await settle()
    const reply = (id: number) => child.sent.find((m) => m.id === id)
    expect(reply(100)).toMatchObject({ result: [null, null] })
    expect(reply(101)).toMatchObject({ result: [{ uri: pathToFileURL(root).toString() }] })
    expect(reply(102)).toMatchObject({ error: { code: JsonRpcErrorCodes.MethodNotFound } })
  })

  it('watches the root for servers that register didChangeWatchedFiles, until unregistered', async () => {
    const t = rig()
    mkdirSync(root, { recursive: true })
    await t.manager.openDocument(openArgs())
    const child = t.children[0]!
    const before = activeTreeWatchers()
    request(child, 200, 'client/registerCapability', {
      registrations: [
        {
          id: 'w1',
          method: 'workspace/didChangeWatchedFiles',
          registerOptions: { watchers: [{ globPattern: '**/*.ts' }] }
        },
        { id: 'ignored', method: 'textDocument/didSave', registerOptions: {} },
        { method: 'workspace/didChangeWatchedFiles' },
        null
      ]
    })
    request(child, 201, 'client/registerCapability', { registrations: 'junk' })
    request(child, 202, 'client/registerCapability', null)
    await settle()
    // every registration request is acknowledged, valid or not
    expect(child.sent.filter((m) => m.id !== undefined && 'result' in m)).toHaveLength(3)
    // only the valid didChangeWatchedFiles registration started a watch
    expect(activeTreeWatchers()).toBe(before + 1)
    request(child, 203, 'client/unregisterCapability', {
      unregisterations: [{ id: 'w1' }, { id: 5 }, null]
    })
    request(child, 204, 'client/unregisterCapability', null)
    await settle()
    expect(activeTreeWatchers()).toBe(before)
  })
})

describe('pids and shutdown', () => {
  it('lists live server pids, including servers that are shutting down', async () => {
    const t = rig()
    await t.manager.openDocument(openArgs())
    expect(t.manager.pids()).toEqual([4242])
    t.children[0]!.dieOn = new Set()
    t.state.script = (child, message) => {
      // a server that takes its time: answers shutdown but never exits
      if (message.method === 'shutdown') {
        child.serve({ jsonrpc: '2.0', id: message.id, result: null })
        return true
      }
      return message.method === 'exit'
    }
    vi.useFakeTimers()
    const closing = t.manager.closeAll()
    await tick()
    expect(t.manager.status()).toEqual([])
    expect(t.manager.pids()).toEqual([4242]) // still running while being stopped
    await vi.advanceTimersByTimeAsync(10_000)
    await closing
  })

  it('drops pids of servers that exited', async () => {
    const t = rig()
    await t.manager.openDocument(openArgs())
    t.children[0]!.exit(0)
    await settle()
    expect(t.manager.pids()).toEqual([])
  })

  it('closeAll stops every session gracefully and is repeatable', async () => {
    const t = rig()
    await t.manager.openDocument(openArgs())
    await t.manager.openDocument(
      openArgs({
        rootPath: otherRoot,
        serverUri: uri(otherRoot, 'b.ts'),
        clientUri: uri(otherRoot, 'b.ts')
      })
    )
    await t.manager.closeAll()
    await t.manager.closeAll()
    for (const child of t.children) {
      expect(methods(child)).toContain('shutdown')
      expect(methods(child)).toContain('exit')
    }
    expect(t.manager.status()).toEqual([])
    expect(t.manager.pids()).toEqual([])
  })
})
