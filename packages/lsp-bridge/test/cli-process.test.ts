/** The built `mlp-bridge` binary as a real child process: the thin wrapper around runCli. */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { TestClient } from './helpers/test-client'

const packageDir = fileURLToPath(new URL('..', import.meta.url))
const cli = path.join(packageDir, 'dist', 'cli.js')

// Why no rebuild here: tsup cleans dist/, which the Orca plugin's bundle test reads
// (through @mlp/lsp-bridge) while other test files run in parallel. CI builds first;
// locally the suite is skipped until `pnpm build` was run.
const built = existsSync(cli)
if (!built && process.env.CI) {
  throw new Error(`${cli} is missing: run \`pnpm build\` before the tests`)
}

const children: ChildProcess[] = []
afterEach(() => {
  for (const child of children.splice(0)) {
    child.kill('SIGKILL')
  }
})

type Result = { code: number | null; stdout: string; stderr: string }

function run(args: string[], env: Record<string, string> = {}): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: { ...process.env, MLP_BRIDGE_TOKEN: '', ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    children.push(child)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

describe.skipIf(!built)('mlp-bridge binary', () => {
  it('prints usage for --help and exits 0', async () => {
    const result = await run(['--help'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('Usage: mlp-bridge')
    expect(result.stderr).toBe('')
  })

  it('exits 2 with the reason for bad arguments', async () => {
    const result = await run(['--port', 'nope'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('mlp-bridge: invalid --port: nope')
    expect(result.stdout).toBe('')
  })

  it('exits 1 with the error when the port is taken', async () => {
    const blocker = createServer()
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve))
    const { port } = blocker.address() as { port: number }
    try {
      const result = await run(['--port', String(port)])
      expect(result.code).toBe(1)
      expect(result.stderr).toMatch(/^mlp-bridge: .*EADDRINUSE/m)
    } finally {
      await new Promise((resolve) => blocker.close(resolve))
    }
  })

  // POSIX only: Windows has no SIGTERM; child.kill() terminates the process
  // without running the handlers.
  it.skipIf(process.platform === 'win32')(
    'serves clients, prints one JSON line and exits 0 on SIGTERM',
    async () => {
      const child = spawn(process.execPath, [cli, '--port', '0', '--token', 'abc', '--print-url'], {
        stdio: ['ignore', 'pipe', 'pipe']
      })
      children.push(child)
      const line = await new Promise<string>((resolve, reject) => {
        let out = ''
        child.stdout.on('data', (chunk) => {
          out += chunk
          if (out.includes('\n')) resolve(out)
        })
        child.on('error', reject)
        child.on('close', () => reject(new Error('exited before printing the connection line')))
      })
      const printed = JSON.parse(line) as { url: string; port: number; token: string }
      expect(printed.token).toBe('abc')
      expect(printed.url).toBe(`ws://127.0.0.1:${printed.port}/?token=abc`)
      const client = await TestClient.connectAndHello(printed.port, 'abc')

      const exited = new Promise<number | null>((resolve) =>
        child.on('close', (code) => resolve(code))
      )
      child.kill('SIGTERM')
      expect(await exited).toBe(0)
      await client.close()
    }
  )
})
