import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPackageWithOptions } from '@electron/asar'
import { MONACO_GLOBAL_API_ANCHOR } from '../src/constants'
import type { CommandRunner, CommonOptions } from '../src/context'
import { silentLogger } from '../src/context'

export const ORIGINAL_INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Orca</title>
    <script type="module" crossorigin src="./assets/index-abc.js"></script>
    <link rel="modulepreload" crossorigin href="./assets/MonacoEditor-def.js">
    <link rel="stylesheet" crossorigin href="./assets/index-abc.css">
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`

export const NATIVE_BYTES = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3, 4, 5])

function write(file: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

export type FakeOrca = {
  root: string
  appDir: string
  asarPath: string
  stateDir: string
  injectorPath: string
  pluginSource: string
  options: CommonOptions & { injectorPath: string; pluginSource: string }
}

export type FakeOrcaOptions = {
  version?: string
  /** false: the renderer lacks the Monaco globalAPI anchor (an unsupported Orca build). */
  anchor?: boolean
  /** package.json name (default `orca`). */
  name?: string
}

/** Build the app tree for one Orca version and pack it to `<appDir>/resources/app.asar`. */
export async function packFakeOrca(
  root: string,
  appDir: string,
  opts: FakeOrcaOptions = {}
): Promise<string> {
  const src = fs.mkdtempSync(path.join(root, 'src-'))
  write(
    path.join(src, 'package.json'),
    JSON.stringify({
      name: opts.name ?? 'orca',
      version: opts.version ?? '1.4.214',
      main: 'out/main/index.js'
    })
  )
  write(path.join(src, 'out/main/index.js'), 'console.log("main")\n')
  write(path.join(src, 'out/renderer/index.html'), ORIGINAL_INDEX_HTML)
  write(path.join(src, 'out/renderer/assets/index-abc.js'), 'import("./MonacoEditor-def.js")\n')
  write(path.join(src, 'out/renderer/assets/index-abc.css'), 'body{margin:0}\n')
  write(
    path.join(src, 'out/renderer/assets/MonacoEditor-def.js'),
    opts.anchor === false
      ? 'export const x=1;globalThis.monaco=x;\n'
      : `var a=1;globalThis.${MONACO_GLOBAL_API_ANCHOR}Hi());export{a};\n`
  )
  write(path.join(src, 'node_modules/x/package.json'), '{"name":"x","main":"x.node"}')
  write(path.join(src, 'node_modules/x/x.node'), NATIVE_BYTES)
  const asarPath = path.join(appDir, 'resources', 'app.asar')
  fs.rmSync(`${asarPath}.unpacked`, { recursive: true, force: true })
  await createPackageWithOptions(src, asarPath, { unpack: '*.node' })
  fs.rmSync(src, { recursive: true, force: true })
  return asarPath
}

export const noProcesses: CommandRunner = async () => ({ code: 0, stdout: '', stderr: '' })

export async function makeFakeOrca(opts: FakeOrcaOptions = {}): Promise<FakeOrca> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mlp-fake-orca-'))
  const appDir = path.join(root, 'Orca')
  const asarPath = await packFakeOrca(root, appDir, opts)
  write(path.join(appDir, 'orca-ide'), '#!/bin/sh\n')

  const injectorPath = path.join(root, 'injector.js')
  write(injectorPath, '/*! @mlp/orca-injector v9.9.9 */\n;(()=>{globalThis.__mlpTest=1})()\n')
  const pluginSource = path.join(root, 'plugin-src', 'cpoepke.monaco-lsp')
  write(
    path.join(pluginSource, 'orca-plugin.json'),
    JSON.stringify({
      id: 'monaco-lsp',
      publisher: 'cpoepke',
      version: '0.2.0',
      main: 'dist/main.js'
    })
  )
  write(path.join(pluginSource, 'dist/main.js'), 'export default function activate() {}\n')
  const stateDir = path.join(root, 'home', '.monaco-lsp-orca')
  return {
    root,
    appDir,
    asarPath,
    stateDir,
    injectorPath,
    pluginSource,
    options: {
      app: appDir,
      platform: 'linux',
      env: {},
      homeDir: path.join(root, 'home'),
      stateDir,
      logger: silentLogger,
      runCommand: noProcesses,
      injectorPath,
      pluginSource
    }
  }
}
