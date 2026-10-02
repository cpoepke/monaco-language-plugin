import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'orca-injector',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: ['test/e2e/**']
  }
})
