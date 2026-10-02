import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'lsp-bridge',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 30_000
  }
})
