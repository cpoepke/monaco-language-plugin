import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: ['packages/*'],
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**'],
      exclude: ['**/*.test.ts', '**/*.d.ts'],
      reporter: ['text-summary', 'json-summary', 'html'],
      // Why: a floor a little under today's numbers (98 lines / 94 branches locally). CI's Linux job
      // has fewer language servers installed than a dev machine, so a few integration tests skip
      // there and coverage reads slightly lower; the floor leaves room for that but catches a
      // real drop. Raise it as coverage improves.
      thresholds: { lines: 94, statements: 94, functions: 92, branches: 86 }
    }
  }
})
