import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { index: 'src/index.ts', cli: 'src/cli.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  clean: true,
  sourcemap: true,
  // Why: one self-contained file per entry is simplest to embed elsewhere.
  splitting: false,
  // Why: the bridge is embedded in an Orca plugin that ships without
  // node_modules, so the protocol package and ws must live inside dist/.
  noExternal: ['@mlp/protocol', 'ws'],
  banner: {
    // Why: ws is CommonJS; esbuild's ESM output needs a real `require` for the
    // Node built-ins it pulls in (events, http, crypto…).
    js: "import { createRequire as __mlpCreateRequire } from 'node:module'; const require = __mlpCreateRequire(import.meta.url);"
  }
})
