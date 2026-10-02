import { readFileSync } from 'node:fs'
import { defineConfig } from 'tsup'

const { version } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8')
) as {
  version: string
}

export default defineConfig({
  entry: { injector: 'src/index.ts' },
  format: ['iife'],
  platform: 'browser',
  target: 'es2022',
  minify: true,
  sourcemap: false,
  clean: true,
  dts: false,
  // Fully self-contained: the client and protocol are inlined; monaco-editor is only used for types.
  noExternal: [/.*/],
  // The patcher reads the version from this banner.
  banner: { js: `/*! @mlp/orca-injector v${version} */` },
  outExtension: () => ({ js: '.js' })
})
