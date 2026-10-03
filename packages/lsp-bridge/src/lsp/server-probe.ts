import { spawnSync } from 'node:child_process'
import { windowsSpawnArgs } from './server-spawn'

export type ProbeResult = { ok: true } | { ok: false; reason: string }

/** Runs a server's cheap version command to prove the binary actually works. */
export type ServerProbe = (executablePath: string, args: readonly string[]) => ProbeResult

const PROBE_TIMEOUT_MS = 5_000

// Why: probing spawns a process; editors open files constantly, so remember the
// verdict per binary for the process lifetime (like the PATH lookup itself).
const verdicts = new Map<string, ProbeResult>()

export function resetServerProbeCacheForTests(): void {
  verdicts.clear()
}

/**
 * Why: a binary on PATH is not proof of a working server. rustup installs a
 * `rust-analyzer` proxy even when the component is missing, and stale shims are
 * common; starting one fails with "Language server exited" on every open. A
 * version command that exits non-zero marks the server as not installed, so
 * the next catalog candidate (or a clear "not found" reason) is used instead.
 */
export const defaultServerProbe: ServerProbe = (executablePath, args) => {
  const key = `${executablePath}\0${args.join('\0')}`
  const cached = verdicts.get(key)
  if (cached) {
    return cached
  }
  const target =
    process.platform === 'win32'
      ? windowsSpawnArgs(executablePath, args)
      : { command: executablePath, args: [...args], verbatim: false }
  const run = spawnSync(target.command, target.args, {
    encoding: 'utf8',
    timeout: PROBE_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    windowsVerbatimArguments: target.verbatim,
    shell: false
  })
  let verdict: ProbeResult
  if (run.error && (run.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
    // Why: a slow machine is not a broken install; let the real start decide.
    verdict = { ok: true }
  } else if (run.error) {
    verdict = { ok: false, reason: run.error.message }
  } else if (run.status !== 0) {
    const detail = `${run.stderr ?? ''}\n${run.stdout ?? ''}`
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0)
    verdict = {
      ok: false,
      reason: `exited with ${run.status ?? run.signal}${detail ? `: ${detail}` : ''}`
    }
  } else {
    verdict = { ok: true }
  }
  verdicts.set(key, verdict)
  return verdict
}
