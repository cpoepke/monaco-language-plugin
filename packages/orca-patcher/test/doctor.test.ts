import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProbeResult } from '@mlp/lsp-bridge'
import { ExitCode } from '@mlp/orca-patch-core'
import { main } from '../src/cli'
import { silentLogger } from '../src/context'
import { brokenHint, doctor, formatDoctor, type DoctorReport } from '../src/doctor'

// ---------------------------------------------------------------------------------------------
// Injected fakes: a fake file system (posix paths, platform 'linux') and a fake probe. These run
// identically on every host because the resolver picks its path flavour from `platform`.
// ---------------------------------------------------------------------------------------------

const HOME = '/home/me'

function fakeDoctor(
  files: string[],
  probes: Record<string, ProbeResult> = {},
  env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin' }
): DoctorReport {
  const set = new Set(files)
  const calls: string[] = []
  const report = doctor({
    platform: 'linux',
    env,
    homeDir: HOME,
    logger: silentLogger,
    isFile: (p) => set.has(p),
    probe: (file, args) => {
      calls.push(`${file} ${args.join(' ')}`)
      return probes[file] ?? { ok: true }
    }
  })
  return report
}

const RUSTUP_ERROR =
  "exited with 1: error: Unknown binary 'rust-analyzer' in official toolchain 'stable-x86_64-unknown-linux-gnu'."

describe('doctor statuses (injected fakes)', () => {
  it('reports ok with the path and the first version line', () => {
    const report = fakeDoctor(['/usr/bin/typescript-language-server', '/usr/bin/node'], {
      '/usr/bin/typescript-language-server': { ok: true, version: '5.3.0' }
    })
    const ts = report.entries.find((e) => e.language === 'TypeScript/JavaScript')
    expect(ts).toMatchObject({
      status: 'ok',
      version: '5.3.0',
      found: {
        binary: 'typescript-language-server',
        path: '/usr/bin/typescript-language-server',
        searchedByBridge: true
      }
    })
    expect(ts?.candidates.map((c) => [c.binary, c.status])).toEqual([
      ['typescript-language-server', 'ok'],
      ['tsgo', 'missing']
    ])
  })

  it('reports broken with the reason and a rust-analyzer specific hint', () => {
    const report = fakeDoctor(['/home/me/.cargo/bin/rust-analyzer'], {
      '/home/me/.cargo/bin/rust-analyzer': { ok: false, reason: RUSTUP_ERROR }
    })
    const rust = report.entries.find((e) => e.language === 'Rust')
    expect(rust).toMatchObject({
      status: 'broken',
      reason: RUSTUP_ERROR,
      found: { binary: 'rust-analyzer', path: '/home/me/.cargo/bin/rust-analyzer' }
    })
    expect(rust?.hint).toBe('rustup component add rust-analyzer')
    expect(report.exitCode).toBe(ExitCode.NeedsAction)
  })

  it('falls back to the next candidate when the first is broken, and notes it', () => {
    const report = fakeDoctor(['/usr/bin/typescript-language-server', '/usr/bin/tsgo'], {
      '/usr/bin/typescript-language-server': {
        ok: false,
        reason: 'exited with 127: node: not found'
      }
    })
    const ts = report.entries.find((e) => e.language === 'TypeScript/JavaScript')
    expect(ts).toMatchObject({ status: 'ok', found: { binary: 'tsgo' } })
    expect(formatDoctor(report)).toContain(
      'note: typescript-language-server at /usr/bin/typescript-language-server is not working (exited with 127: node: not found)'
    )
  })

  it('missing languages keep the install hint per OS', () => {
    const linux = fakeDoctor([])
    expect(linux.entries.every((e) => e.status === 'missing' && e.found === null)).toBe(true)
    expect(linux.entries.find((e) => e.language === 'Go')?.hint).toContain('your distro package')
    const mac = doctor({
      platform: 'darwin',
      env: { PATH: '/usr/bin' },
      homeDir: HOME,
      logger: silentLogger,
      isFile: () => false,
      probe: false
    })
    expect(mac.entries.find((e) => e.language === 'Go')?.hint).toContain('brew install go')
    expect(mac.entries.find((e) => e.language === 'Rust')?.hint).toContain(
      'brew install rust-analyzer'
    )
    const win = doctor({
      platform: 'win32',
      env: { Path: 'C:\\tools' },
      homeDir: 'C:\\Users\\me',
      logger: silentLogger,
      isFile: () => false,
      probe: false
    })
    expect(win.entries.find((e) => e.language === 'Go')?.hint).toContain('winget install')
  })

  it('reports a server outside the bridge search dirs as off-path', () => {
    const report = fakeDoctor(['/home/me/.local/bin/basedpyright-langserver'])
    const py = report.entries.find((e) => e.language === 'Python')
    expect(py).toMatchObject({
      status: 'off-path',
      found: { binary: 'basedpyright-langserver', searchedByBridge: false }
    })
    expect(formatDoctor(report)).toContain(
      'warning  Python                 /home/me/.local/bin/basedpyright-langserver is not on PATH; add /home/me/.local/bin to PATH'
    )
  })

  it('only exits 0 when every language works', () => {
    const all = [
      '/usr/bin/typescript-language-server',
      '/usr/bin/pyright-langserver',
      '/home/me/go/bin/gopls',
      '/home/me/.cargo/bin/rust-analyzer',
      '/usr/bin/node'
    ]
    expect(fakeDoctor(all).exitCode).toBe(ExitCode.Ok)
    expect(
      fakeDoctor(all, { '/home/me/go/bin/gopls': { ok: false, reason: 'exited with 2' } }).exitCode
    ).toBe(ExitCode.NeedsAction)
    expect(fakeDoctor(all.slice(0, 3)).exitCode).toBe(ExitCode.NeedsAction)
  })

  it('probes with the catalog version commands', () => {
    const seen: string[] = []
    doctor({
      platform: 'linux',
      env: { PATH: '/usr/bin' },
      homeDir: HOME,
      logger: silentLogger,
      isFile: (p) => ['/usr/bin/gopls', '/usr/bin/rust-analyzer'].includes(p),
      probe: (file, args) => {
        seen.push(`${file} ${args.join(' ')}`)
        return { ok: true }
      }
    })
    expect(seen).toEqual(['/usr/bin/gopls version', '/usr/bin/rust-analyzer --version'])
  })
})

