import nodeFs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, vi } from 'vitest'

/** An fs-style error carrying an errno `code`, like the ones Node throws. */
export function errno(code: string, message = `${code}: simulated`): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code })
}

const dirs: string[] = []

/** A fresh temp directory (real path), removed after the test. */
export function tmpDir(prefix = 'mlp-core-'): string {
  const dir = nodeFs.realpathSync(nodeFs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) nodeFs.rmSync(dir, { recursive: true, force: true })
})

/** Lines logged through a Logger, per level. */
export function memoryLogger(): {
  logger: { info(m: string): void; warn(m: string): void; error(m: string): void }
  lines: string[]
  text(): string
} {
  const lines: string[] = []
  return {
    logger: {
      info: (m) => void lines.push(`info: ${m}`),
      warn: (m) => void lines.push(`warn: ${m}`),
      error: (m) => void lines.push(`error: ${m}`)
    },
    lines,
    text: () => lines.join('\n')
  }
}
