import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeOrcaRuntime } from './fake-orca-runtime'

const packageDir = fileURLToPath(new URL('..', import.meta.url))
const bundle = path.join(packageDir, 'dist', 'main.mjs')
const childScript = fileURLToPath(new URL('./smoke-child.mjs', import.meta.url))

const builtins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)])
// ws probes these optional native add-ons inside try/catch.
const OPTIONAL_REQUIRES = new Set(['bufferutil', 'utf-8-validate'])

beforeAll(() => {
  // Why always: a stale dist/ would make this test prove nothing. tsup takes
  // well under a second here.
  execFileSync('pnpm', ['run', 'build'], {
    cwd: packageDir,
    stdio: 'pipe',
    shell: process.platform === 'win32'
  })
  expect(existsSync(bundle)).toBe(true)
})

describe('dist/main.mjs', () => {
  it('imports only Node built-ins (ws, the bridge and the protocol are inlined)', () => {
    const source = readFileSync(bundle, 'utf8')
    const specifiers = [
      ...source.matchAll(/^\s*(?:import|export)\b[^'"]*?\bfrom\s+['"]([^'"]+)['"]/gm),
      ...source.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm),
      ...source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g),
      ...source.matchAll(/\b(?:__require|require)\(\s*['"]([^'"]+)['"]\s*\)/g)
    ].map((match) => match[1]!)
    expect(specifiers.length).toBeGreaterThan(0)
    const external = specifiers.filter((s) => !builtins.has(s) && !OPTIONAL_REQUIRES.has(s))
    expect(external).toEqual([])
    expect(source).not.toMatch(/from\s+['"]ws['"]|require\(\s*['"]ws['"]\s*\)/)
    expect(source).not.toMatch(/['"]@mlp\//)
  })

  describe('in a bare node child process', () => {
    let fake: FakeOrcaRuntime

    beforeAll(async () => {
      fake = new FakeOrcaRuntime()
      fake.handler = (request) =>
        request.method === 'worktree.list'
          ? { result: { worktrees: [{ path: path.resolve('/work/repo') }], totalCount: 1 } }
          : { result: { opened: true, kind: 'text' } }
      await fake.start()
    })

    afterAll(async () => {
      await fake.dispose()
    })

    async function runChild(entry: string, userDataOverride: string | null) {
      // Mirror Orca's scrubbed worker env (buildPluginWorkerEnv).
      const env: Record<string, string> = { ELECTRON_RUN_AS_NODE: '1' }
      for (const key of ['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'TMPDIR', 'TEMP', 'TMP']) {
        const value = process.env[key]
        if (value !== undefined) env[key] = value
      }
      if (userDataOverride) env.MLP_ORCA_USER_DATA = userDataOverride
      const target = path.resolve('/work/repo/src/app.ts')
      // Why async: the fake Orca runtime lives in this process and must keep
      // answering while the child runs.
      const { stdout } = await promisify(execFile)(process.execPath, [childScript, entry, target], {
        // Why: an unrelated cwd, so nothing can resolve from the repo's node_modules.
        cwd: fake.userData,
        env,
        encoding: 'utf8',
        timeout: 30_000
      })
      return JSON.parse(stdout.trim().split('\n').at(-1)!) as Record<string, any>
    }

    it('activates, serves a WebSocket client and opens files through the runtime', async () => {
      const result = await runChild(bundle, fake.userData)

      expect(result.activateMs).toBeLessThan(1_000)
      expect(result.commands.sort()).toEqual([
        'mlp.ensureBridge',
        'mlp.restart',
        'mlp.status',
        'mlp.stop'
      ])
      expect(result.info).toMatchObject({
        protocolVersion: 1,
        pluginVersion: '0.1.0',
        hostNavigation: true
      })
      expect(result.info.port).toBeGreaterThan(0)
      expect(result.info.token).toMatch(/^[0-9a-f]{64}$/)
      expect(result.sameAgain).toBe(true)
      expect(result.hello.result).toMatchObject({ protocolVersion: 1, hostNavigation: true })
      expect(result.openLocation.result).toEqual({ opened: true })
      expect(result.statusRunning).toBe(true)
      expect(result.stopped).toEqual({ stopped: true })
      expect(JSON.stringify(result.logs)).not.toContain(result.info.token)

      const open = fake.requests.find((r) => r.method === 'files.open')
      expect(open?.params).toEqual({
        worktree: `path:${path.resolve('/work/repo')}`,
        relativePath: 'src/app.ts',
        navigation: 'host'
      })
    })

    it('finds orca-runtime.json from the installed layout <userData>/plugins/<key>/<hash>/', async () => {
      // Exactly what Orca's installer produces: a copy of the plugin folder.
      const installed = path.join(fake.userData, 'plugins', 'cpoepke.monaco-lsp', 'abc123')
      mkdirSync(path.join(installed, 'dist'), { recursive: true })
      copyFileSync(bundle, path.join(installed, 'dist', 'main.mjs'))
      copyFileSync(
        path.join(packageDir, 'orca-plugin.json'),
        path.join(installed, 'orca-plugin.json')
      )
      fake.requests.length = 0
      const result = await runChild(path.join(installed, 'dist', 'main.mjs'), null)
      expect(result.info.hostNavigation).toBe(true)
      expect(result.openLocation.result).toEqual({ opened: true })
      expect(fake.requests.map((r) => r.method)).toContain('files.open')
    })
  })
})
