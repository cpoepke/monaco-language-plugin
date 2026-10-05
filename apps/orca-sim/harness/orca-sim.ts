/**
 * The Node half of the simulated Orca: a temp userData dir, the runtime RPC server, the plugin
 * installed the way Orca installs plugins, a plugin host that forks the real `dist/main.mjs` with
 * Orca's scrubbed env, and a Playwright page standing in for the BrowserWindow (preload API via an
 * init script, `loadFile` of the patched index.html).
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Browser, BrowserContext, Page } from '@playwright/test'
import {
  FIXTURES_DIR,
  INSTALLED_PLUGIN_DIR,
  LSP_BRIDGE_BIN,
  PATCHED_INDEX,
  PLUGIN_KEY
} from './paths.ts'
import { SimPluginHost } from './plugin-host.ts'
import { FakeOrcaRuntime, type OpenFileNotification } from './runtime-server.ts'

export type InvokeRecord = {
  commandId: string
  args: unknown
  at: number
  ok?: boolean
  error?: string
  result?: unknown
}

/** Deterministic content hash of a plugin folder (Orca stores installs under one). */
function contentHash(dir: string): string {
  const hash = createHash('sha256')
  const walk = (current: string): void => {
    for (const entry of fs
      .readdirSync(current, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(current, entry.name)
      if (entry.isDirectory()) walk(abs)
      else {
        hash.update(path.relative(dir, abs).split(path.sep).join('/'))
        hash.update(fs.readFileSync(abs))
      }
    }
  }
  walk(dir)
  return hash.digest('hex').slice(0, 16)
}

/**
 * PATH of an Orca main process started from a desktop entry/Dock: system dirs only. We add the
 * directory of `node` (Node-based servers need it via their shebang) and of the
 * typescript-language-server devDependency, standing in for a global npm install. Everything else
 * (~/.local/bin, ~/go/bin, ~/.cargo/bin, …) must be found by the plugin's PATH extension.
 * ORCA_SIM_EXTRA_PATH adds more (CI puts setup-go's toolchain there).
 */
export function desktopLaunchPath(): string {
  const parts = [
    path.dirname(process.execPath),
    LSP_BRIDGE_BIN,
    ...(process.env.ORCA_SIM_EXTRA_PATH ?? '').split(path.delimiter),
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin'
  ]
  return [...new Set(parts.filter((p) => p.length > 0))].join(path.delimiter)
}

export type OrcaSimOptions = {
  fixtures?: string[]
  /** Log page console messages and plugin logs to stdout. */
  verbose?: boolean
  /** Turn on the injector's debug log (localStorage mlp.debug). */
  injectorDebug?: boolean
  /** Renderer to load (default: the patched build, dist/patched). */
  indexHtml?: string
  /** Test hooks for the worker env, see SimPluginHost `workerEnvExtra`. */
  workerEnvExtra?: Record<string, string>
}

export class OrcaSim {
  readonly userData: string
  readonly pluginRoot: string
  readonly runtime: FakeOrcaRuntime
  readonly pluginHost: SimPluginHost
  readonly invokes: InvokeRecord[] = []
  readonly openNotifications: OpenFileNotification[] = []
  readonly pageErrors: string[] = []
  /** Stacks of the page errors, for diagnostics. */
  readonly pageErrorStacks: string[] = []
  readonly consoleLines: string[] = []
  context!: BrowserContext
  page!: Page

  private constructor(private readonly options: OrcaSimOptions) {
    // Why os.tmpdir(): unix socket paths are limited to ~104 bytes.
    this.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-sim-'))
    // Orca copies an installed plugin folder to <userData>/plugins/<pluginKey>/<contentHash>/.
    this.pluginRoot = path.join(
      this.userData,
      'plugins',
      PLUGIN_KEY,
      contentHash(INSTALLED_PLUGIN_DIR)
    )
    fs.cpSync(INSTALLED_PLUGIN_DIR, this.pluginRoot, { recursive: true })
    const fixtures = options.fixtures ?? ['ts', 'py', 'go', 'rust']
    // Explicit fixture trust is isolated from the developer's real trust store.
    const trustState = options.workerEnvExtra?.MONACO_LSP_ORCA_HOME ?? this.userData
    fs.mkdirSync(trustState, { recursive: true })
    fs.writeFileSync(
      path.join(trustState, 'trusted-workspaces.json'),
      JSON.stringify(fixtures.map((name) => fs.realpathSync(path.join(FIXTURES_DIR, name))))
    )
    this.runtime = new FakeOrcaRuntime({
      userData: this.userData,
      worktreeRoots: fixtures.map((name) => path.join(FIXTURES_DIR, name)),
      onOpenFile: (notification) => this.deliverOpenFile(notification)
    })
    this.pluginHost = new SimPluginHost({
      pluginKey: PLUGIN_KEY,
      rootDir: this.pluginRoot,
      // The user consented to everything the manifest asks for ("Review & enable").
      grantedCapabilities:
        (
          JSON.parse(
            fs.readFileSync(path.join(INSTALLED_PLUGIN_DIR, 'orca-plugin.json'), 'utf8')
          ) as {
            capabilities?: { kind: string }[]
          }
        ).capabilities?.map((c) => c.kind) ?? [],
      mainEnv: {
        PATH: desktopLaunchPath(),
        HOME: os.homedir(),
        LANG: process.env.LANG ?? 'en_US.UTF-8',
        TMPDIR: os.tmpdir(),
        // Stripped by Orca's allowlist; the plugin must not depend on them.
        XDG_CONFIG_HOME: path.join(this.userData, 'not-xdg'),
        ORCA_USER_DATA_PATH: path.join(this.userData, 'not-user-data'),
        MLP_ORCA_USER_DATA: path.join(this.userData, 'not-user-data'),
        SECRET_TOKEN: 'must-not-leak'
      },
      workerEnvExtra: { MONACO_LSP_ORCA_HOME: trustState, ...options.workerEnvExtra },
      log: options.verbose ? (level, line) => console.log(`[plugin ${level}] ${line}`) : undefined
    })
  }

  static async launch(browser: Browser, options: OrcaSimOptions = {}): Promise<OrcaSim> {
    const indexHtml = options.indexHtml ?? PATCHED_INDEX
    if (!fs.existsSync(indexHtml)) {
      throw new Error(`${indexHtml} is missing: run \`pnpm --filter orca-sim build\` first`)
    }
    const sim = new OrcaSim(options)
    await sim.runtime.start()
    sim.context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    sim.page = await sim.context.newPage()
    await sim.installPreload()
    await sim.loadRenderer(indexHtml)
    return sim
  }

  /** Orca: mainWindow.loadFile(join(__dirname, '../renderer/index.html')). Also used to simulate
   *  a restart onto a re-patched app.asar (the preload init scripts run again). */
  async loadRenderer(indexHtml: string): Promise<void> {
    await this.page.goto(pathToFileURL(indexHtml).href)
    await this.page.waitForFunction(() => document.body.dataset.simReady === 'true')
  }

  private async installPreload(): Promise<void> {
    const page = this.page
    page.on('pageerror', (error) => {
      this.pageErrors.push(error.message)
      this.pageErrorStacks.push(error.stack ?? error.message)
    })
    page.on('console', (message) => {
      const line = `[${message.type()}] ${message.text()}`
      this.consoleLines.push(line)
      if (this.options.verbose) console.log(`[page] ${line}`)
    })
    await page.exposeFunction(
      '__orcaSimMain_invokeCommand',
      async (args: { pluginKey?: unknown; commandId?: unknown; args?: unknown }) => {
        const record: InvokeRecord = {
          commandId: String(args?.commandId),
          args: args?.args,
          at: Date.now()
        }
        this.invokes.push(record)
        try {
          if (args?.pluginKey !== PLUGIN_KEY) {
            throw new Error(`plugin ${String(args?.pluginKey)} is not enabled`)
          }
          const result = await this.pluginHost.invokeCommand(String(args.commandId), args.args)
          record.ok = true
          record.result = result
          return { ok: true, value: result }
        } catch (error) {
          record.ok = false
          record.error = error instanceof Error ? error.message : String(error)
          return { ok: false, error: record.error }
        }
      }
    )
    await page.exposeFunction('__orcaSimMain_readFile', (filePath: string) =>
      fs.readFileSync(filePath, 'utf8')
    )
    if (this.options.injectorDebug || process.env.ORCA_SIM_INJECTOR_DEBUG === '1') {
      await page.addInitScript(() => {
        try {
          localStorage.setItem('mlp.debug', '1')
        } catch {
          // file:// storage unavailable
        }
      })
    }
    // The preload: contextBridge.exposeInMainWorld('api', {...}) before any page script.
    await page.addInitScript(() => {
      const w = window as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
      const api = {
        plugins: Object.freeze({
          // ipcRenderer.invoke('plugins:invokeCommand', args): a main-side throw rejects with
          // "Error invoking remote method '<channel>': Error: <message>".
          invokeCommand: async (args: unknown): Promise<unknown> => {
            const outcome = (await w.__orcaSimMain_invokeCommand!(args)) as
              { ok: true; value: unknown } | { ok: false; error: string }
            if (outcome.ok) return outcome.value
            throw new Error(
              `Error invoking remote method 'plugins:invokeCommand': Error: ${outcome.error}`
            )
          }
        }),
        fs: Object.freeze({
          readFile: (filePath: string): Promise<string> =>
            w.__orcaSimMain_readFile!(filePath) as Promise<string>
        })
      }
      Object.defineProperty(window, 'api', {
        value: Object.freeze(api),
        enumerable: true,
        configurable: false,
        writable: false
      })
    })
  }

  /** runtime `files.open` → notifier.openFile → IPC `ui:openFileFromMobile` → store.openFile. */
  private deliverOpenFile(notification: OpenFileNotification): void {
    this.openNotifications.push(notification)
    this.page
      .evaluate(
        (n) =>
          (
            window as unknown as {
              __sim: {
                openFile(p: string, o: { relativePath: string; worktreeId: string }): void
              }
            }
          ).__sim.openFile(n.filePath, { relativePath: n.relativePath, worktreeId: n.worktreeId }),
        notification
      )
      .catch(() => {})
  }

  async close(): Promise<void> {
    await this.context?.close().catch(() => {})
    await this.pluginHost.dispose().catch(() => {})
    await this.runtime.stop().catch(() => {})
    fs.rmSync(this.userData, { recursive: true, force: true })
  }
}
