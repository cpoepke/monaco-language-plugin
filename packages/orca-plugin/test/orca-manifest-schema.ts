/**
 * Faithful copy of Orca's plugin manifest v1 schema, for validating our
 * orca-plugin.json in tests. Sources (stablyai/orca main, Orca 1.4.214, zod ~4.6.5):
 * - src/shared/plugins/plugin-manifest.ts
 * - src/shared/plugins/plugin-manifest-fields.ts, plugin-id-format.ts, plugin-path-safety.ts
 * - src/shared/plugins/plugin-capabilities.ts
 * - src/shared/plugins/plugin-manifest-contribution-validation.ts
 *
 * Deliberate subset: the content-pack contributions (languagePacks,
 * keybindings, vmRecipes, agents) are accepted only as empty arrays, and
 * command `action` aliases are rejected outright, because this plugin uses
 * none of them and their schemas pull in large parts of Orca.
 */
import { z } from 'zod'

const PLUGIN_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const DANGEROUS_PLUGIN_NAMES = new Set(['__proto__', 'prototype', 'constructor'])
const PLUGIN_ID_MAX_LENGTH = 64

function isSafePluginId(id: string): boolean {
  return (
    typeof id === 'string' &&
    id.length <= PLUGIN_ID_MAX_LENGTH &&
    PLUGIN_ID_RE.test(id) &&
    !DANGEROUS_PLUGIN_NAMES.has(id)
  )
}

const WINDOWS_DEVICE_NAME_RE =
  /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/i
const WINDOWS_FORBIDDEN_CHAR_RE = /[<>:"|?*]/

function pluginPathSegmentError(segment: string): string | null {
  if (segment.length === 0 || segment === '.' || segment === '..') {
    return 'empty and dot path segments are not allowed'
  }
  if (segment.endsWith('.') || segment.endsWith(' ')) {
    return 'path segments may not end with a dot or space'
  }
  if (
    WINDOWS_FORBIDDEN_CHAR_RE.test(segment) ||
    [...segment].some((character) => character.charCodeAt(0) <= 31)
  ) {
    return 'path segment contains a Windows-forbidden character or alternate-data-stream colon'
  }
  if (WINDOWS_DEVICE_NAME_RE.test(segment)) {
    return 'path segment is a Windows reserved device name'
  }
  return null
}

function isSafePluginRelativePath(value: string): boolean {
  if (value.length === 0 || value.startsWith('/') || value.startsWith('\\')) {
    return false
  }
  return value.split(/[\\/]/).every((segment) => pluginPathSegmentError(segment) === null)
}

const pluginIdSchema = z
  .string()
  .refine(isSafePluginId, 'must be kebab-case (a-z, 0-9, dashes) and not a reserved name')

const pluginRelativePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(isSafePluginRelativePath, 'must be a portable relative path inside the plugin directory')

const pluginCommandIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/, 'must be a portable command id')

export const PLUGIN_CAPABILITY_KINDS = [
  'workspace:read',
  'terminal:send',
  'notifications:show',
  'storage',
  'secrets',
  'events:subscribe',
  'settings:own'
] as const

const pluginCapabilitySchema = z.object({ kind: z.enum(PLUGIN_CAPABILITY_KINDS) }).strict()

const SEMVER_RE =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

const orcaEngineRangeSchema = z
  .string()
  .max(64)
  .regex(/^>=\d+\.\d+\.\d+$/, 'must be a ">=x.y.z" version range')

const panelContributionSchema = z.object({
  id: pluginIdSchema,
  title: z.string().min(1).max(256),
  icon: z.string().min(1).max(64).optional(),
  entry: pluginRelativePathSchema
})

const commandContributionSchema = z.object({
  id: pluginCommandIdSchema,
  title: z.string().min(1).max(256),
  context: z.enum(['global', 'worktree']).optional(),
  action: pluginCommandIdSchema.optional()
})

const PLUGIN_EVENT_NAMES = ['worktree.created', 'worktree.removed', 'agent.status.changed'] as const
const eventContributionSchema = z.object({ on: z.enum(PLUGIN_EVENT_NAMES) })
const emptyOnly = z.array(z.never()).max(0).default([])

export const pluginManifestSchema = z
  .object({
    manifestVersion: z.literal(1),
    id: pluginIdSchema,
    publisher: pluginIdSchema,
    name: z.string().min(1).max(256),
    version: z.string().regex(SEMVER_RE, 'must be semver'),
    description: z.string().max(4096).optional(),
    author: z
      .object({ name: z.string().min(1).max(256), url: z.string().max(2048).optional() })
      .optional(),
    repository: z.string().max(2048).optional(),
    icon: pluginRelativePathSchema.optional(),
    engines: z.object({ orca: orcaEngineRangeSchema }),
    pluginApi: z.literal(1),
    main: pluginRelativePathSchema.optional(),
    contributes: z
      .object({
        panels: z.array(panelContributionSchema).max(64).default([]),
        commands: z.array(commandContributionSchema).max(256).default([]),
        events: z.array(eventContributionSchema).max(PLUGIN_EVENT_NAMES.length).default([]),
        languagePacks: emptyOnly,
        keybindings: emptyOnly,
        vmRecipes: emptyOnly,
        agents: emptyOnly
      })
      .strict()
      .default(() => ({
        panels: [],
        commands: [],
        events: [],
        languagePacks: [],
        keybindings: [],
        vmRecipes: [],
        agents: []
      })),
    capabilities: z.array(pluginCapabilitySchema).max(32).default([])
  })
  .superRefine((manifest, ctx) => {
    for (const key of ['panels', 'commands'] as const) {
      const seen = new Set<string>()
      manifest.contributes[key].forEach((entry, index) => {
        if (seen.has(entry.id)) {
          ctx.addIssue({
            code: 'custom',
            path: ['contributes', key, index],
            message: `duplicate ${key} id: ${entry.id}`
          })
        }
        seen.add(entry.id)
      })
    }
    manifest.contributes.commands.forEach((command, index) => {
      if (command.action !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['contributes', 'commands', index, 'action'],
          message: 'action aliases are not modelled in this test copy'
        })
      }
    })
    if (
      !manifest.main &&
      manifest.contributes.commands.some((command) => command.action === undefined)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['main'],
        message: 'required when contributes.commands contains a worker command'
      })
    }
    if (!manifest.main && manifest.contributes.events.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['main'],
        message: 'required when contributes.events is non-empty'
      })
    }
    if (
      manifest.contributes.events.length > 0 &&
      !manifest.capabilities.some((capability) => capability.kind === 'events:subscribe')
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['capabilities'],
        message: 'events:subscribe capability required when contributes.events is non-empty'
      })
    }
  })

/** Orca's `satisfiesOrcaEngineRange` (">=x.y.z" only). */
export function satisfiesOrcaEngineRange(hostVersion: string, range: string): boolean {
  const parse = (value: string): number[] =>
    value
      .split(/[-+]/)[0]!
      .split('.')
      .map((part) => Number.parseInt(part, 10) || 0)
  const host = parse(hostVersion)
  const min = parse(range.slice(2))
  for (let i = 0; i < 3; i++) {
    const a = host[i] ?? 0
    const b = min[i] ?? 0
    if (a !== b) {
      return a > b
    }
  }
  return true
}
