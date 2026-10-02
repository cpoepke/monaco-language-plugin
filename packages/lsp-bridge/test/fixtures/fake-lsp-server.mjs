#!/usr/bin/env node
// Deterministic stand-in for a language server, driven over stdio with LSP
// framing. Used to test the bridge's session lifecycle without real servers.
//
// Flags:
//   --pull               advertise diagnosticProvider (pull diagnostics)
//   --ignore-shutdown    never answer `shutdown`, ignore `exit` and SIGTERM
//   --spawn-grandchild   start a long-lived child process (process-group test)
//
// Behaviour:
//   didOpen/didChange    publish one diagnostic describing the event
//   text "CRASH"         exit(3) on didOpen/didChange containing it
//   definition           Location at 0:0 in the same document
//   hover                markdown whose value is JSON of the server's state
//   references           never answered (timeout tests)
//   documentSymbol       answered with an error (error forwarding tests)
import { spawn } from 'node:child_process'

const flags = new Set(process.argv.slice(2))
const state = {
  pid: process.pid,
  grandchildPid: null,
  initializeParams: null,
  serverRequestReplies: {},
  open: {},
  events: [],
  cancelled: []
}

if (flags.has('--ignore-shutdown')) {
  process.on('SIGTERM', () => state.events.push('SIGTERM ignored'))
}
if (flags.has('--spawn-grandchild')) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  state.grandchildPid = child.pid
}

function write(message) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }), 'utf8')
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`)
  process.stdout.write(body)
}

let nextServerRequestId = 1000
const serverRequests = new Map()
function serverRequest(method, params) {
  const id = nextServerRequestId++
  serverRequests.set(id, method)
  write({ id, method, params })
}

function publish(uri, message) {
  write({
    method: 'textDocument/publishDiagnostics',
    params: {
      uri,
      diagnostics: [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
          severity: 1,
          source: 'fake',
          message
        }
      ]
    }
  })
}

function handle(message) {
  const { id, method, params } = message
  if (method === undefined) {
    const pendingMethod = serverRequests.get(id)
    if (pendingMethod) {
      serverRequests.delete(id)
      state.serverRequestReplies[pendingMethod] = message.error
        ? { error: message.error }
        : { result: message.result }
    }
    return
  }
  state.events.push(method)
  switch (method) {
    case 'initialize':
      state.initializeParams = params
      write({
        id,
        result: {
          capabilities: {
            textDocumentSync: 1,
            definitionProvider: true,
            hoverProvider: true,
            referencesProvider: true,
            documentSymbolProvider: true,
            ...(flags.has('--pull')
              ? { diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false } }
              : {})
          },
          serverInfo: { name: 'fake-lsp-server' }
        }
      })
      return
    case 'initialized':
      serverRequest('workspace/configuration', { items: [{ section: 'a' }, { section: 'b' }] })
      serverRequest('workspace/workspaceFolders', null)
      serverRequest('client/registerCapability', { registrations: [] })
      serverRequest('custom/unknownRequest', {})
      return
    case 'textDocument/didOpen': {
      const doc = params.textDocument
      state.open[doc.uri] = { version: doc.version, languageId: doc.languageId, text: doc.text }
      if (doc.text.includes('CRASH')) {
        process.stderr.write('fake server: crashing on purpose\n')
        process.exit(3)
      }
      publish(doc.uri, `open v${doc.version}`)
      return
    }
    case 'textDocument/didChange': {
      const doc = params.textDocument
      const text = params.contentChanges[0].text
      state.open[doc.uri] = { ...state.open[doc.uri], version: doc.version, text }
      if (text.includes('CRASH')) {
        process.stderr.write('fake server: crashing on purpose\n')
        process.exit(3)
      }
      publish(doc.uri, `change v${doc.version}`)
      return
    }
    case 'textDocument/didClose':
      delete state.open[params.textDocument.uri]
      // Why: real servers clear markers on close; the bridge must not forward
      // these because no client has the document open any more.
      write({ method: 'textDocument/publishDiagnostics', params: { uri: params.textDocument.uri, diagnostics: [] } })
      return
    case 'textDocument/definition':
      write({
        id,
        result: [
          {
            uri: params.textDocument.uri,
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }
          }
        ]
      })
      return
    case 'textDocument/hover':
      write({
        id,
        result: { contents: { kind: 'markdown', value: JSON.stringify(state) } }
      })
      return
    case 'textDocument/references':
      return
    case 'textDocument/documentSymbol':
      write({ id, error: { code: -32803, message: 'fake failure', data: { why: 'test' } } })
      return
    case '$/cancelRequest':
      state.cancelled.push(params.id)
      return
    case 'shutdown':
      if (!flags.has('--ignore-shutdown')) {
        write({ id, result: null })
      }
      return
    case 'exit':
      if (!flags.has('--ignore-shutdown')) {
        process.exit(0)
      }
      return
    default:
      if (id !== undefined) {
        write({ id, error: { code: -32601, message: `fake: unhandled ${method}` } })
      }
  }
}

let buffer = Buffer.alloc(0)
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n')
    if (headerEnd === -1) return
    const match = /Content-Length: (\d+)/i.exec(buffer.subarray(0, headerEnd).toString('ascii'))
    const length = Number(match[1])
    if (buffer.length < headerEnd + 4 + length) return
    const body = buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString('utf8')
    buffer = buffer.subarray(headerEnd + 4 + length)
    handle(JSON.parse(body))
  }
})
// Why: like real servers, exit when the client's pipe closes.
process.stdin.on('end', () => {
  if (!flags.has('--ignore-shutdown')) process.exit(0)
})
