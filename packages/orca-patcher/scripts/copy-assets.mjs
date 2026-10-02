// Copies the build outputs the patcher installs into `assets/`:
//   assets/injector.js                      ← packages/orca-injector/dist/injector.js (required)
//   assets/plugin/cpoepke.monaco-lsp/       ← packages/orca-plugin/release/cpoepke.monaco-lsp (optional)
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const packagesDir = join(pkgDir, '..')
const assets = join(pkgDir, 'assets')

const injector = join(packagesDir, 'orca-injector', 'dist', 'injector.js')
const plugin = join(packagesDir, 'orca-plugin', 'release', 'cpoepke.monaco-lsp')

rmSync(assets, { recursive: true, force: true })
mkdirSync(assets, { recursive: true })

if (!existsSync(injector)) {
  console.error(`copy-assets: ${injector} is missing; build @mlp/orca-injector first.`)
  process.exit(1)
}
cpSync(injector, join(assets, 'injector.js'))
console.log('copy-assets: injector.js')

if (existsSync(join(plugin, 'orca-plugin.json'))) {
  cpSync(plugin, join(assets, 'plugin', 'cpoepke.monaco-lsp'), { recursive: true })
  console.log('copy-assets: plugin/cpoepke.monaco-lsp')
} else {
  console.warn(
    `copy-assets: WARNING: ${plugin} not found; the patcher will be built without the Orca plugin ` +
      '(build packages/orca-plugin first).'
  )
}
