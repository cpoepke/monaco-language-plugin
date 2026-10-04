import { appendFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { applyPending, type Logger } from '@mlp/orca-patch-core'

/** Appends timestamped lines to `file`; without one (or when it cannot be written) it is silent. */
export function fileLogger(file: string | undefined): Logger {
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

export const positiveInt = (value: string | undefined): number | undefined => {
  const n = value === undefined ? NaN : Number(value)
  return Number.isInteger(n) && n > 0 ? n : undefined
}

/**
 * The helper's command line:
 *   --asar <absolute app.asar> --wait-pid <pid> [--log <file>] [--timeout-ms <ms>] [--poll-ms <ms>]
 * Resolves with the process exit code: 0 when the pending archive was applied, 1 when it was
 * not, 2 for unusable arguments.
 */
export async function runApplyPending(
  argv: readonly string[],
  apply: typeof applyPending = applyPending
): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
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
    logger.error(`bad arguments: ${JSON.stringify(argv)}`)
    return 2
  }
  logger.info(`started for ${asarPath}`)
  const result = await apply({
    asarPath,
    waitPid,
    logger,
    timeoutMs: positiveInt(values['timeout-ms'] as string | undefined),
    pollMs: positiveInt(values['poll-ms'] as string | undefined)
  })
  logger.info(`finished: ${result}`)
  return result === 'applied' ? 0 : 1
}