describe('doctor hints', () => {
  it.each([
    [
      'typescript-language-server',
      'typescript-language-server',
      /npm install -g typescript-language-server typescript/
    ],
    ['tsgo', 'tsgo', /@typescript\/native-preview/],
    ['pyright', 'pyright-langserver', /npm install -g pyright/],
    ['basedpyright', 'basedpyright-langserver', /basedpyright/],
    ['gopls', 'gopls', /go install golang.org\/x\/tools\/gopls@latest/],
    ['rust-analyzer', 'rust-analyzer', /^rustup component add rust-analyzer$/],
    ['unknown-server', 'mystery-ls', /reinstall mystery-ls/]
  ])('broken %s', (serverId, command, expected) => {
    expect(brokenHint(serverId, command, 'linux')).toMatch(expected)
  })

  it('suggests brew for rust-analyzer on macOS', () => {
    expect(brokenHint('rust-analyzer', 'rust-analyzer', 'darwin')).toContain('brew install')
  })
})

describe('doctor output', () => {
  const report = fakeDoctor(
    [
      '/usr/bin/typescript-language-server',
      '/home/me/.cargo/bin/rust-analyzer',
      '/home/me/.local/bin/basedpyright-langserver',
      '/usr/bin/node'
    ],
    {
      '/usr/bin/typescript-language-server': { ok: true, version: '5.3.0' },
      '/home/me/.cargo/bin/rust-analyzer': { ok: false, reason: RUSTUP_ERROR }
    }
  )

  it('formats ok / off-path / missing / broken lines', () => {
    expect(formatDoctor(report)).toMatchInlineSnapshot(`
      "Language servers (the bridge searches PATH, ~/go/bin and ~/.cargo/bin, and runs each
      server's version command to check that it works):
        ok       TypeScript/JavaScript  typescript-language-server → /usr/bin/typescript-language-server  (5.3.0)
        warning  Python                 /home/me/.local/bin/basedpyright-langserver is not on PATH; add /home/me/.local/bin to PATH
        missing  Go                     install: go install golang.org/x/tools/gopls@latest   (Go itself: your distro package or https://go.dev/dl)
        broken   Rust                   rust-analyzer → /home/me/.cargo/bin/rust-analyzer
                                        exited with 1: error: Unknown binary 'rust-analyzer' in official toolchain 'stable-x86_64-unknown-linux-gnu'.
                                        fix: rustup component add rust-analyzer

      Note: Orca started from the Dock/Start menu may see a shorter PATH than your terminal. If a server
      works here but not in Orca, install it into one of the directories above or start Orca from a shell."
    `)
  })

  it('has a stable JSON shape', () => {
    const json = JSON.parse(JSON.stringify(report)) as DoctorReport
    expect(Object.keys(json).sort()).toEqual(['entries', 'exitCode', 'node'])
    expect(json.node).toBe('/usr/bin/node')
    expect(json.exitCode).toBe(2)
    for (const entry of json.entries) {
      expect(Object.keys(entry)).toEqual(
        expect.arrayContaining(['language', 'status', 'found', 'hint', 'candidates'])
      )
    }
    const rust = json.entries.find((e) => e.language === 'Rust')
    expect(rust).toEqual({
      language: 'Rust',
      status: 'broken',
      found: {
        binary: 'rust-analyzer',
        path: '/home/me/.cargo/bin/rust-analyzer',
        searchedByBridge: true
      },
      reason: RUSTUP_ERROR,
      hint: 'rustup component add rust-analyzer',
      candidates: [
        {
          serverId: 'rust-analyzer',
          binary: 'rust-analyzer',
          status: 'broken',
          path: '/home/me/.cargo/bin/rust-analyzer',
          reason: RUSTUP_ERROR
        }
      ]
    })
    expect(json.entries.find((e) => e.language === 'Go')).toMatchObject({
      status: 'missing',
      found: null
    })
  })

  it('warns when a node-based server is found but node is not', () => {
    const noNode = fakeDoctor(['/usr/bin/typescript-language-server'])
    expect(noNode.node).toBeNull()
    expect(formatDoctor(noNode)).toContain('need `node` on PATH')
  })
})

