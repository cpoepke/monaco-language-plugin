/**
 * Detached helper (bundled to dist/apply-pending.mjs), started by the self-repair when a running
 * Orca keeps app.asar locked (Windows). Runs with Orca's own binary and ELECTRON_RUN_AS_NODE:
 *
 *   <Orca binary> apply-pending.mjs --asar <app.asar> --wait-pid <Orca main pid> --log <file>
 *     [--timeout-ms <ms>] [--poll-ms <ms>]
 *
 * Waits for Orca's main process to exit, then swaps `app.asar.mlp-pending` in with one rename,
 * verifies it and exits. Logs to ~/.monaco-lsp-orca/logs/apply-pending.log.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { applyPending, type Logger } from '@mlp/orca-patch-core'

function fileLogger(file: string | undefined): Logger {
  const write = (level: string, message: string): void => {
    if (!file) return
    try {
      mkdirSync(path.dirname(file), { recursive: true })
      appendFileSync(file, `${new Date().toISOString()} [${process.pid}] ${level}: ${message}\n`)
    } catch {
      // Nowhere else to report to.
    }
  }
  return {
    info: (m) => write('info', m),
    warn: (m) => write('warn', m),
    error: (m) => write('error', m)
  }
}

const positiveInt = (value: string | undefined): number | undefined => {
  const n = value === undefined ? NaN : Number(value)
  return Number.isInteger(n) && n > 0 ? n : undefined
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      asar: { type: 'string' },
      'wait-pid': { type: 'string' },
      log: { type: 'string' },
      'timeout-ms': { type: 'string' },
      'poll-ms': { type: 'string' }
    },
    strict: false
  })
  const logger = fileLogger(typeof values.log === 'string' ? values.log : undefined)
  const asarPath = typeof values.asar === 'string' ? values.asar : ''
  const waitPid = positiveInt(values['wait-pid'] as string | undefined)
  if (!asarPath || !path.isAbsolute(asarPath) || waitPid === undefined) {
    logger.error(`bad arguments: ${JSON.stringify(process.argv.slice(2))}`)
    return 2
  }
  logger.info(`started for ${asarPath}`)
  const result = await applyPending({
    asarPath,
    waitPid,
    logger,
    timeoutMs: positiveInt(values['timeout-ms'] as string | undefined),
    pollMs: positiveInt(values['poll-ms'] as string | undefined)
  })
  logger.info(`finished: ${result}`)
  return result === 'applied' ? 0 : 1
}

main().then(
  (code) => process.exit(code),
  () => process.exit(1)
)
