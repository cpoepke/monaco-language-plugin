import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      // Why: same source-level import as the tsup bundle, so tests never need a built bridge.
      '@mlp/lsp-bridge': fileURLToPath(
        new URL('../lsp-bridge/src/lsp/diagnose.ts', import.meta.url)
      )
    }
  },
  test: {
    name: 'orca-patcher',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000
  }
})
