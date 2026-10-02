import { execFile } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { HOME_DIRNAME, HOME_ENV } from './constants.js'

export type Logger = {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

export type CommandResult = { code: number; stdout: string; stderr: string }
export type CommandRunner = (command: string, args: string[]) => Promise<CommandResult>

/** Options shared by every command; everything is injectable for tests. */
export type CommonOptions = {
  /** Explicit Orca location: .app bundle, install dir, resources dir, app.asar or squashfs-root. */
  app?: string
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  homeDir?: string
  /** Patcher home holding state.json and the installed plugin (default ~/.monaco-lsp-orca). */
  stateDir?: string
  logger?: Logger
  runCommand?: CommandRunner
}

export type Context = {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  homeDir: string
  stateDir: string
  logger: Logger
  runCommand: CommandRunner
}

export const consoleLogger: Logger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(`warning: ${m}`),
  error: (m) => console.error(`error: ${m}`)
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} }

export const defaultRunCommand: CommandRunner = (command, args) =>
  new Promise((resolve) => {
    execFile(
      command,
      args,
      { maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        const code =
          error == null ? 0 : typeof error.code === 'number' ? error.code : error.code ? 127 : 1
        resolve({
          code,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? error?.message ?? '')
        })
      }
    )
  })

export function createContext(options: CommonOptions = {}): Context {
  const env = options.env ?? process.env
  const homeDir = options.homeDir ?? os.homedir()
  const stateDir = options.stateDir ?? env[HOME_ENV] ?? path.join(homeDir, HOME_DIRNAME)
  return {
    platform: options.platform ?? process.platform,
    env,
    homeDir,
    stateDir,
    logger: options.logger ?? consoleLogger,
    runCommand: options.runCommand ?? defaultRunCommand
  }
}
