/**
 * Pure part of the self-repair: what to do for the facts gathered about Orca's app.asar, and what
 * to tell the user about the outcome. The effects live in self-repair.ts.
 */
import { compareVersions } from '@mlp/orca-patch-core'

export type RepairFacts = {
  /** `mlp.repairPatch` (ignores autoRepair, always reports). */
  forced: boolean
  autoRepair: boolean
  /** Result of locating the running Orca and its package-name guard. */
  install: 'found' | 'not-found' | 'not-orca'
  /** Version of the injector shipped in the plugin folder; null when it is missing. */
  bundledInjectorVersion: string | null
  inspection: {
    orcaVersion: string | null
    injectedBlocks: number
    injectorVersion: string | null
  } | null
  /** Monaco anchor present in the renderer chunks; null when not checked (already patched). */
  anchorPresent: boolean | null
  /** A patched archive for the current app.asar waits for Orca to quit. */
  pendingWaiting: boolean
}

export type SkipState = 'disabled' | 'not-found' | 'not-orca' | 'no-injector' | 'pending'

export type RepairDecision =
  | { kind: 'skip'; state: SkipState }
  | { kind: 'up-to-date' }
  | { kind: 'unsupported' }
  /** unpatched: fresh Orca update; upgrade: older injector; reinject: broken/duplicated block. */
  | { kind: 'patch'; reason: 'unpatched' | 'upgrade' | 'reinject' }

export function decideRepair(facts: RepairFacts): RepairDecision {
  if (!facts.forced && !facts.autoRepair) return { kind: 'skip', state: 'disabled' }
  if (facts.install !== 'found' || !facts.inspection) {
    return { kind: 'skip', state: facts.install === 'not-orca' ? 'not-orca' : 'not-found' }
  }
  if (!facts.bundledInjectorVersion) return { kind: 'skip', state: 'no-injector' }
  const { injectedBlocks, injectorVersion } = facts.inspection
  if (injectedBlocks === 1) {
    if (injectorVersion === facts.bundledInjectorVersion) return { kind: 'up-to-date' }
    // Why: never downgrade a newer injector the CLI installed.
    if (injectorVersion && compareVersions(injectorVersion, facts.bundledInjectorVersion) > 0) {
      return { kind: 'up-to-date' }
    }
    return { kind: 'patch', reason: 'upgrade' }
  }
  if (injectedBlocks > 1) return { kind: 'patch', reason: 'reinject' }
  if (facts.pendingWaiting) return { kind: 'skip', state: 'pending' }
  if (facts.anchorPresent === false) return { kind: 'unsupported' }
  return { kind: 'patch', reason: 'unpatched' }
}

export type RepairOutcome =
  | { kind: 'skipped'; state: SkipState; detail?: string }
  | { kind: 'up-to-date'; orcaVersion: string | null; injectorVersion: string | null }
  | { kind: 'unsupported'; orcaVersion: string | null }
  | {
      kind: 'patched'
      reason: 'unpatched' | 'upgrade' | 'reinject'
      orcaVersion: string | null
      injectorVersion: string
      /** macOS: true re-signed, false skipped (resign:false), null not macOS. */
      resigned: boolean | null
      signError?: string
    }
  | { kind: 'pending'; orcaVersion: string | null; injectorVersion: string }
  | {
      kind: 'needs-elevation'
      orcaVersion: string | null
      platform: NodeJS.Platform
      appRoot: string
      dir: string
      appImage: boolean
    }
  | { kind: 'busy'; owner: string | null }
  | { kind: 'failed'; orcaVersion: string | null; error: string }

export type RepairState =
  | 'patched'
  | 'pending'
  | 'unpatched'
  | 'unsupported'
  | 'disabled'
  | 'not-found'
  | 'not-orca'
  | 'no-injector'
  | 'busy'
  | 'error'

export type RepairAction =
  'none' | 'patched' | 'upgraded' | 'scheduled' | 'needs-elevation' | 'failed'

export type RepairReport = {
  state: RepairState
  action: RepairAction
  message: string
  /** Show a desktop notification (automatic checks only notify when something happened). */
  notify: boolean
  /**
   * Automatic checks notify about lasting problems once per Orca version; this is the key to
   * remember (null: always notify).
   */
  dedupeKey: string | null
}

const v = (version: string | null): string => (version ? `v${version}` : 'unknown version')

/** The exact command for a user to patch an install the plugin cannot write to. */
export function elevatedInstallCommand(platform: NodeJS.Platform, appRoot: string): string {
  return platform === 'win32'
    ? `monaco-lsp-orca install --app "${appRoot}"`
    : `sudo monaco-lsp-orca install --app "${appRoot}"`
}

