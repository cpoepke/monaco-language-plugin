export type BridgeLogger = {
  debug(message: string, meta?: Record<string, unknown>): void
  info(message: string, meta?: Record<string, unknown>): void
  warn(message: string, meta?: Record<string, unknown>): void
  error(message: string, meta?: Record<string, unknown>): void
}

const noop = (): void => {}

export const silentLogger: BridgeLogger = { debug: noop, info: noop, warn: noop, error: noop }

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

/** Line-oriented logger for the CLI. Writes to stderr because stdout carries
 *  the machine-readable `{url, port, token}` line. */
export function createStderrLogger(minLevel: LogLevel = 'info'): BridgeLogger {
  const write =
    (level: LogLevel) =>
    (message: string, meta?: Record<string, unknown>): void => {
      if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) {
        return
      }
      const suffix = meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : ''
      process.stderr.write(`[mlp-bridge] ${level}: ${message}${suffix}\n`)
    }
  return { debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error') }
}
