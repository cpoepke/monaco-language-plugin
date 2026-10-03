import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveLspServerForLanguage } from './server-catalog'
import { defaultServerProbe, resetServerProbeCacheForTests } from './server-probe'

const posix = process.platform !== 'win32'

describe.skipIf(!posix)('server probe', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mlp-probe-'))
    resetServerProbeCacheForTests()
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  function script(name: string, body: string): string {
    const file = join(dir, name)
    writeFileSync(file, `#!/bin/sh\n${body}\n`)
    chmodSync(file, 0o755)
    return file
  }

  it('treats a rustup proxy without the component as not installed', () => {
    script(
      'rust-analyzer',
      `echo "error: Unknown binary 'rust-analyzer' in official toolchain 'stable'." >&2; exit 1`
    )
    const resolution = resolveLspServerForLanguage('rust', { pathEnv: dir, extraDirs: [] })
    expect(resolution.server).toBeNull()
    expect(resolution.server === null && resolution.reason).toMatch(
      /found but not working: .*rust-analyzer \(exited with 1: error: Unknown binary/
    )
  })

  it('accepts a server whose version command succeeds', () => {
    const file = script('gopls', 'echo "golang.org/x/tools/gopls v0.23.0"')
    const resolution = resolveLspServerForLanguage('go', { pathEnv: dir, extraDirs: [] })
    expect(resolution.server?.executablePath).toBe(file)
  })

  it('can be disabled and caches its verdict per binary', () => {
    const file = script('rust-analyzer', 'exit 3')
    expect(
      resolveLspServerForLanguage('rust', { pathEnv: dir, extraDirs: [], probe: false }).server
    ).not.toBeNull()
    expect(defaultServerProbe(file, ['--version'])).toMatchObject({ ok: false })
    // Fixing the binary is picked up after a restart, like PATH lookups.
    script('rust-analyzer', 'exit 0')
    expect(defaultServerProbe(file, ['--version'])).toMatchObject({ ok: false })
  })
})
