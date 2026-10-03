// Produces the folder users install in Orca (Settings → Plugins → Install
// plugin → Local folder) and that the patcher copies:
//   release/cpoepke.monaco-lsp/{orca-plugin.json, dist/main.mjs, dist/apply-pending.mjs,
//                               assets/injector.js, README.md, LICENSE}
// Nothing else goes in: Orca hashes every file in the plugin folder, and
// node_modules must not be needed because the dist/ bundles are self-contained.
// assets/injector.js is the renderer injector the self-repair installs after
// an Orca update (packages/orca-injector must be built first).
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(packageDir, '..', '..')
const manifest = JSON.parse(readFileSync(path.join(packageDir, 'orca-plugin.json'), 'utf8'))
const pluginKey = `${manifest.publisher}.${manifest.id}`
const outDir = path.join(packageDir, 'release', pluginKey)

const files = [
  [path.join(packageDir, 'orca-plugin.json'), 'orca-plugin.json'],
  [path.join(packageDir, manifest.main), manifest.main],
  [path.join(packageDir, 'dist', 'apply-pending.mjs'), 'dist/apply-pending.mjs'],
  [path.join(repoRoot, 'packages', 'orca-injector', 'dist', 'injector.js'), 'assets/injector.js'],
  [path.join(packageDir, 'README.md'), 'README.md'],
  [path.join(repoRoot, 'LICENSE'), 'LICENSE']
]

for (const [source] of files) {
  if (!existsSync(source)) {
    console.error(`pack: missing ${path.relative(packageDir, source)} (run the build first)`)
    process.exit(1)
  }
}

rmSync(outDir, { recursive: true, force: true })
for (const [source, target] of files) {
  const destination = path.join(outDir, ...target.split('/'))
  mkdirSync(path.dirname(destination), { recursive: true })
  copyFileSync(source, destination)
}
console.log(`pack: wrote ${path.relative(process.cwd(), outDir) || outDir}`)
