#!/usr/bin/env node
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { bridgeUrl, DEFAULT_BRIDGE_PORT } from '@mlp/protocol'
import { createBridge } from './bridge/create-bridge'
import { createStderrLogger } from './logger'

const USAGE = `Usage: mlp-bridge [options]

  --port <n>        Port to listen on (default ${DEFAULT_BRIDGE_PORT}; 0 = ephemeral)
  --token <t>       Shared secret (default: $MLP_BRIDGE_TOKEN, else a random token)
  --root <dir>      Allowed root; repeatable. Without it any local file may be served.
  --host <addr>     Interface to bind (default 127.0.0.1)
  --allow-remote    Permit a non-loopback --host
  --print-url       Print {"url","port","token"} as one JSON line on stdout
  --verbose         Debug logging on stderr
  -h, --help        Show this help
`

function fail(message: string): never {
  process.stderr.write(`mlp-bridge: ${message}\n\n${USAGE}`)
  process.exit(2)
}

function parseCliArgs() {
  try {
    return parseArgs({
      options: {
        port: { type: 'string' },
        token: { type: 'string' },
        root: { type: 'string', multiple: true },
        host: { type: 'string' },
        'allow-remote': { type: 'boolean' },
        'print-url': { type: 'boolean' },
        verbose: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' }
      },
      strict: true,
      allowPositionals: false
    }).values
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error))
  }
}

async function main(): Promise<void> {
  const values = parseCliArgs()
  if (values.help) {
    process.stdout.write(USAGE)
    return
  }

  const port = values.port === undefined ? DEFAULT_BRIDGE_PORT : Number(values.port)
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    fail(`invalid --port: ${values.port}`)
  }
  const envToken = process.env.MLP_BRIDGE_TOKEN
  const providedToken = values.token ?? (envToken && envToken.length > 0 ? envToken : undefined)
  const token = providedToken ?? randomBytes(24).toString('base64url')
  const host = values.host ?? '127.0.0.1'
  const logger = createStderrLogger(values.verbose ? 'debug' : 'info')

  const bridge = createBridge({
    port,
    host,
    token,
    allowRemote: values['allow-remote'] ?? false,
    allowedRoots: (values.root ?? []).map((root) => resolve(root)),
    logger
  })
  const { port: boundPort } = await bridge.listen()

  // Why: a generated token is useless unless the caller learns it, so the
  // connection line is printed whenever we made the token up.
  if (values['print-url'] || providedToken === undefined) {
    const url = bridgeUrl(boundPort, token, host.includes(':') ? `[${host}]` : host)
    process.stdout.write(`${JSON.stringify({ url, port: boundPort, token })}\n`)
  }

  let stopping = false
  const stop = (signal: NodeJS.Signals): void => {
    if (stopping) {
      return
    }
    stopping = true
    logger.info(`received ${signal}, shutting down`)
    // Why: a second signal or a wedged server must not keep the process alive.
    const forceExit = setTimeout(() => process.exit(1), 10_000)
    forceExit.unref()
    bridge.close().then(
      () => process.exit(0),
      (error: unknown) => {
        logger.error('shutdown failed', { error: String(error) })
        process.exit(1)
      }
    )
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

main().catch((error: unknown) => {
  process.stderr.write(
    `mlp-bridge: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  )
  process.exit(1)
})
