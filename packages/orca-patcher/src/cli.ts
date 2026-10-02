#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { PATCHER_VERSION } from './constants.js'
import { consoleLogger } from './context.js'
import { doctor, formatDoctor } from './doctor.js'
import { ExitCode, PatcherError } from './errors.js'
import { install } from './install.js'
import { formatStatus, status } from './status.js'
import { uninstall } from './uninstall.js'

const USAGE = `monaco-lsp-orca ${PATCHER_VERSION} — LSP code navigation for Orca's editor

Usage:
  monaco-lsp-orca install   [--app <path>] [--dry-run] [--force] [--fix-integrity] [--skip-plugin]
  monaco-lsp-orca uninstall [--app <path>] [--force] [--purge]
  monaco-lsp-orca status    [--app <path>] [--json]
  monaco-lsp-orca doctor    [--json]

Options:
  --app <path>       Orca location: Orca.app, install dir, resources dir, app.asar, or an
                     extracted AppImage (squashfs-root). Default: the usual install location.
  --dry-run          Verify and build the patched archive, but change nothing.
  --force            Proceed even if Orca seems to be running.
  --fix-integrity    macOS: remove a stale ElectronAsarIntegrity entry from Info.plist.
  --skip-plugin      Do not (re)install the plugin folder.
  --purge            uninstall: also delete the installed plugin folder.
  --json             Machine-readable output.

Exit codes: 0 ok, 1 error, 2 not patched / needs action.`

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      app: { type: 'string' },
      'dry-run': { type: 'boolean' },
      force: { type: 'boolean' },
      'fix-integrity': { type: 'boolean' },
      'skip-plugin': { type: 'boolean' },
      purge: { type: 'boolean' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' }
    }
  })
  if (values.version) {
    console.log(PATCHER_VERSION)
    return ExitCode.Ok
  }
  const command = positionals[0]
  if (values.help || !command) {
    console.log(USAGE)
    return values.help ? ExitCode.Ok : ExitCode.Error
  }
  const app = values.app
  switch (command) {
    case 'install':
      await install({
        app,
        dryRun: values['dry-run'],
        force: values.force,
        fixIntegrity: values['fix-integrity'],
        skipPlugin: values['skip-plugin']
      })
      return ExitCode.Ok
    case 'uninstall':
      await uninstall({ app, force: values.force, purge: values.purge })
      return ExitCode.Ok
    case 'status': {
      const report = await status({ app })
      console.log(values.json ? JSON.stringify(report, null, 2) : formatStatus(report))
      return report.exitCode
    }
    case 'doctor': {
      const report = doctor()
      console.log(values.json ? JSON.stringify(report, null, 2) : formatDoctor(report))
      return report.exitCode
    }
    default:
      console.error(`Unknown command: ${command}\n\n${USAGE}`)
      return ExitCode.Error
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (error: unknown) => {
    if (error instanceof PatcherError) {
      consoleLogger.error(error.message)
      process.exitCode = error.exitCode
    } else if (String((error as { code?: unknown }).code).startsWith('ERR_PARSE_ARGS')) {
      consoleLogger.error(`${(error as Error).message}\n\n${USAGE}`)
      process.exitCode = ExitCode.Error
    } else {
      consoleLogger.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
      process.exitCode = ExitCode.Error
    }
  }
)
