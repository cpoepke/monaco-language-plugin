import type { Context } from './context.js'
import type { OrcaTarget } from './locate.js'

/**
 * Best-effort: processes that look like this Orca install. Returns null when the process list could
 * not be read. Matching by install path (not by name) avoids false positives such as GNOME's `orca`
 * screen reader.
 */
export async function findRunningOrca(ctx: Context, target: OrcaTarget): Promise<string[] | null> {
  if (ctx.platform === 'win32') {
    const res = await ctx.runCommand('tasklist', ['/FO', 'CSV', '/NH'])
    if (res.code !== 0) return null
    return res.stdout
      .split(/\r?\n/)
      .filter((line) => /^"orca\.exe"/i.test(line.trim()))
      .map((line) => line.trim())
  }
  const res = await ctx.runCommand('ps', ['-A', '-o', 'pid=,args='])
  if (res.code !== 0) return null
  const root = target.appRoot.endsWith('/') ? target.appRoot : `${target.appRoot}/`
  return res.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => {
      const pid = Number(line.split(/\s+/, 1)[0])
      return pid !== process.pid && line.includes(root)
    })
}