// ---------------------------------------------------------------------------------------------
// Real processes: tiny fake servers backed by a node script (a `.cmd` shim on Windows, a `sh`
// shim elsewhere), run through the bridge's real probe.
// ---------------------------------------------------------------------------------------------

type FakeServer = { stdout?: string; stderr?: string; exit?: number; sleepMs?: number }

describe('doctor with real fake servers', () => {
  let dir: string
  let home: string
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mlp-doctor-')))
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'mlp-doctor-home-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(home, { recursive: true, force: true })
  })

  function install(name: string, spec: FakeServer): string {
    const js = path.join(dir, `${name}.fake.js`)
    fs.writeFileSync(
      js,
      `const s = ${JSON.stringify(spec)}
if (s.stdout) process.stdout.write(s.stdout + '\\n')
if (s.stderr) process.stderr.write(s.stderr + '\\n')
setTimeout(() => process.exit(s.exit ?? 0), s.sleepMs ?? 0)
`
    )
    if (process.platform === 'win32') {
      const shim = path.join(dir, `${name}.cmd`)
      fs.writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${js}" %*\r\n`)
      return shim
    }
    const shim = path.join(dir, name)
    fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`)
    fs.chmodSync(shim, 0o755)
    return shim
  }

  const run = (): DoctorReport =>
    doctor({
      env: {
        PATH: dir,
        Path: dir,
        PATHEXT: '.CMD;.EXE'
      },
      homeDir: home,
      logger: silentLogger
    })

  it('ok / broken / missing against real binaries', () => {
    const gopls = install('gopls', { stdout: 'golang.org/x/tools/gopls v0.23.0', exit: 0 })
    const rust = install('rust-analyzer', {
      stderr: "error: Unknown binary 'rust-analyzer' in official toolchain 'stable'.",
      exit: 1
    })
    const report = run()
    const byLang = Object.fromEntries(report.entries.map((e) => [e.language, e]))
    expect(byLang['Go']).toMatchObject({
      status: 'ok',
      version: 'golang.org/x/tools/gopls v0.23.0'
    })
    expect(byLang['Go']?.found?.path.toLowerCase()).toBe(gopls.toLowerCase())
    expect(byLang['Rust']).toMatchObject({
      status: 'broken',
      hint: 'rustup component add rust-analyzer'
    })
    expect(byLang['Rust']?.reason).toMatch(/^exited with 1: error: Unknown binary 'rust-analyzer'/)
    expect(byLang['Rust']?.found?.path.toLowerCase()).toBe(rust.toLowerCase())
    expect(byLang['TypeScript/JavaScript']?.status).toBe('missing')
    expect(byLang['Python']?.status).toBe('missing')
    expect(report.exitCode).toBe(ExitCode.NeedsAction)

    const text = formatDoctor(report)
    expect(text).toContain('ok       Go')
    expect(text).toContain('(golang.org/x/tools/gopls v0.23.0)')
    expect(text).toContain('broken   Rust')
    expect(text).toContain('fix: rustup component add rust-analyzer')
  })

  it('uses the first stdout line when a failing server prints nothing on stderr', () => {
    install('gopls', { stdout: 'gopls: no go command on PATH', exit: 3 })
    const go = run().entries.find((e) => e.language === 'Go')
    expect(go).toMatchObject({ status: 'broken' })
    expect(go?.reason).toBe('exited with 3: gopls: no go command on PATH')
    expect(go?.hint).toMatch(/go install/)
  })

  // Why POSIX only: killing a timed-out `cmd.exe /c` shim does not close the pipes of its node
  // child on Windows, so spawnSync cannot return before the sleeper exits.
  it.skipIf(process.platform === 'win32')(
    'does not hang on a server that never answers (the probe times out and counts as ok)',
    () => {
      install('gopls', { sleepMs: 60_000 })
      const started = Date.now()
      const go = run().entries.find((e) => e.language === 'Go')
      expect(go?.status).toBe('ok')
      expect(Date.now() - started).toBeLessThan(30_000)
    },
    35_000
  )

  it('CLI: prints text and JSON with the same truth, exit 2 when something is unusable', async () => {
    install('gopls', { stdout: 'gopls v1', exit: 0 })
    const lines: string[] = []
    const spy = vi
      .spyOn(console, 'log')
      .mockImplementation((m?: unknown) => void lines.push(String(m)))
    const defaults = {
      env: { PATH: dir, Path: dir, PATHEXT: '.CMD;.EXE' },
      homeDir: home,
      logger: silentLogger
    }
    try {
      expect(await main(['doctor', '--json'], defaults)).toBe(ExitCode.NeedsAction)
      expect(await main(['doctor'], defaults)).toBe(ExitCode.NeedsAction)
    } finally {
      spy.mockRestore()
    }
    const json = JSON.parse(lines[0] ?? '{}') as DoctorReport
    expect(json.entries.find((e) => e.language === 'Go')).toMatchObject({
      status: 'ok',
      version: 'gopls v1'
    })
    expect(lines[1]).toContain('ok       Go')
  })
})
