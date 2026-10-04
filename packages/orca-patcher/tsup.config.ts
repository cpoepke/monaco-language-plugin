import { fileURLToPath } from 'node:url'
import { defineConfig } from 'tsup'

// Why: only the server diagnosis is needed from the bridge; importing its index would drag in the
// WebSocket stack. The module is bundled from source so the build never depends on build order.
const bridgeDiagnose = fileURLToPath(new URL('../lsp-bridge/src/lsp/diagnose.ts', import.meta.url))

export default defineConfig({
  entry: ['src/cli.ts', 'src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  sourcemap: false,
  clean: true,
  dts: false,
  // Why: the shared patch core and the bridge's server catalog/probe are private workspace
  // packages; inline them (the published CLI only depends on @electron/asar).
  noExternal: ['@mlp/orca-patch-core', '@mlp/lsp-bridge'],
  external: ['@electron/asar'],
  esbuildOptions(options) {
    options.alias = { ...options.alias, '@mlp/lsp-bridge': bridgeDiagnose }
  }
})
