#!/usr/bin/env node
// Thin bin wrapper: all behaviour lives in run-cli.ts, which is tested in-process.
import { runCli } from './run-cli'

runCli(process.argv.slice(2), process.env, {
  stdout: process.stdout,
  stderr: process.stderr,
  onSignal: (signal, handler) => {
    process.on(signal, handler)
  },
  exit: (code) => process.exit(code)
}).then(
  (code) => {
    if (code !== null) {
      process.exit(code)
    }
  },
  (error: unknown) => {
    process.stderr.write(
      `mlp-bridge: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
    )
    process.exit(1)
  }
)
