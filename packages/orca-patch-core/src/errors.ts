/** Exit codes used by the CLI. */
export const ExitCode = {
  Ok: 0,
  Error: 1,
  /** `status`: Orca is not patched (or the patch was wiped by an update) / something needs action. */
  NeedsAction: 2
} as const

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode]

/** Machine-readable reason of a PatcherError the plugin's self-repair reacts to. */
export type PatcherErrorReason =
  'anchor-missing' | 'unexpected-layout' | 'verification-failed' | 'lock-busy' | 'other'

/** An expected failure with a user-facing message (no stack trace printed). */
export class PatcherError extends Error {
  readonly exitCode: ExitCodeValue
  readonly reason: PatcherErrorReason
  constructor(
    message: string,
    exitCode: ExitCodeValue = ExitCode.Error,
    reason: PatcherErrorReason = 'other'
  ) {
    super(message)
    this.name = 'PatcherError'
    this.exitCode = exitCode
    this.reason = reason
  }
}

/** errno code of a Node fs error (`EBUSY`, `EACCES`, …), or null. */
export function errnoCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : null
}
