// Runs inside a bare `node` child process (no node_modules on the import
// path), the way Orca's plugin-host-entry imports dist/main.mjs, and drives the
// worker through the same calls the renderer injector makes.
import { pathToFileURL } from 'node:url'

const [entry, fileToOpen] = process.argv.slice(2)
const mod = await import(pathToFileURL(entry).href)

const handlers = new Map()
const logs = []
const orca = {
  commands: { register: (id, handler) => handlers.set(id, handler) },
  events: { on() {} },
  host: { call: async () => ({ delivered: true }) },
  grantedCapabilities: [],
  log: (line) => logs.push(line)
}

const started = performance.now()
await mod.default(orca)
const activateMs = performance.now() - started

const info = await handlers.get('mlp.ensureBridge')({ v: 1 })
const again = await handlers.get('mlp.ensureBridge')({ v: 1 })

const ws = new WebSocket(`ws://127.0.0.1:${info.port}/?token=${encodeURIComponent(info.token)}`)
const pending = new Map()
ws.onmessage = (event) => {
  const message = JSON.parse(String(event.data))
  pending.get(message.id)?.(message)
}
let nextId = 1
const request = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, resolve)
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    setTimeout(() => reject(new Error(`${method} timed out`)), 8000)
  })
await new Promise((resolve, reject) => {
  ws.onopen = resolve
  ws.onerror = () => reject(new Error('websocket error'))
})
const hello = await request('bridge/hello', {
  protocolVersion: info.protocolVersion,
  client: 'smoke'
})
const openLocation = await request('host/openLocation', {
  uri: pathToFileURL(fileToOpen).href,
  range: { start: { line: 4, character: 2 }, end: { line: 4, character: 2 } }
})
ws.close()

const status = await handlers.get('mlp.status')({ silent: true })
const stopped = await handlers.get('mlp.stop')()
await mod.deactivate()

process.stdout.write(
  `${JSON.stringify({
    activateMs,
    commands: [...handlers.keys()],
    info,
    sameAgain: again.port === info.port && again.token === info.token,
    hello,
    openLocation,
    statusRunning: status.running,
    stopped,
    logs
  })}\n`
)
process.exit(0)
