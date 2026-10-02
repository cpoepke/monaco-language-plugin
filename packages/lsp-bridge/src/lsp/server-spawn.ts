// Adapted from stablyai/orca PR #14873 (MIT). See vendor/orca-lsp.
import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { ResolvedLspServer } from './server-catalog'

export type SpawnedServer = {
  child: ChildProcessWithoutNullStreams
  /** True when the child leads its own process group (POSIX), so the whole
   *  tree (e.g. tsserver under typescript-language-server) can be signalled. */
  processGroup: boolean
}

export type SpawnLspServer = (server: ResolvedLspServer, rootPath: string) => SpawnedServer

/** Quote one argument for cmd.exe's `/s /c "..."` form. */
function quoteForCmd(arg: string): string {
  if (arg.length > 0 && !/[\s"&|<>^%]/.test(arg)) {
    return arg
  }
  return `"${arg.replace(/"/g, '""')}"`
}

/** Batch shims (`.cmd`/`.bat`) can't be spawned directly since Node's
 *  CVE-2024-27980 fix, and `shell: true` hits DEP0190. Route them through
 *  cmd.exe explicitly with verbatim, pre-quoted arguments instead. */
export function windowsSpawnArgs(
  executablePath: string,
  args: readonly string[],
  comspec = process.env.ComSpec ?? 'cmd.exe'
): { command: string; args: string[]; verbatim: boolean } {
  if (!/\.(cmd|bat)$/i.test(executablePath)) {
    return { command: executablePath, args: [...args], verbatim: false }
  }
  const line = [executablePath, ...args].map(quoteForCmd).join(' ')
  return { command: comspec, args: ['/d', '/s', '/c', `"${line}"`], verbatim: true }
}

export const spawnLspServer: SpawnLspServer = (server, rootPath) => {
  const isWindows = process.platform === 'win32'
  const target = isWindows
    ? windowsSpawnArgs(server.executablePath, server.args)
    : { command: server.executablePath, args: [...server.args], verbatim: false }
  const child = spawn(target.command, target.args, {
    cwd: rootPath,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    windowsVerbatimArguments: target.verbatim,
    // Why: never a shell — the command is an absolute path we resolved ourselves,
    // so there is nothing for a shell to expand and nothing to inject into.
    shell: false,
    // Why: a separate process group lets shutdown signal grandchildren (tsserver,
    // gopls workers) too, and keeps a terminal Ctrl+C aimed at the bridge from
    // racing our own graceful shutdown of the servers.
    detached: !isWindows,
    env: process.env
  })
  return { child, processGroup: !isWindows }
}
