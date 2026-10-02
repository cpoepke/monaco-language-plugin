import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'monaco-lsp-client',
    environment: 'node',
    include: ['test/**/*.test.ts']
  }
})
