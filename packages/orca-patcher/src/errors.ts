/** Exit codes used by the CLI. */
export const ExitCode = {
  Ok: 0,
  Error: 1,
  /** `status`: Orca is not patched (or the patch was wiped by an update) / something needs action. */
  NeedsAction: 2
} as const

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode]

/** An expected failure with a user-facing message (no stack trace printed). */
export class PatcherError extends Error {
  readonly exitCode: ExitCodeValue
  constructor(message: string, exitCode: ExitCodeValue = ExitCode.Error) {
    super(message)
    this.name = 'PatcherError'
    this.exitCode = exitCode
  }
}
