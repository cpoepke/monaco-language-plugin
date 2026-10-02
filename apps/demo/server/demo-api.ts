/**
 * Dev/preview-server middleware for the demo:
 *   GET /api/projects          fixture projects and their entry files
 *   GET /api/files?root=       files of one project (paths under fixtures/ only)
 *   GET /api/file?path=        contents of one file (absolute path under fixtures/ only)
 *   GET /api/bridge            { url } of the language-server bridge, or why there is none
 *
 * The bridge (`packages/lsp-bridge/dist/cli.js`) is spawned once per server with
 * `--root fixtures` and a random token. Set MLP_BRIDGE_URL to use a bridge that is
 * already running instead, or MLP_BRIDGE_CLI to spawn a different bridge build.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createServer } from 'node:net'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import type { Plugin, PreviewServer, ViteDevServer } from 'vite'

const here = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = resolve(here, '../../..')
export const FIXTURES_DIR = join(REPO_ROOT, 'fixtures')
export const BRIDGE_CLI = process.env.MLP_BRIDGE_CLI
  ? resolve(process.env.MLP_BRIDGE_CLI)
  : join(REPO_ROOT, 'packages/lsp-bridge/dist/cli.js')

/** Entry file per fixture project (see fixtures/README.md). */
const ENTRIES: Record<string, string> = {
  ts: 'src/app.ts',
  py: 'app/main.py',
  go: 'main.go',
  rust: 'src/main.rs'
}
const SKIP_DIRS = new Set(['node_modules', 'target', '.git', '__pycache__', 'dist', '.venv'])

export type BridgeInfo =
  { status: 'ready'; url: string } | { status: 'missing' | 'failed'; url: null; message: string }

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

/** Resolves `input` (absolute, or relative to the repo root) to a real path inside fixtures/. */
async function insideFixtures(input: string): Promise<string | null> {
  const fixtures = await realpath(FIXTURES_DIR)
  let real: string
  try {
    real = await realpath(resolve(REPO_ROOT, input))
  } catch {
    return null
  }
  return real === fixtures || real.startsWith(fixtures + sep) ? real : null
}

async function listFiles(dir: string, base: string, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) {
      continue
    }
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      await listFiles(full, base, out)
    } else if (entry.isFile()) {
      out.push(relative(base, full).split(sep).join('/'))
    }
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolvePort(port))
    })
  })
}

function startBridge(log: (message: string) => void): {
  info: Promise<BridgeInfo>
  stop: () => void
} {
  const external = process.env.MLP_BRIDGE_URL
  if (external) {
    return { info: Promise.resolve({ status: 'ready', url: external }), stop: () => {} }
  }
  if (!existsSync(BRIDGE_CLI)) {
    return {
      info: Promise.resolve({
        status: 'missing',
        url: null,
        message: 'bridge not built: run `pnpm --filter @mlp/lsp-bridge build` and reload'
      }),
      stop: () => {}
    }
  }
  let child: ChildProcess | null = null
  const info = (async (): Promise<BridgeInfo> => {
    const port = await freePort()
    const token = randomBytes(16).toString('hex')
    child = spawn(
      process.execPath,
      [BRIDGE_CLI, '--port', String(port), '--token', token, '--root', FIXTURES_DIR],
      { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    child.stderr?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n').filter(Boolean)) {
        log(`[bridge] ${line}`)
      }
    })
    const spawned = child
    return new Promise<BridgeInfo>((resolveInfo) => {
      const fail = (message: string) => resolveInfo({ status: 'failed', url: null, message })
      const timer = setTimeout(() => fail('bridge did not report its URL within 20 s'), 20_000)
      spawned.once('exit', (code) => {
        clearTimeout(timer)
        fail(`bridge exited with code ${String(code)}`)
      })
      spawned.once('error', (error) => {
        clearTimeout(timer)
        fail(`cannot start bridge: ${error.message}`)
      })
      const lines = createInterface({ input: spawned.stdout! })
      lines.on('line', (line) => {
        try {
          const parsed = JSON.parse(line) as { url?: string }
          if (typeof parsed.url === 'string') {
            clearTimeout(timer)
            log(`[bridge] listening on ${parsed.url.replace(/token=[^&]+/, 'token=…')}`)
            resolveInfo({ status: 'ready', url: parsed.url })
            return
          }
        } catch {
          // not the URL line
        }
        log(`[bridge] ${line}`)
      })
    })
  })()
  const stop = () => {
    if (child && child.exitCode === null) {
      child.kill()
    }
  }
  process.once('exit', stop)
  return { info, stop }
}

function createHandler(bridge: Promise<BridgeInfo>) {
  return async (req: IncomingMessage, res: ServerResponse, next: () => void): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (!url.pathname.startsWith('/api/')) {
      next()
      return
    }
    try {
      switch (url.pathname) {
        case '/api/bridge':
          json(res, 200, await bridge)
          return
        case '/api/projects': {
          const projects = []
          for (const [name, entry] of Object.entries(ENTRIES)) {
            if (existsSync(join(FIXTURES_DIR, name, entry))) {
              projects.push({ name, root: `fixtures/${name}`, entry })
            }
          }
          json(res, 200, { projects })
          return
        }
        case '/api/files': {
          const root = await insideFixtures(url.searchParams.get('root') ?? '')
          if (!root || !(await stat(root)).isDirectory()) {
            json(res, 404, { error: 'unknown project root' })
            return
          }
          const files: string[] = []
          await listFiles(root, root, files)
          json(res, 200, {
            root: relative(REPO_ROOT, root).split(sep).join('/'),
            rootPath: root,
            files
          })
          return
        }
        case '/api/file': {
          const path = await insideFixtures(url.searchParams.get('path') ?? '')
          if (!path || !(await stat(path)).isFile()) {
            json(res, 404, { error: 'file not found or outside fixtures/' })
            return
          }
          res.statusCode = 200
          res.setHeader('content-type', 'text/plain; charset=utf-8')
          res.setHeader('cache-control', 'no-store')
          res.end(await readFile(path, 'utf8'))
          return
        }
        default:
          json(res, 404, { error: 'unknown endpoint' })
      }
    } catch (error) {
      json(res, 500, { error: error instanceof Error ? error.message : String(error) })
    }
  }
}

export function demoApi(): Plugin {
  let bridge: ReturnType<typeof startBridge> | null = null
  const attach = (server: ViteDevServer | PreviewServer) => {
    bridge ??= startBridge((message) => server.config.logger.info(message))
    const handler = createHandler(bridge.info)
    server.middlewares.use((req, res, next) => void handler(req, res, next))
    server.httpServer?.once('close', () => bridge?.stop())
  }
  return {
    name: 'mlp-demo-api',
    configureServer: attach,
    configurePreviewServer: attach
  }
}
