#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { PATCHER_VERSION } from './constants.js'
import { consoleLogger, createContext } from './context.js'
import { doctor, formatDoctor } from './doctor.js'
import { ExitCode, PatcherError, setWorkspaceTrust } from '@mlp/orca-patch-core'
import { install, type InstallOptions } from './install.js'
import { formatStatus, status } from './status.js'
import { uninstall } from './uninstall.js'

const USAGE = `monaco-lsp-orca ${PATCHER_VERSION} — LSP code navigation for Orca's editor

Usage:
  monaco-lsp-orca install   [--app <path>] [--dry-run] [--force] [--fix-integrity] [--skip-plugin]
                            [--no-resign] [--no-auto-repair]
  monaco-lsp-orca uninstall [--app <path>] [--force] [--purge]
  monaco-lsp-orca status    [--app <path>] [--json]
  monaco-lsp-orca doctor    [--json]
  monaco-lsp-orca trust     <workspace-directory>
  monaco-lsp-orca untrust   <workspace-directory>

Language servers may execute workspace SDKs and build scripts. Trust only repositories
whose code you are willing to run. Restart Orca after changing workspace trust.

Options:
  --app <path>       Orca location: Orca.app, install dir, resources dir, app.asar, or an
                     extracted AppImage (squashfs-root). Default: the usual install location.
  --dry-run          Verify and build the patched archive, but change nothing.
  --force            Proceed even if Orca seems to be running.
  --fix-integrity    macOS: remove a stale ElectronAsarIntegrity entry from Info.plist.
  --skip-plugin      Do not (re)install the plugin folder.
  --no-resign        macOS: keep Orca's Developer ID signature instead of re-signing ad hoc
                     (experimental; saved for self-repair too). Plain \`install\` re-signs again.
  --no-auto-repair   Do not let the Orca plugin re-apply the patch after Orca updates.
  --purge            uninstall: also delete the installed plugin folder. (uninstall always turns
                     auto-repair off, so the plugin does not patch Orca again.)
  --json             Machine-readable output.

Exit codes: 0 ok, 1 error, 2 not patched / needs action.`

/**
 * Run the CLI. `defaults` are merged into every command's options (tests inject a logger,
 * paths and a command runner this way).
 */
export async function main(argv: string[], defaults: InstallOptions = {}): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      app: { type: 'string' },
      'dry-run': { type: 'boolean' },
      force: { type: 'boolean' },
      'fix-integrity': { type: 'boolean' },
      'skip-plugin': { type: 'boolean' },
      'no-resign': { type: 'boolean' },
      'no-auto-repair': { type: 'boolean' },
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
  const app = values.app ?? defaults.app
  switch (command) {
    case 'trust':
    case 'untrust': {
      if (positionals.length !== 2) throw new Error(`${command} requires one workspace directory`)
      const ctx = createContext(defaults)
      if (ctx.system.getuid() === 0)
        throw new Error('Manage workspace trust as your normal user, without sudo')
      const root = setWorkspaceTrust(ctx.stateDir, positionals[1]!, command === 'trust')
      ctx.logger.info(
        `${command === 'trust' ? 'Trusted' : 'Removed trust for'} ${root}. Restart Orca to apply. Language servers in trusted workspaces can execute project code.`
      )
      return ExitCode.Ok
    }
    case 'install':
      await install({
        ...defaults,
        app,
        dryRun: values['dry-run'],
        force: values.force,
        fixIntegrity: values['fix-integrity'],
        skipPlugin: values['skip-plugin'],
        resign: values['no-resign'] !== true,
        autoRepair: values['no-auto-repair'] !== true
      })
      return ExitCode.Ok
    case 'uninstall':
      await uninstall({ ...defaults, app, force: values.force, purge: values.purge })
      return ExitCode.Ok
    case 'status': {
      const report = await status({ ...defaults, app })
      console.log(values.json ? JSON.stringify(report, null, 2) : formatStatus(report))
      return report.exitCode
    }
    case 'doctor': {
      const report = doctor(defaults)
      console.log(values.json ? JSON.stringify(report, null, 2) : formatDoctor(report))
      return report.exitCode
    }
    default:
      console.error(`Unknown command: ${command}\n\n${USAGE}`)
      return ExitCode.Error
  }
}

function isEntryPoint(): boolean {
  try {
    return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isEntryPoint()) void run()

/**
 * `main` plus the error-to-exit-code mapping of the executable: expected failures
 * (PatcherError) and bad arguments print one message and exit 1/2, anything else prints its stack.
 */
export async function runCli(argv: string[], defaults: InstallOptions = {}): Promise<number> {
  try {
    return await main(argv, defaults)
  } catch (error) {
    if (error instanceof PatcherError) {
      consoleLogger.error(error.message)
      return error.exitCode
    }
    if (String((error as { code?: unknown }).code).startsWith('ERR_PARSE_ARGS')) {
      consoleLogger.error(`${(error as Error).message}\n\n${USAGE}`)
      return ExitCode.Error
    }
    consoleLogger.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
    return ExitCode.Error
  }
}

async function run(): Promise<void> {
  process.exitCode = await runCli(process.argv.slice(2))
}
