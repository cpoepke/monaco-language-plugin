import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { defineConfig, devices } from '@playwright/test'

const PORT = Number(process.env.DEMO_PORT ?? 5179)
const PREINSTALLED = '/opt/pw-browsers'

// Why: CI images here ship browsers in /opt/pw-browsers; never download at test time.
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync(PREINSTALLED)) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = PREINSTALLED
}

/** Explicit Chromium binary when the installed revision differs from @playwright/test's. */
function chromiumExecutable(): string | undefined {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) {
    return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
  }
  const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH
  if (!browsers || !existsSync(browsers)) {
    return undefined
  }
  const revisions = readdirSync(browsers)
    .filter((name) => /^chromium-\d+$/.test(name))
    .sort()
  const expected = join(browsers, 'chromium-1194') // @playwright/test 1.56.x
  if (revisions.length === 0 || existsSync(expected)) {
    return undefined
  }
  const binary = join(browsers, revisions.at(-1)!, 'chrome-linux', 'chrome')
  return existsSync(binary) ? binary : undefined
}

export default defineConfig({
  testDir: './e2e',
  timeout: 240_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? 'list' : [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    viewport: { width: 1280, height: 800 }
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: { executablePath: chromiumExecutable() }
      }
    }
  ],
  webServer: {
    command: `pnpm exec vite --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}/api/projects`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe'
  }
})
