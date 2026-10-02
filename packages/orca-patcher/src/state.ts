import path from 'node:path'
import type { Context } from './context.js'
import { readJson, writeJsonAtomic } from './fsutil.js'

export type PatchRecord = {
  orcaVersion: string | null
  injectorVersion: string
  patcherVersion: string
  patchedAt: string
}

export type PatcherState = {
  /** Keyed by absolute app.asar path. */
  installs: Record<string, PatchRecord>
}

export const statePath = (ctx: Context): string => path.join(ctx.stateDir, 'state.json')

export function readState(ctx: Context): PatcherState {
  const state = readJson<PatcherState>(statePath(ctx))
  return state && typeof state.installs === 'object' && state.installs ? state : { installs: {} }
}

export function recordPatch(ctx: Context, asarPath: string, record: PatchRecord): void {
  const state = readState(ctx)
  state.installs[asarPath] = record
  writeJsonAtomic(statePath(ctx), state)
}

export function forgetPatch(ctx: Context, asarPath: string): void {
  const state = readState(ctx)
  if (!(asarPath in state.installs)) return
  delete state.installs[asarPath]
  writeJsonAtomic(statePath(ctx), state)
}
