import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { defineConfig, devices } from '@playwright/test'

const PREINSTALLED = '/opt/pw-browsers'

// Why: images here ship browsers in /opt/pw-browsers; never download at test time.
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync(PREINSTALLED)) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = PREINSTALLED
}

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
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
    viewport: { width: 1280, height: 800 }
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          executablePath: chromiumExecutable(),
          // Electron treats file:// as a privileged scheme (ES modules + module workers load from
          // it); plain Chromium needs this switch for the same behaviour.
          args: ['--allow-file-access-from-files']
        }
      }
    }
  ]
})