export function describeOutcome(outcome: RepairOutcome, forced: boolean): RepairReport {
  switch (outcome.kind) {
    case 'up-to-date':
      return {
        state: 'patched',
        action: 'none',
        message: `Code navigation is enabled (Orca ${v(outcome.orcaVersion)}, injector ${v(outcome.injectorVersion)}); nothing to repair.`,
        notify: forced,
        dedupeKey: null
      }
    case 'patched': {
      const restart = 'Restart Orca to activate it.'
      let message =
        outcome.reason === 'unpatched'
          ? `Code navigation was re-enabled after the Orca update (${v(outcome.orcaVersion)}). ${restart}`
          : outcome.reason === 'upgrade'
            ? `Code navigation was updated to injector ${v(outcome.injectorVersion)} (Orca ${v(outcome.orcaVersion)}). ${restart}`
            : `Code navigation's patch was repaired (Orca ${v(outcome.orcaVersion)}). ${restart}`
      if (outcome.signError) {
        message +=
          ` Re-signing Orca.app failed (${outcome.signError}); if Orca does not start, run ` +
          '`monaco-lsp-orca install` or reinstall Orca.'
      }
      return {
        state: 'patched',
        action: outcome.reason === 'upgrade' ? 'upgraded' : 'patched',
        message,
        notify: true,
        dedupeKey: null
      }
    }
    case 'pending':
      return {
        state: 'pending',
        action: 'scheduled',
        message:
          `Code navigation will be re-enabled after you quit Orca (${v(outcome.orcaVersion)}): ` +
          'Windows keeps Orca’s files locked while it runs. Quit Orca and start it again to activate it.',
        notify: true,
        dedupeKey: null
      }
    case 'unsupported':
      return {
        state: 'unsupported',
        action: 'none',
        message: `This Orca version (${outcome.orcaVersion ?? 'unknown'}) isn't supported by Code Navigation yet.`,
        notify: true,
        dedupeKey: `unsupported:${outcome.orcaVersion ?? '?'}`
      }
    case 'needs-elevation': {
      const message = outcome.appImage
        ? `Orca runs from a read-only AppImage, so code navigation can't be re-enabled automatically ` +
          `after the update (${v(outcome.orcaVersion)}). Extract the AppImage ` +
          '(`./Orca.AppImage --appimage-extract`), run `monaco-lsp-orca install --app <path to ' +
          'squashfs-root>` and start Orca with its `AppRun`.'
        : `The Orca update (${v(outcome.orcaVersion)}) removed code navigation, and ${outcome.dir} ` +
          `is not writable for this plugin. To re-enable it, quit Orca and run${
            outcome.platform === 'win32' ? ' from an administrator terminal' : ''
          }: ${elevatedInstallCommand(outcome.platform, outcome.appRoot)}`
      return {
        state: 'unpatched',
        action: 'needs-elevation',
        message,
        notify: true,
        dedupeKey: `needs-elevation:${outcome.orcaVersion ?? '?'}`
      }
    }
    case 'busy':
      return {
        state: 'busy',
        action: 'none',
        message: `Another process (${outcome.owner ?? 'monaco-lsp-orca'}) is patching Orca right now; try again in a minute.`,
        notify: forced,
        dedupeKey: null
      }
    case 'failed':
      return {
        state: 'error',
        action: 'failed',
        message:
          `Code navigation could not be re-enabled automatically (${outcome.error}). ` +
          'Quit Orca and run `monaco-lsp-orca install`.',
        notify: true,
        dedupeKey: `failed:${outcome.orcaVersion ?? '?'}`
      }
    case 'skipped':
      return describeSkip(outcome.state, outcome.detail, forced)
  }
}

function describeSkip(state: SkipState, detail: string | undefined, forced: boolean): RepairReport {
  const base = { action: 'none' as const, notify: forced, dedupeKey: null }
  switch (state) {
    case 'disabled':
      return {
        ...base,
        state: 'disabled',
        message:
          'Automatic repair is turned off (~/.monaco-lsp-orca/config.json, `autoRepair: false`).'
      }
    case 'not-found':
      return {
        ...base,
        state: 'not-found',
        message: `Could not find the Orca installation running this plugin${detail ? ` (${detail})` : ''}.`
      }
    case 'not-orca':
      return {
        ...base,
        state: 'not-orca',
        message: `The app running this plugin is not an Orca release${detail ? ` (${detail})` : ''}; nothing to repair.`
      }
    case 'no-injector':
      return {
        ...base,
        state: 'no-injector',
        message:
          'The plugin folder has no assets/injector.js, so the patch cannot be repaired from here. ' +
          'Reinstall the plugin or run `monaco-lsp-orca install`.'
      }
    case 'pending':
      return {
        ...base,
        state: 'pending',
        message:
          'Code navigation will be re-enabled after you quit Orca. Quit Orca and start it again to activate it.'
      }
  }
}
