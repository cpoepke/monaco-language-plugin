import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/cli.ts', 'src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  sourcemap: false,
  clean: true,
  dts: false,
  // Why: the shared patch core is a private workspace package; inline it (the published CLI only
  // depends on @electron/asar).
  noExternal: ['@mlp/orca-patch-core'],
  external: ['@electron/asar']
})
