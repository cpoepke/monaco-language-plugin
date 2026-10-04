import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { bridgeUrl, DEFAULT_BRIDGE_PORT } from '@mlp/protocol'
import { createBridge } from './bridge/create-bridge'
import { createStderrLogger } from './logger'

export const USAGE = `Usage: mlp-bridge [options]

  --port <n>        Port to listen on (default ${DEFAULT_BRIDGE_PORT}; 0 = ephemeral)
  --token <t>       Shared secret (default: $MLP_BRIDGE_TOKEN, else a random token)
  --root <dir>      Allowed root; repeatable. Without it, documents may be opened
                    anywhere and reads stay inside the opened sessions' roots.
  --host <addr>     Interface to bind (default 127.0.0.1)
  --allow-remote    Permit a non-loopback --host
  --trust-project-binaries
                    Also run servers from the project's node_modules/.bin
  --print-url       Print {"url","port","token"} as one JSON line on stdout
  --verbose         Debug logging on stderr
  -h, --help        Show this help
`

/** The process surface the CLI touches, so it can run in-process under test. */
export type CliIo = {
  stdout: { write(chunk: string): unknown }
  stderr: { write(chunk: string): unknown }
  onSignal(signal: NodeJS.Signals, handler: (signal: NodeJS.Signals) => void): void
  exit(code: number): void
}

/** How long a shutdown may take before the process is ended regardless. */
export const FORCE_EXIT_MS = 10_000

type CliValues = {
  port?: string
  token?: string
  root?: string[]
  host?: string
  'allow-remote'?: boolean
  'trust-project-binaries'?: boolean
  'print-url'?: boolean
  verbose?: boolean
  help?: boolean
}

function parseCliArgs(argv: readonly string[]): CliValues | string {
  try {
    return parseArgs({
      args: [...argv],
      options: {
        port: { type: 'string' },
        token: { type: 'string' },
        root: { type: 'string', multiple: true },
        host: { type: 'string' },
        'allow-remote': { type: 'boolean' },
        'trust-project-binaries': { type: 'boolean' },
        'print-url': { type: 'boolean' },
        verbose: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' }
      },
      strict: true,
      allowPositionals: false
    }).values
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/**
 * The `mlp-bridge` command. Resolves with the exit code when the process should
 * end now (help, bad arguments), or null once the bridge is listening; from then
 * on `io.onSignal` handlers shut it down and call `io.exit`. Rejects when the
 * bridge cannot start (e.g. the port is taken).
 */
export async function runCli(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  io: CliIo
): Promise<number | null> {
  const fail = (message: string): number => {
    io.stderr.write(`mlp-bridge: ${message}\n\n${USAGE}`)
    return 2
  }
  const values = parseCliArgs(argv)
  if (typeof values === 'string') {
    return fail(values)
  }
  if (values.help) {
    io.stdout.write(USAGE)
    return 0
  }

  // Why: Number('') is 0 and Number('1e3') is 1000; only plain decimal digits are a port.
  const port =
    values.port === undefined
      ? DEFAULT_BRIDGE_PORT
      : /^\d{1,5}$/.test(values.port)
        ? Number(values.port)
        : Number.NaN
  if (!Number.isInteger(port) || port > 65_535) {
    return fail(`invalid --port: ${values.port}`)
  }
  const envToken = env.MLP_BRIDGE_TOKEN
  const providedToken = values.token ?? (envToken && envToken.length > 0 ? envToken : undefined)
  const token = providedToken ?? randomBytes(24).toString('base64url')
  const host = values.host ?? '127.0.0.1'
  const logger = createStderrLogger(values.verbose ? 'debug' : 'info')

  const bridge = createBridge({
    port,
    host,
    token,
    allowRemote: values['allow-remote'] ?? false,
    trustProjectBinaries: values['trust-project-binaries'] ?? false,
    allowedRoots: (values.root ?? []).map((root) => resolve(root)),
    logger
  })
  const { port: boundPort } = await bridge.listen()

  // Why: a generated token is useless unless the caller learns it, so the
  // connection line is printed whenever we made the token up.
  if (values['print-url'] || providedToken === undefined) {
    const url = bridgeUrl(boundPort, token, host.includes(':') ? `[${host}]` : host)
    io.stdout.write(`${JSON.stringify({ url, port: boundPort, token })}\n`)
  }

  let stopping = false
  const stop = (signal: NodeJS.Signals): void => {
    if (stopping) {
      return
    }
    stopping = true
    logger.info(`received ${signal}, shutting down`)
    // Why: a second signal or a wedged server must not keep the process alive.
    const forceExit = setTimeout(() => io.exit(1), FORCE_EXIT_MS)
    forceExit.unref()
    bridge.close().then(
      () => io.exit(0),
      (error: unknown) => {
        logger.error('shutdown failed', { error: String(error) })
        io.exit(1)
      }
    )
  }
  io.onSignal('SIGINT', stop)
  io.onSignal('SIGTERM', stop)
  return null
}
