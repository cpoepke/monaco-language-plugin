import { fileURLToPath } from 'node:url'
import { defineConfig } from 'tsup'

const bridgeSource = fileURLToPath(new URL('../lsp-bridge/src/index.ts', import.meta.url))

export default defineConfig({
  entry: { main: 'src/main.ts' },
  format: ['esm'],
  outExtension: () => ({ js: '.mjs' }),
  platform: 'node',
  target: 'node22',
  clean: true,
  // Why: Orca installs a plugin by copying its folder; there is no
  // node_modules next to dist/main.mjs, so every dependency (the bridge, the
  // protocol package, ws) must be inlined into this one file.
  noExternal: [/.*/],
  splitting: false,
  sourcemap: false,
  esbuildOptions(options) {
    // Why: bundle the bridge from its TypeScript source instead of its dist so
    // the plugin build never depends on build order, and so we do not
    // re-bundle the bridge's own `const require = …` banner (it would collide
    // with ours).
    options.alias = { ...options.alias, '@mlp/lsp-bridge': bridgeSource }
  },
  banner: {
    // Why: ws is CommonJS; esbuild's ESM output needs a real `require` for the
    // Node built-ins it pulls in (events, http, crypto…).
    js: "import { createRequire as __mlpCreateRequire } from 'node:module'; const require = __mlpCreateRequire(import.meta.url);"
  }
})
