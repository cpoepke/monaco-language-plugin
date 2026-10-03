import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  type CommandRunner,
  defaultRunCommand,
  type Logger,
  patcherHome,
  silentLogger
} from '@mlp/orca-patch-core'

export type { CommandResult, CommandRunner, Logger } from '@mlp/orca-patch-core'
export { defaultRunCommand, silentLogger }

/** Process/filesystem hooks used to handle `sudo` (injectable for tests). */
export type SystemHooks = {
  /** Effective uid, or null where there is none (Windows). */
  getuid(): number | null
  /** File contents, or null when unreadable (used for /etc/passwd). */
  readFile(file: string): string | null
  /** Home directory of `user` via the shell's `~user` expansion; null when unknown. */
  shellHomeOf(user: string): string | null
  chown(file: string, uid: number, gid: number): void
}

/** The user who ran `sudo monaco-lsp-orca …`: files we create in their home are handed back. */
export type InvokingUser = { name: string; uid: number; gid: number; home: string }

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
  system?: Partial<SystemHooks>
}

export type Context = {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  homeDir: string
  stateDir: string
  logger: Logger
  runCommand: CommandRunner
  /** Set when running as root under sudo (POSIX): owner for files created in stateDir. */
  invokingUser: InvokingUser | null
  system: SystemHooks
}

export const consoleLogger: Logger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(`warning: ${m}`),
  error: (m) => console.error(`error: ${m}`)
}

// POSIX portable user names (plus the `$` Samba machine accounts use); anything else is refused
// before it gets near a shell.
const SAFE_USER_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*\$?$/

export const defaultSystemHooks: SystemHooks = {
  getuid: () => (typeof process.getuid === 'function' ? process.getuid() : null),
  readFile: (file) => {
    try {
      return fs.readFileSync(file, 'utf8')
    } catch {
      return null
    }
  },
  shellHomeOf: (user) => {
    if (!SAFE_USER_NAME.test(user)) return null
    try {
      // Why: macOS keeps users in Directory Services, not /etc/passwd. The name is validated
      // above, so the tilde expansion cannot inject anything.
      const out = execFileSync('/bin/sh', ['-c', `echo ~${user}`], {
        encoding: 'utf8',
        timeout: 5_000
      }).trim()
      return out.startsWith('/') ? out : null
    } catch {
      return null
    }
  },
  chown: (file, uid, gid) => fs.lchownSync(file, uid, gid)
}

/** Home directory of `user` from passwd(5) text. */
export function homeFromPasswd(passwd: string, user: string): string | null {
  for (const line of passwd.split('\n')) {
    const fields = line.split(':')
    if (fields.length >= 7 && fields[0] === user && fields[5]?.startsWith('/')) return fields[5]
  }
  return null
}

const parseId = (value: string | undefined): number | null =>
  value && /^\d+$/.test(value) ? Number(value) : null

/**
 * The user behind `sudo` when running as root on POSIX: SUDO_USER/SUDO_UID/SUDO_GID plus their
 * home from /etc/passwd (or `~user`). Null when not under sudo or the user cannot be resolved.
 */
export function resolveInvokingUser(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  system: SystemHooks
): InvokingUser | null {
  if (platform === 'win32' || system.getuid() !== 0) return null
  const name = env.SUDO_USER
  const uid = parseId(env.SUDO_UID)
  const gid = parseId(env.SUDO_GID)
  if (!name || name === 'root' || uid === null || gid === null || uid === 0) return null
  if (!SAFE_USER_NAME.test(name)) return null
  const passwd = system.readFile('/etc/passwd')
  const home = (passwd && homeFromPasswd(passwd, name)) || system.shellHomeOf(name)
  return home ? { name, uid, gid, home } : null
}

export function createContext(options: CommonOptions = {}): Context {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const system: SystemHooks = { ...defaultSystemHooks, ...options.system }
  const invokingUser = resolveInvokingUser(platform, env, system)
  // Why: under sudo os.homedir() is root's; state and the plugin folder belong to the user.
  const homeDir = options.homeDir ?? invokingUser?.home ?? os.homedir()
  const stateDir = options.stateDir ?? patcherHome(env, homeDir)
  return {
    platform,
    env,
    homeDir,
    stateDir,
    logger: options.logger ?? consoleLogger,
    runCommand: options.runCommand ?? defaultRunCommand,
    invokingUser,
    system
  }
}

/**
 * Under sudo, hand the stateDir and `target` inside it (recursively) back to the invoking user, so
 * they can later run the patcher, update or delete the plugin folder without root. Only touches
 * paths inside that user's home. Best effort: failures are logged, never thrown.
 */
export function chownToInvokingUser(ctx: Context, target: string): void {
  const user = ctx.invokingUser
  if (!user) return
  const inHome = (file: string): boolean =>
    path.resolve(file).startsWith(path.resolve(user.home) + path.sep)
  const chown = (file: string): boolean => {
    try {
      ctx.system.chown(file, user.uid, user.gid)
      return true
    } catch (error) {
      ctx.logger.warn(`could not hand ${file} back to ${user.name}: ${String(error)}`)
      return false
    }
  }
  const visit = (file: string): void => {
    if (!chown(file)) return
    let entries: fs.Dirent[] = []
    try {
      if (fs.lstatSync(file).isDirectory()) entries = fs.readdirSync(file, { withFileTypes: true })
    } catch {
      entries = []
    }
    for (const entry of entries) visit(path.join(file, entry.name))
  }
  if (!inHome(ctx.stateDir) || !inHome(target)) return
  if (fs.existsSync(ctx.stateDir)) chown(ctx.stateDir)
  // Intermediate directories (e.g. <stateDir>/plugin) created on the way to `target`.
  for (let dir = path.dirname(target); inHome(dir) && dir.startsWith(ctx.stateDir + path.sep);) {
    if (fs.existsSync(dir)) chown(dir)
    dir = path.dirname(dir)
  }
  if (fs.existsSync(target) && path.resolve(target) !== path.resolve(ctx.stateDir)) visit(target)
}
