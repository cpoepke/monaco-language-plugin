import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'orca-plugin',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    testTimeout: 20_000,
    // Why: the bundle smoke test may have to build dist/main.mjs first.
    hookTimeout: 120_000
  }
})
