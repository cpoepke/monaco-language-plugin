/**
 * Browser smoke test: a production (minified) Vite build of an Orca-like app that lazily imports
 * monaco-editor 0.55 and assigns MonacoEnvironment after the import, loaded over file:// with the
 * built injector inserted as the first <head> child — the same shape the patcher produces.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium, type Browser } from 'playwright-core'
import { build } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgDir = path.resolve(here, '..', '..')
const appDir = path.join(here, 'fixture-app')
const outDir = path.join(here, '.fixture-dist')
const injector = path.join(pkgDir, 'dist', 'injector.js')

function chromiumPath(): string | null {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers'
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
  if (!fs.existsSync(root)) return null
  const dirs = fs
    .readdirSync(root)
    .filter((d) => /^chromium-\d+$/.test(d))
    .sort()
  for (const dir of dirs.reverse()) {
    const bin = path.join(root, dir, 'chrome-linux', 'chrome')
    if (fs.existsSync(bin)) return bin
  }
  return null
}

const executablePath = chromiumPath()

describe.skipIf(!executablePath)('injector in a built Orca-like app (file://)', () => {
  let browser: Browser

  beforeAll(async () => {
    if (!fs.existsSync(injector)) throw new Error(`build the injector first: ${injector}`)
    await build({
      root: appDir,
      base: './',
      logLevel: 'warn',
      configFile: false,
      worker: { format: 'es' },
      build: {
        outDir,
        emptyOutDir: true,
        minify: true,
        target: 'es2020',
        chunkSizeWarningLimit: 10_000,
        modulePreload: { polyfill: true }
      }
    })
    fs.mkdirSync(path.join(outDir, 'mlp'), { recursive: true })
    fs.copyFileSync(injector, path.join(outDir, 'mlp', 'injector.js'))
    const indexPath = path.join(outDir, 'index.html')
    const html = fs.readFileSync(indexPath, 'utf8')
    fs.writeFileSync(
      indexPath,
      html.replace(
        /<head>/i,
        '<head>\n    <!-- mlp:begin --><script src="./mlp/injector.js"></script><!-- mlp:end -->'
      )
    )
    browser = await chromium.launch({
      executablePath: executablePath!,
      args: ['--allow-file-access-from-files']
    })
  })

  afterAll(async () => {
    await browser?.close()
  })

  it('captures Monaco, keeps getWorker and wakes the plugin', async () => {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.addInitScript(() => {
      const w = window as unknown as Record<string, unknown>
      const calls: unknown[] = []
      w.__invokeCalls = calls
      // Fake Orca preload API; port 9 refuses connections, which the client must tolerate.
      w.api = {
        plugins: {
          invokeCommand: async (args: unknown) => {
            calls.push(args)
            return {
              port: 9,
              token: 'test-token',
              protocolVersion: 1,
              pluginVersion: '0.0.0-test',
              hostNavigation: true
            }
          }
        }
      }
    })
    await page.goto(pathToFileURL(path.join(outDir, 'index.html')).href)
    await page.waitForFunction(
      () => (window as unknown as { __editorMounted?: boolean }).__editorMounted === true
    )
    await page.waitForFunction(
      () => ((window as unknown as { __invokeCalls: unknown[] }).__invokeCalls?.length ?? 0) > 0
    )
    const result = await page.evaluate(() => {
      const w = window as unknown as Record<string, any>
      const status = w.__mlp.status()
      const ts = w.monaco?.languages?.typescript ?? w.__bundleMonaco?.typescript
      return {
        status,
        sameMonaco: w.__mlp.monaco?.editor === w.__bundleMonaco?.editor,
        getWorker: typeof w.MonacoEnvironment?.getWorker,
        globalAPI: w.MonacoEnvironment?.globalAPI,
        call: w.__invokeCalls[0],
        builtinDefinitions: ts?.typescriptDefaults?.modeConfiguration?.definitions,
        editors: w.monaco?.editor?.getEditors().length,
        notices: document.querySelectorAll('[data-mlp-notice]').length
      }
    })
    expect(result.status.monacoCaptured).toBe(true)
    expect(result.status.client.created).toBe(true)
    expect(result.status.bridge.state).toBe('available')
    expect(result.sameMonaco).toBe(true)
    expect(result.getWorker).toBe('function')
    expect(result.globalAPI).toBe(true)
    expect(result.call).toEqual({
      pluginKey: 'cpoepke.monaco-lsp',
      commandId: 'mlp.ensureBridge',
      args: { v: 1 }
    })
    expect(result.builtinDefinitions).toBe(false)
    expect(result.editors).toBe(1)
    expect(result.notices).toBe(0)
    expect(errors).toEqual([])
    await page.close()
  })

  it('shows one setup notice when the plugin API is missing and never breaks the page', async () => {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto(pathToFileURL(path.join(outDir, 'index.html')).href)
    await page.waitForFunction(
      () => (window as unknown as { __editorMounted?: boolean }).__editorMounted === true
    )
    await page.waitForSelector('[data-mlp-notice]')
    const result = await page.evaluate(() => ({
      status: (window as unknown as Record<string, any>).__mlp.status(),
      notices: document.querySelectorAll('[data-mlp-notice]').length
    }))
    expect(result.status.monacoCaptured).toBe(true)
    expect(result.status.bridge.error.kind).toBe('api-missing')
    expect(result.notices).toBe(1)
    expect(errors).toEqual([])
    await page.close()
  })
})
