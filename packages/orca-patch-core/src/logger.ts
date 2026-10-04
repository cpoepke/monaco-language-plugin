import { execFile } from 'node:child_process'

export type Logger = {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} }

export type CommandResult = { code: number; stdout: string; stderr: string }
export type CommandRunner = (command: string, args: string[]) => Promise<CommandResult>

export const defaultRunCommand: CommandRunner = (command, args) =>
  new Promise((resolve) => {
    execFile(
      command,
      args,
      { maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        const code =
          error == null ? 0 : typeof error.code === 'number' ? error.code : error.code ? 127 : 1
        // Why: a command that could not be started has no output; its error is the only reason.
        const startFailed = error != null && typeof error.code !== 'number'
        resolve({
          code,
          stdout: String(stdout ?? ''),
          stderr: String(stderr || (startFailed ? error.message : ''))
        })
      }
    )
  })
