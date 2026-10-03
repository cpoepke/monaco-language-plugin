import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url))

/**
 * Orca's renderer build (electron.vite.config.ts `renderer` + electron-vite 5 defaults) with
 * `vite: npm:rolldown-vite@7.3.1`: root src/renderer, base './', out/renderer, oxc minify,
 * es2020, ES workers, modulepreload polyfill, manifest, strict entry signatures. The output goes to
 * dist/app/out/renderer so dist/app has the same layout as the inside of Orca's app.asar.
 */
export default defineConfig({
  root: here('./renderer'),
  base: './',
  mode: 'production',
  plugins: [react()],
  worker: { format: 'es' },
  logLevel: 'warn',
  build: {
    outDir: here('./dist/app/out/renderer'),
    emptyOutDir: true,
    manifest: true,
    modulePreload: { polyfill: true },
    minify: 'oxc',
    target: 'es2020',
    chunkSizeWarningLimit: 20_000,
    rollupOptions: {
      preserveEntrySignatures: 'strict',
      input: { index: here('./renderer/index.html') }
    }
  }
})
