import type { BridgeLogger } from '@mlp/lsp-bridge'

const MAX_LINE = 4000

/**
 * Bridge logger that writes through `orca.log` (shown in Orca's plugin log).
 * Every line passes through `redact` so secrets registered with it (the
 * bridge token) can never reach Orca's logs, even if a message embeds one.
 */
export function createPluginLogger(
  write: (line: string) => void,
  secrets: () => readonly string[]
): BridgeLogger {
  const emit =
    (level: string) =>
    (message: string, meta?: Record<string, unknown>): void => {
      const suffix = meta && Object.keys(meta).length > 0 ? ` ${safeJson(meta)}` : ''
      let line = `[mlp] ${level}: ${message}${suffix}`
      for (const secret of secrets()) {
        if (secret.length > 0) {
          line = line.split(secret).join('<redacted>')
        }
      }
      try {
        write(line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}…` : line)
      } catch {
        // Logging must never take the worker down.
      }
    }
  return {
    // Why: debug output would flood Orca's per-plugin log buffer.
    debug: () => {},
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error')
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return '[unserializable]'
  }
}
