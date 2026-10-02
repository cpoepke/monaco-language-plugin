import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/cli.ts', 'src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  sourcemap: false,
  clean: true,
  dts: false,
  external: ['@electron/asar']
})
