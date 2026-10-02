import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'es2022',
  platform: 'browser',
  dts: { resolve: ['@mlp/protocol'] },
  sourcemap: true,
  clean: true,
  // Why: @mlp/protocol is a private workspace package; consumers get it inlined.
  noExternal: ['@mlp/protocol'],
  external: ['monaco-editor']
})
