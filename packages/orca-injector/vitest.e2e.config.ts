import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'orca-injector-e2e',
    environment: 'node',
    include: ['test/e2e/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 180_000
  }
})
